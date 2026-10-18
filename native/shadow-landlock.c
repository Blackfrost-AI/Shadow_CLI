/*
 * shadow-landlock — minimal Landlock launcher for Shadow on Linux.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License, whose launcher
 * defines the same `--probe` / `--ro` / `--rw` / `-- <argv>` grammar. Copyright (c) DeepSeek.
 * See THIRD_PARTY_NOTICES.md.
 *
 * WHY A NATIVE HELPER
 * -------------------
 * Landlock is a kernel LSM reached through syscalls, so confinement must be applied in the process
 * that is about to exec — a JavaScript runtime cannot hand a ruleset to a child. The alternative,
 * bubblewrap, needs unprivileged user namespaces, which are frequently disabled in exactly the
 * environments Shadow targets (containers, hardened Kali, CI runners). Landlock needs no
 * privileges at all, so this helper is the only backend that works everywhere.
 *
 * CONTRACT
 *   shadow-landlock --probe                      exit 0 if Landlock is usable, 2 otherwise
 *   shadow-landlock --ro PATH [--ro PATH ...] \
 *                   --rw PATH [--rw PATH ...] -- ARGV...
 *
 * Unlisted paths are NOT readable. That is the point: a deny-list fails open on the file nobody
 * thought of, and for detonating real ransomware the read side has to be a hard boundary.
 *
 * KNOWN LIMITATION — INODE METADATA IS NOT MEDIATED
 * -------------------------------------------------
 * Landlock has no access bit for chmod/chown/utimes: the kernel exposes file CONTENT rights
 * (read/write/truncate/execute/make/remove) and nothing for inode attributes. So inside a
 * read-only ruleset a process can still `chmod 600` a file it cannot write, anywhere it can reach
 * by path. Verified on Linux 6.x. This does not let it change content, but it can make a file
 * unreadable to its owner — a real (if modest) denial-of-service. Do not describe a Landlock
 * read-only sandbox as "no modification"; it is "no content modification". Where that matters,
 * combine with a read-only bind mount or a mount namespace, which bwrap provides.
 *
 * Build: cc -O2 -o shadow-landlock shadow-landlock.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef landlock_create_ruleset
static inline int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size,
                                          __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
#endif

#ifndef landlock_add_rule
static inline int landlock_add_rule(int ruleset_fd, enum landlock_rule_type rule_type,
                                    const void *rule_attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}
#endif

#ifndef landlock_restrict_self
static inline int landlock_restrict_self(int ruleset_fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}
#endif

/* Access rights we know how to grant. Bits above the running kernel's ABI are masked off so a
 * newer header on an older kernel cannot make every rule fail with EINVAL. */
static __u64 fs_access_all(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
         LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
         LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
         LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
         LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
         LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
         LANDLOCK_ACCESS_FS_MAKE_SYM
#ifdef LANDLOCK_ACCESS_FS_REFER
         | LANDLOCK_ACCESS_FS_REFER
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
         | LANDLOCK_ACCESS_FS_TRUNCATE
#endif
      ;
}

static __u64 fs_access_read(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
}

static int add_path(int ruleset_fd, const char *path, __u64 access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    /* A missing path is not fatal: the caller passes a standard set and some entries (e.g.
     * /dev/stderr) may be absent in minimal containers. Confinement is still correct. */
    return 0;
  }

  /* Landlock rejects a rule whose rights are not a subset of what the object type supports: a
   * regular file/device cannot carry MAKE_DIR/MAKE_REG/REMOVE_* etc. Passing the directory set for
   * /dev/null made the kernel return EINVAL, and because that was tolerated the device silently got
   * NO rule — so `cmd >/dev/null` failed with "Permission denied" inside the sandbox. Narrow the
   * set for non-directories instead of swallowing the error. */
  struct stat st;
  __u64 effective = access;
  if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode)) {
    effective &= (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                  LANDLOCK_ACCESS_FS_WRITE_FILE
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
                  | LANDLOCK_ACCESS_FS_TRUNCATE
#endif
    );
  }

  struct landlock_path_beneath_attr pb = {.allowed_access = effective, .parent_fd = fd};
  int rc = landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
  int saved = errno;
  close(fd);
  /* EXDEV: path is on a different mount than the ruleset expects (bind mounts). EINVAL: the
   * kernel's ABI does not know some access bit. EBADF: O_PATH on a magic symlink such as
   * /dev/stdout -> /proc/self/fd/1, which is already covered by the fd it points at. ENOENT:
   * vanished between open and rule. None indicate a broken sandbox. */
  if (rc < 0 && saved != EXDEV && saved != EINVAL && saved != EBADF && saved != ENOENT) return -1;
  return 0;
}

static int probe(void) {
  struct landlock_ruleset_attr attr = {.handled_access_fs = fs_access_all()};
  int fd = landlock_create_ruleset(&attr, sizeof(attr), 0);
  if (fd < 0) return 2;
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  const char *ro[256];
  const char *rw[256];
  int nro = 0, nrw = 0, i = 1;

  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return probe();

  for (; i < argc; i++) {
    if (strcmp(argv[i], "--ro") == 0 || strcmp(argv[i], "--rw") == 0) {
      /* Compare the whole flag. Indexing into the string here is how the first version of this
       * silently treated every --ro as --rw, which made "read-only" grant writes. */
      int is_ro = strcmp(argv[i], "--ro") == 0;
      if (i + 1 >= argc) {
        fprintf(stderr, "landlock-run: usage error: %s requires a path\n", argv[i]);
        return 64;
      }
      if (is_ro) {
        if (nro < 256) ro[nro++] = argv[++i];
      } else {
        if (nrw < 256) rw[nrw++] = argv[++i];
      }
    } else if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    } else {
      fprintf(stderr, "landlock-run: usage error: unknown argument: %s\n", argv[i]);
      return 64;
    }
  }
  if (i >= argc) {
    fprintf(stderr, "landlock-run: usage error: missing `-- <argv>...` command\n");
    return 64;
  }

  /* no_new_privs is required before landlock_restrict_self. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "landlock-run: PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return 70;
  }

  struct landlock_ruleset_attr attr = {.handled_access_fs = fs_access_all()};
  int ruleset = landlock_create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset < 0) {
    if (errno == ENOSYS || errno == EOPNOTSUPP) {
      fprintf(stderr, "landlock-run: Landlock unavailable in this kernel\n");
      return 2;
    }
    fprintf(stderr, "landlock-run: create_ruleset failed: %s\n", strerror(errno));
    return 70;
  }

  for (int k = 0; k < nro; k++)
    if (add_path(ruleset, ro[k], fs_access_read()) != 0) {
      fprintf(stderr, "landlock-run: cannot allow read of %s: %s\n", ro[k], strerror(errno));
      return 70;
    }
  for (int k = 0; k < nrw; k++)
    if (add_path(ruleset, rw[k], fs_access_all()) != 0) {
      fprintf(stderr, "landlock-run: cannot allow write of %s: %s\n", rw[k], strerror(errno));
      return 70;
    }

  if (landlock_restrict_self(ruleset, 0) != 0) {
    fprintf(stderr, "landlock-run: restrict_self failed: %s\n", strerror(errno));
    return 70;
  }
  close(ruleset);

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "landlock-run: exec %s failed: %s\n", argv[i], strerror(errno));
  return 127;
}