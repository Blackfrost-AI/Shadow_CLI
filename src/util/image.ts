/** Shared image helpers used by the `/image` attach flow (TUI) and the `view_image` tool. */
import { assertUrlAllowed } from '../safety/netguard.js';
import { shadowFetch } from '../safety/egress.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Map a file extension to an image MIME type, or null if it isn't a supported image. */
export function imageMediaType(path: string): string | null {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** Fetch an opt-in remote image with DNS pinning, redirect re-validation and a hard byte cap. */
export async function fetchRemoteImage(raw: string, maxBytes = MAX_IMAGE_BYTES): Promise<{ bytes: Buffer; mediaType: string }> {
  let current = raw;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const allowed = await assertUrlAllowed(current);
    // Egress broker (P2-01): pinned to the validated IP set + recorded in the egress receipt.
    const response = await shadowFetch(
      allowed.url.href,
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      },
      { purpose: 'image', pinnedIps: allowed.ips },
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 4) throw new Error('remote image redirected too many times');
      current = new URL(location, allowed.url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`remote image returned HTTP ${response.status}`);
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mediaType)) throw new Error('remote URL is not a supported image');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('remote image exceeds 20 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('remote image response had no body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('remote image exceeds 20 MiB');
      }
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total), mediaType };
  }
  throw new Error('remote image redirected too many times');
}
