import { createHash, randomBytes, verify } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_RELEASE_BASE = 'https://shadow.redpillreader.com/bin';
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Offline release-signing key. The manifest must verify before any hash is trusted. */
const SHADOW_RELEASE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+5WMu9iMUEp0j1eehkH/xGts2NHZ
zxxbBkvBdSkayLtegXgAQ8v8s5ulVnTFQxsX8IKnYfuStdHEn9JbQSkOMg==
-----END PUBLIC KEY-----`;

function releaseAsset(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!os || !arch || (os === 'windows' && arch !== 'x64')) {
    throw new Error(`no signed Shadow binary is published for ${process.platform}/${process.arch}`);
  }
  return `shadow-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}

function releaseBase(): string {
  // Self-update deliberately ignores installer environment overrides. The signature prevents
  // forged binaries, while a poisoned mirror could still replay an old signed release (rollback).
  const parsed = new URL(DEFAULT_RELEASE_BASE);
  return parsed.toString().replace(/\/+$/, '');
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`download exceeds ${maxBytes} byte limit: ${url}`);
  if (!response.body) throw new Error(`empty response body: ${url}`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`download exceeds ${maxBytes} byte limit: ${url}`);
    chunks.push(Buffer.from(chunk));
  }
  if (total === 0) throw new Error(`downloaded file is empty: ${url}`);
  return Buffer.concat(chunks, total);
}

function expectedHash(manifest: string, asset: string): string {
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === asset) return match[1]!.toLowerCase();
  }
  throw new Error(`signed manifest has no checksum for ${asset}`);
}

/** Download, authenticate, and atomically replace the running standalone binary. */
export async function updateInstalledBinary(target = process.execPath): Promise<{ asset: string; base: string }> {
  const base = releaseBase();
  const asset = releaseAsset();
  // Authenticate the small metadata before accepting a large response from the release host.
  // A compromised origin can still refuse service, but it cannot make `shadow update` buffer an
  // attacker-controlled 512 MiB candidate before we know the manifest is genuine.
  const [manifestBytes, signature] = await Promise.all([
    download(`${base}/SHASUMS256.txt`, MAX_METADATA_BYTES),
    download(`${base}/SHASUMS256.txt.sig`, MAX_METADATA_BYTES),
  ]);

  if (!verify('sha256', manifestBytes, SHADOW_RELEASE_PUBKEY, signature)) {
    throw new Error('release manifest signature verification failed; refusing the update');
  }
  const expected = expectedHash(manifestBytes.toString('utf8'), asset);
  const binary = await download(`${base}/${asset}`, MAX_BINARY_BYTES);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}; refusing the update`);
  }

  const targetDir = dirname(target);
  mkdirSync(targetDir, { recursive: true });
  const tmp = join(targetDir, `.shadow-update-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, binary, { flag: 'wx', mode: 0o755 });
  try {
    chmodSync(tmp, 0o755);
    if (process.platform === 'win32') {
      const old = `${target}.old`;
      try { unlinkSync(old); } catch { /* absent or still in use */ }
      let movedOld = false;
      try {
        renameSync(target, old);
        movedOld = true;
        renameSync(tmp, target);
      } catch (error) {
        if (movedOld) {
          try { renameSync(old, target); } catch { /* preserve original error */ }
        }
        throw error;
      }
      try { unlinkSync(old); } catch { /* running old image; next launch removes it */ }
    } else {
      renameSync(tmp, target);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return { asset, base };
}
