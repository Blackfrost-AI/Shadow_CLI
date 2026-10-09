import { closeSync, openSync, readSync } from 'node:fs';

/** Stream selected control records without loading or parsing full conversation snapshots. */
export function visitControlRecords(path: string, kinds: string[], visit: (record: Record<string, unknown>) => void): void {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return; }
  const markers = kinds.map((kind) => `"kind":"${kind}"`);
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let dropping = false;
  const consume = (line: Buffer) => {
    const text = line.toString('utf8');
    if (!markers.some((marker) => text.includes(marker))) return;
    try {
      const record = JSON.parse(text) as Record<string, unknown>;
      if (typeof record.kind === 'string' && kinds.includes(record.kind)) visit(record);
    } catch { /* skip malformed or incomplete records */ }
  };
  try {
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      const buffer = Buffer.concat([pending, chunk.subarray(0, size)]);
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 10) continue;
        if (!dropping) consume(buffer.subarray(start, index));
        dropping = false;
        start = index + 1;
      }
      pending = Buffer.from(buffer.subarray(start));
      if (pending.length > 16 * 1024 * 1024) { pending = Buffer.alloc(0); dropping = true; }
    }
    if (!dropping && pending.length) consume(pending);
  } finally { closeSync(fd); }
}
