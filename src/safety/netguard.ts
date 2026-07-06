import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for the network tools. Blocks non-http(s) schemes, and any host that
 * resolves to a loopback / link-local / private / cloud-metadata address. Resolves
 * DNS first (defeats DNS-rebinding-by-name); callers must also set redirect:'manual'
 * and re-check every hop.
 */
export async function assertUrlAllowed(raw: string): Promise<{ url: URL; ips: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked URL scheme: ${url.protocol} (only http/https allowed)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  const ips = await resolveAll(host);
  if (ips.length === 0) throw new Error(`could not resolve host: ${host}`);
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new Error(`blocked address ${ip} for host ${host} (private/loopback/metadata)`);
    }
  }
  // Return the validated IPs so the caller can PIN the connection to them — otherwise
  // fetch() re-resolves the hostname and a DNS-rebind flips it to a blocked address.
  return { url, ips };
}

async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  if (host === 'localhost') return ['127.0.0.1'];
  try {
    const records = await lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/** True if an IP literal is loopback, link-local, private, unspecified, or metadata. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // not a parseable IP → refuse
}

function isBlockedV4(ip: string): boolean {
  const o = ip.split('.').map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Parse any IPv6 form (compressed, mixed-notation, hex IPv4-mapped) to 16 bytes, or null. */
export function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, ''); // drop zone id
  // Fold a trailing dotted-IPv4 (::ffff:127.0.0.1, ::1.2.3.4) into two hex groups so
  // hex (::ffff:7f00:1) and dotted forms parse identically.
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, v4.index) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups =
    tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isBlockedV6(ip: string): boolean {
  const b = parseV6(ip);
  if (!b) return true; // unparseable → refuse
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true; // :: / ::1
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  // 6to4 (2002::/16): the encapsulated IPv4 is bytes 2–5 — re-check it (e.g. 2002:7f00:1:: → 127.0.0.1).
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`);
  // Teredo (2001:0000::/32): the client IPv4 is the last 4 bytes, bit-inverted.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return isBlockedV4(`${(~b[12]!) & 0xff}.${(~b[13]!) & 0xff}.${(~b[14]!) & 0xff}.${(~b[15]!) & 0xff}`);
  }
  // Embedded IPv4 — re-check the v4 in ANY form: ::ffff:x/96 (mapped), ::x/96 (compat), 64:ff9b::/96 (NAT64).
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const compat = b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0);
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  if (mapped || compat || nat64) return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  return false;
}
