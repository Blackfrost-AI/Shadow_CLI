import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function validateVersion(version) {
  if (typeof version !== 'string' || !semver.test(version)) {
    throw new Error(`Invalid package version: ${JSON.stringify(version)}`);
  }
  return version;
}

export function readmeVersion(readme) {
  const line = readme.split(/\r?\n/).find((row) => row.includes('Current build:')) ?? '';
  return /\bv([0-9][0-9A-Za-z.+-]*)/.exec(line)?.[1];
}

export function checkReadmeVersion(version, readme) {
  validateVersion(version);
  const documented = readmeVersion(readme);
  if (documented !== version) {
    throw new Error(
      `README 'Current build' does not match package.json: ${documented ?? '<missing>'} != ${version}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = validateVersion(JSON.parse(readFileSync('package.json', 'utf8')).version);
    let readme = readFileSync('README.md', 'utf8');
    if (process.argv[2] === '--sync') {
      readme = readme.replace(
        /^(.*Current build:.*?\bv)[0-9][0-9A-Za-z.+-]*/m,
        (_match, prefix) => prefix + version,
      );
      checkReadmeVersion(version, readme);
      writeFileSync('README.md', readme);
    } else {
      checkReadmeVersion(version, readme);
    }
    console.log(`release-gate OK: README 'Current build' matches package.json (v${version}).`);
  } catch (error) {
    console.error(`RELEASE BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
