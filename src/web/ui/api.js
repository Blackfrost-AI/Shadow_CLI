/**
 * Thin fetch wrappers. The session token lives in `?t=` from the launch URL; we stash it
 * once at boot and attach it to every request as `Authorization: Bearer` so it never leaks
 * into a URL that could be logged or appear in history. SSE uses the original `?t=`-bearing
 * URL because EventSource cannot set custom headers.
 */

let TOKEN = '';

export function setToken(t) {
  TOKEN = t;
}

export function token() {
  return TOKEN;
}

async function req(path, init) {
  const r = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  return r;
}

export async function getJson(path) {
  const r = await req(path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return await r.json();
}

export async function postJson(path, body) {
  const r = await req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return await r.json();
}

export async function patchJson(path, body) {
  const r = await req(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return await r.json();
}

export async function putJson(path, body) {
  const r = await req(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return await r.json();
}

export async function del(path) {
  const r = await req(path, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return await r.json().catch(() => ({}));
}
