import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
let openSettings: (ctx: { initialPane: string }) => { close: () => void };

let doc: Document;
let close: (() => void) | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let requests: Array<{ path: string; method: string; body?: string }>;
const settle = async () => { await delay(0); await delay(0); };
beforeEach(async () => {
  const dom = parseHTML('<html><body></body></html>');
  doc = dom.document;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList;
  requests = [];
  for (const [key, value] of Object.entries({ document: doc, window: dom.window, fetch: async (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body as string });
    if (path === '/api/projects') return Response.json({ projects: [] });
    if (path.endsWith('/probe')) return Response.json({ ok: false, status: 401, elapsedMs: 12, message: 'Authentication rejected. Check the model credential.' });
    return Response.json({ vaultUnlocked: true, active: { lastModel: 'Local' }, models: [{ label: 'Local', provider: 'openai', model: 'sample', baseUrl: 'http://localhost:11434/v1', credentialStatus: 'No key configured' }] });
  } })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  // @ts-expect-error Browser module is exercised in a DOM fixture.
  ({ openSettings } = await import('../src/web/ui/settings.js'));
});
afterEach(() => {
  close?.();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});
const button = (text: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

test('models settings show endpoint and credential status, without automatically probing', async () => {
  close = openSettings({ initialPane: 'models' }).close;
  await settle();
  assert.match(doc.body.textContent ?? '', /Models & endpoints/);
  assert.match(doc.body.textContent ?? '', /http:\/\/localhost:11434\/v1/);
  assert.match(doc.body.textContent ?? '', /No key configured/);
  assert.ok(button('Edit connection'));
  assert.ok(button('Test response'));
  assert.deepEqual(requests.map((r) => r.method), ['GET']);
  assert.equal(doc.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Settings');
});

test('endpoint test shows a persistent actionable result and re-enables its button', async () => {
  close = openSettings({ initialPane: 'models' }).close;
  await settle();
  button('Test endpoint').click();
  await settle();
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(requests.at(-1)!.body!), { kind: 'endpoint' });
  const result = doc.querySelector('.model-probe-result') as HTMLElement;
  assert.equal(result.hidden, false);
  assert.match(result.textContent ?? '', /Authentication rejected.*12 ms.*HTTP 401/);
  assert.equal(button('Test endpoint').disabled, false);
});

test('editing keeps the existing key hidden and offers explicit endpoint reuse consent', async () => {
  close = openSettings({ initialPane: 'models' }).close;
  await settle();
  button('Edit connection').click();
  await settle();
  const editor = doc.querySelector('.model-editor') as HTMLElement;
  assert.equal(editor.hidden, false);
  assert.equal((editor.querySelector('input[type="password"]') as HTMLInputElement).value, '');
  const base = editor.querySelector('input[type="url"]') as HTMLInputElement;
  base.value = 'http://localhost:9000/v1';
  base.oninput?.({} as Event);
  assert.equal((editor.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, false);
  assert.match(editor.textContent ?? '', /Only confirm if you trust this endpoint/);
});

test('a late models fetch cannot replace another settings tab', async () => {
  const fetchOriginal = globalThis.fetch;
  let finish!: (r: Response) => void;
  globalThis.fetch = (path, init) => String(path) === '/api/models'
    ? new Promise((resolve) => { finish = resolve; }) : fetchOriginal(path, init);
  close = openSettings({ initialPane: 'models' }).close;
  button('Projects').click();
  // Resolve the OLD models request after Projects becomes active.
  globalThis.fetch = fetchOriginal;
  finish(Response.json({ models: [] }));
  await settle();
  assert.doesNotMatch(doc.querySelector('.set-pane')?.textContent ?? '', /Models & endpoints/);
});
