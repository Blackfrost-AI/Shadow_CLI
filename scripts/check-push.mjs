import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { validateVersion } from './release-version.mjs';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const config = (key) => {
  try {
    return git('config', '--get', key);
  } catch {
    return '';
  }
};
const repositoryFromUrl = (url) =>
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i
    .exec(url)?.[1]
    .toLowerCase();
const versionAt = (sha) => validateVersion(JSON.parse(git('show', `${sha}:package.json`)).version);
const zero = /^0+$/;

try {
  const updates = readFileSync(0, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/));
  const privateRepository = config('shadow.privateRepository');
  // The marker keeps a fresh clone private even before its local config is restored.
  const privateCheckout =
    privateRepository || existsSync('docs/internal/deployment_instructions.md');
  if (privateCheckout) {
    if (
      !privateRepository ||
      repositoryFromUrl(process.argv[3] ?? '') !== privateRepository.toLowerCase()
    ) {
      throw new Error(
        'Private working history may only be pushed to the configured shadow.privateRepository. See docs/internal/REPOSITORY_POLICY.md.',
      );
    }
    // Fail closed if auth/network fails or a deleted repository was recreated as public.
    const target = JSON.parse(
      execFileSync('gh', ['repo', 'view', privateRepository, '--json', 'nameWithOwner,isPrivate'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      }),
    );
    if (
      !target.isPrivate ||
      target.nameWithOwner.toLowerCase() !== privateRepository.toLowerCase()
    ) {
      throw new Error('Private backup destination is not verified private. No history was pushed.');
    }
  } else {
    for (const [, sha, remoteRef] of updates) {
      if (zero.test(sha)) continue;
      if (remoteRef === 'refs/heads/main') {
        const tag = `v${versionAt(sha)}`;
        let tagged;
        try {
          tagged = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
        } catch {
          /* handled below */
        }
        if (tagged !== git('rev-parse', `${sha}^{commit}`)) {
          throw new Error(
            `main must point at its package version tag (${tag}); an unrelated tag does not qualify.`,
          );
        }
      } else if (remoteRef.startsWith('refs/tags/')) {
        const expected = `refs/tags/v${versionAt(sha)}`;
        if (remoteRef !== expected)
          throw new Error(`Release tag ${remoteRef} must match ${expected} at the pushed commit.`);
      }
    }
  }
} catch (error) {
  console.error(`Push blocked: ${error.message}`);
  process.exitCode = 1;
}
