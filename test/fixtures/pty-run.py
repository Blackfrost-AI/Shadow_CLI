#!/usr/bin/env python3
"""Drive a command under a real pty and dump everything it writes.

Why this exists: the tab-title indicator only runs when `stdout.isTTY`, so proving it works
requires an actual terminal. Node core has no pty (that would be a native dependency), and
`script(1)` refuses a piped stdin ("tcgetattr/ioctl: Operation not supported on socket"), so this
allocates the pty the portable way — `pty.fork()` — types a prompt after a delay, optionally sends
EOF, and writes the raw byte stream to the output file.

Usage: pty-run.py <outfile> <type-delay-sec> <total-timeout-sec> <prompt> -- <cmd> [args...]

Exit code is 0 whenever the run completed and the output was written, regardless of what the child
did; the test asserts on the captured bytes, not on this process's status.
"""
import os
import pty
import re
import select
import sys
import time


def _finish(fd, pid, outfile, buf):
    """Write captured bytes, reap the child, and return the runner's exit code."""
    with open(outfile, 'wb') as fh:
        fh.write(bytes(buf))
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    return 0


def main() -> int:
    outfile = sys.argv[1]
    type_delay = float(sys.argv[2])
    total_timeout = float(sys.argv[3])
    prompt = sys.argv[4]
    if sys.argv[5] != '--':
        print(f'expected -- separator, got {sys.argv[5]!r}', file=sys.stderr)
        return 2
    cmd = sys.argv[6:]

    pid, fd = pty.fork()
    if pid == 0:
        # Child: exec the command with the pty as its stdio.
        try:
            os.execvp(cmd[0], cmd)
        except Exception as exc:  # pragma: no cover - exec failure is fatal
            print(f'exec failed: {exc}', file=sys.stderr)
            os._exit(127)

    start = time.time()
    typed = False
    sent_eof = False
    buf = bytearray()

    # Stop as soon as the interesting transition has been observed: a working frame followed by a
    # bare (idle) title. Without this the run always costs the full timeout, which is 30s of dead
    # time per test for a turn that completes in under a second.
    seen_busy = False
    idle_since = None
    title_re = re.compile(rb'\x1b\][02];([^\x07]*)\x07')
    BUSY_GLYPHS = '\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f\u25cf'

    while True:
        elapsed = time.time() - start
        if elapsed > total_timeout:
            break

        # Type the prompt once the TUI has had a moment to paint, then EOF near the end.
        if not typed and elapsed >= type_delay:
            try:
                os.write(fd, (prompt + '\r').encode())
            except OSError:
                pass
            typed = True

        if typed and not sent_eof and elapsed >= max(type_delay + 1.0, total_timeout - 4.0):
            try:
                os.write(fd, b'\x04')
            except OSError:
                pass
            sent_eof = True

        try:
            ready, _, _ = select.select([fd], [], [], 0.1)
        except (OSError, ValueError):
            break
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
            # Re-evaluate on each chunk so a fast turn exits promptly. A bare title only counts as
            # settled once it has persisted briefly: the idle write can arrive in the same chunk as
            # the last busy frame, and exiting on the first bare title raced the assertion.

        # Settle check runs every iteration, NOT only when bytes arrive. Once the turn finishes the
        # TUI goes quiet, so a check nested under `if ready:` would never fire and every run would
        # cost the full timeout.
        found = title_re.findall(bytes(buf))
        if found:
            last = found[-1].decode('utf-8', 'replace')
            if last[:1] in BUSY_GLYPHS:
                seen_busy = True
                idle_since = None
            elif seen_busy:
                if idle_since is None:
                    idle_since = time.time()
                elif time.time() - idle_since >= 0.4:
                    return _finish(fd, pid, outfile, buf)

    return _finish(fd, pid, outfile, buf)


if __name__ == '__main__':
    sys.exit(main())