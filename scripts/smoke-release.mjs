// Exercise signed release artifacts on their native OS. Run only on disposable CI runners.
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.env.CI, 'true', 'Use disposable CI runners: Windows installers update the runner user PATH.');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const origin = 'https://storage.googleapis.com/blackfrost-ai-prod-shadow-releases';
const base = `${origin}/releases/${version}`;
const updateBase = `${origin}/bin`;
const legacyBase = 'https://shadow.redpillreader.com/bin';
const platform = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
assert.ok(platform);
const asset = `shadow-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const key = readFileSync('src/update/binary.ts', 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)[0];
const dir = mkdtempSync(join(tmpdir(), 'shadow-release-'));
const installDir = join(dir, 'install with spaces');
const childHome = join(dir, 'profile');
for (const path of [childHome, installDir, join(childHome, 'AppData', 'Local')]) mkdirSync(path, { recursive: true });
const env = { ...process.env, HOME: childHome, USERPROFILE: childHome, LOCALAPPDATA: join(childHome, 'AppData', 'Local'), SHADOW_INSTALL_DIR: installDir, SHADOW_INSTALL_BASE: base };
delete env.SHADOW_INSECURE_SKIP_VERIFY;
const target = join(installDir, process.platform === 'win32' ? 'shadow.exe' : 'shadow');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const installedHash = () => hash(readFileSync(target));

async function get(url) {
  const response = await globalThis.fetch(url, { redirect: 'error', signal: globalThis.AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200, url);
  return Buffer.from(await response.arrayBuffer());
}
async function metadata(releaseBase) {
  const [manifest, signature] = await Promise.all([get(`${releaseBase}/SHASUMS256.txt`), get(`${releaseBase}/SHASUMS256.txt.sig`)]);
  assert.ok(verify('sha256', manifest, key, signature), 'Pinned release signature must verify');
  const checksum = manifest.toString().split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === asset)?.[0];
  assert.match(checksum ?? '', /^[a-f0-9]{64}$/);
  return { manifest, signature, checksum };
}
async function run(command, args, commandEnv = env, failure = false) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: commandEnv, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || (failure ? code === 0 : code !== 0)) reject(new Error(`${command} ${args.join(' ')} exited ${code}${timedOut ? ' (timeout)' : ''}\n${output}`));
      else resolveRun(output);
    });
  });
}

let fixtureServer;
try {
  const release = await metadata(base);
  const binary = await get(`${base}/${asset}`);
  assert.equal(hash(binary), release.checksum);
  let installerCommand = 'sh';
  let installerArgs = [resolve('install.sh')];
  if (process.platform === 'win32') {
    const shell = process.env.SMOKE_POWERSHELL;
    assert.ok(['powershell.exe', 'pwsh.exe'].includes(shell));
    installerCommand = (await run('where.exe', [shell])).trim().split(/\r?\n/)[0];
    installerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('install.ps1')];
    if (shell === 'powershell.exe') {
      // Keep stock PowerShell 5.1 and deliberately remove optional PowerShell 7 from PATH.
      env.Path = (env.Path ?? env.PATH ?? '').split(';').filter((entry) => !/\\PowerShell\\7(?:\\|$)/i.test(entry)).join(';');
      delete env.PATH;
      const probe = await run(installerCommand, ['-NoProfile', '-Command', 'if (Get-Command pwsh -ErrorAction SilentlyContinue) { exit 1 }; $PSVersionTable.PSVersion.ToString()']);
      assert.match(probe, /^5\.1\./);
    } else {
      assert.match(await run(installerCommand, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']), /^7\./);
    }
  }
  const install = async (releaseBase = base, failure = false) => await run(installerCommand, installerArgs, { ...env, SHADOW_INSTALL_BASE: releaseBase }, failure);
  await install();
  assert.equal(installedHash(), release.checksum, 'Installer must preserve signed bytes');
  assert.equal((await run(target, ['--version'])).trim(), `shadow ${version}`);
  await run(target, ['--help']);
  await run(target, ['--provider', 'mock', '--model', 'mock-1', '--base-url', 'http://127.0.0.1:1/v1', '--task', 'Hello', '--offline']);
  await install();
  assert.equal(installedHash(), release.checksum, 'Repeat install must remain valid');
  console.log(`${asset}: verified clean install, launch, mock task, and repeat install`);

  const offlineOutput = await run(target, ['update', '--offline'], env, true);
  assert.match(offlineOutput, /offline mode/);
  assert.equal(installedHash(), release.checksum, 'Offline update must not replace the binary');

  const updateEnv = { ...env };
  if (process.platform === 'win32') {
    // Standalone self-update must not depend on finding either PowerShell executable.
    updateEnv.Path = (env.Path ?? env.PATH ?? '').split(';').filter((entry) => !/powershell/i.test(entry)).join(';');
    delete updateEnv.PATH;
  }
  const published = await metadata(updateBase);
  const updateOutput = await run(target, ['update'], updateEnv);
  assert.ok(updateOutput.includes(updateBase), updateOutput);
  assert.equal(installedHash(), published.checksum, 'Self-update must install authenticated Blackfrost bytes');
  console.log(`${asset}: standalone update succeeded without PowerShell on PATH; ${(await run(target, ['--version'])).trim()}`);
  await install();

  let mode = 'signature';
  fixtureServer = createServer((request, response) => {
    const name = request.url?.slice(1);
    let bytes = name === asset ? binary : name === 'SHASUMS256.txt' ? release.manifest : name === 'SHASUMS256.txt.sig' ? release.signature : undefined;
    if (!bytes || (mode === 'missing' && name === 'SHASUMS256.txt.sig')) { response.writeHead(404); response.end(); return; }
    if ((mode === 'signature' && name === 'SHASUMS256.txt.sig') || (mode === 'checksum' && name === asset)) {
      bytes = Buffer.from(bytes); bytes[0] ^= 1;
    }
    response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' });
    response.end(bytes);
  });
  await new Promise((ready) => fixtureServer.listen(0, '127.0.0.1', ready));
  const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
  for (mode of ['signature', 'checksum', 'missing']) {
    const output = await install(fixtureBase, true);
    assert.match(output, /signature|checksum|unsigned/i);
    assert.equal(installedHash(), release.checksum, `${mode}: failed verification must preserve installed binary`);
  }
  console.log(`${asset}: bad signature, bad checksum, and missing signature all rejected`);

  if (process.env.SHADOW_LEGACY_SMOKE === 'true') {
    const oldBase = `${origin}/releases/8.7.0`;
    const oldRelease = await metadata(oldBase);
    const oldBinary = await get(`${oldBase}/${asset}`);
    assert.equal(hash(oldBinary), oldRelease.checksum);
    writeFileSync(target, oldBinary); chmodSync(target, 0o755);
    assert.equal((await run(target, ['--version'])).trim(), 'shadow 8.7.0');
    const bridgeOutput = await run(target, ['update'], updateEnv);
    assert.ok(bridgeOutput.includes(legacyBase), bridgeOutput);
    assert.equal(installedHash(), release.checksum);
    assert.equal((await run(target, ['--version'])).trim(), `shadow ${version}`);
    const nextOutput = await run(target, ['update'], updateEnv);
    assert.ok(nextOutput.includes(updateBase), nextOutput);
    assert.equal(installedHash(), release.checksum);
    console.log(`${asset}: 8.7.0 -> legacy bridge -> ${version} -> Blackfrost update verified`);
  }
} finally {
  if (fixtureServer) await new Promise((closed) => fixtureServer.close(closed));
  rmSync(dir, { recursive: true, force: true });
}
