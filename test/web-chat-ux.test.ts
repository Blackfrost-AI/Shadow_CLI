import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
// @ts-expect-error Browser modules are exercised against a DOM fixture.
import { mountChat } from '../src/web/ui/chat.js';
// @ts-expect-error Browser module has no TypeScript declaration.
import { el } from '../src/web/ui/dom.js';

class Stream {
  static CLOSED = 2;
  static instances: Stream[] = [];
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { Stream.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 2; }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

let doc: Document;
let posts: string[];
let allowed: boolean;
let accepted: boolean;
let drafts: Map<string, string>;
const cleanups: Array<() => void> = [];
const oldGlobals = new Map<string, PropertyDescriptor | undefined>();
const settle = async () => { await delay(0); await delay(0); };

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body><main id="chat"></main></body></html>');
  doc = dom.document;
  posts = [];
  allowed = true;
  accepted = true;
  drafts = new Map();
  Stream.instances = [];
  const globals = {
    document: doc,
    window: dom.window,
    EventSource: Stream,
    sessionStorage: {
      getItem: (key: string) => drafts.get(key) ?? null,
      setItem: (key: string, value: string) => drafts.set(key, value),
      removeItem: (key: string) => drafts.delete(key),
    },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    fetch: async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(path);
        return Response.json(accepted ? { accepted: true } : { error: 'server unavailable' }, { status: accepted ? 202 : 503 });
      }
      if (path.startsWith('/api/transcript')) return Response.json({ events: [], lastEventId: 0 });
      return Response.json({ sessions: [{ id: 'demo', canPrompt: allowed, canInterrupt: allowed, origin: allowed ? 'web' : 'local' }] });
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const [key, descriptor] of oldGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  oldGlobals.clear();
});

async function mount(ctx = {}, online = true) {
  const host = doc.querySelector('#chat')!;
  const chat = mountChat(host, 'demo', ctx);
  cleanups.push(() => chat.unmount());
  await settle();
  if (online) Stream.instances.at(-1)!.open();
  return { chat, host, input: host.querySelector('textarea') as HTMLTextAreaElement, send: host.querySelector('.btn-send') as HTMLButtonElement };
}

function type(input: HTMLTextAreaElement, text: string) {
  input.value = text;
  input.oninput?.({} as Event);
}

test('the browser keeps a failed submission editable and does not invent a user turn', async () => {
  const { chat, host, input, send } = await mount();
  type(input, 'Please explain this project.');
  accepted = false;
  send.click();
  await settle();
  assert.equal(input.value, 'Please explain this project.');
  assert.equal(drafts.get('shadow.draft.demo'), input.value);
  assert.equal(chat.model.snapshot().rows.filter((r: { kind: string }) => r.kind === 'user').length, 0);
  assert.match(host.textContent ?? '', /draft is kept/);
  assert.equal(input.readOnly, false);
});

test('a successful acknowledgement clears the draft and the stream owns the user row', async () => {
  const { chat, input, send } = await mount();
  type(input, 'Explain the README');
  send.click();
  await settle();
  assert.equal(input.value, '');
  assert.equal(drafts.has('shadow.draft.demo'), false);
  Stream.instances.at(-1)!.emit({ type: 'user', text: 'Explain the README' });
  Stream.instances.at(-1)!.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
  await delay(80);
  assert.equal(chat.model.snapshot().rows.filter((r: { kind: string }) => r.kind === 'user').length, 1);
  assert.equal(posts.length, 1);
});

test('drafts survive switching away and back to a session', async () => {
  const first = await mount();
  type(first.input, 'An unfinished thought\nwith another line');
  first.chat.unmount();
  cleanups.pop();
  const next = await mount();
  assert.equal(next.input.value, 'An unfinished thought\nwith another line');
  assert.equal(posts.length, 0);
});

test('connecting and reconnecting are visible and never submit a draft', async () => {
  const { host, input, send } = await mount({}, false);
  type(input, 'Keep this safe');
  assert.equal(send.disabled, true);
  assert.match(host.textContent ?? '', /Connecting to Shadow/);
  const stream = Stream.instances.at(-1)!;
  stream.open();
  assert.equal(send.disabled, false);
  stream.readyState = 0;
  stream.onerror?.();
  assert.equal(send.disabled, true);
  assert.match(host.textContent ?? '', /Reconnecting to Shadow/);
  assert.equal(input.value, 'Keep this safe');
  assert.equal(posts.length, 0);
});

test('starter prompts populate the composer for review and do not submit', async () => {
  const { host, input } = await mount();
  (host.querySelector('.tag-chip') as HTMLButtonElement).click();
  assert.equal(input.value, 'Explain this repository');
  assert.equal(posts.length, 0);
  let prevented = false;
  input.onkeydown?.({ key: 'Enter', shiftKey: false, isComposing: true, preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent);
  assert.equal(prevented, false);
  assert.equal(posts.length, 0);
});

test('the standalone landing session gives the user a working next step', async () => {
  allowed = false;
  let started = 0;
  const { host, input } = await mount({ onNewSession: () => started++ });
  assert.equal(input.disabled, true);
  assert.match(host.textContent ?? '', /Ready when you are/);
  (host.querySelector('.chips .btn-primary') as HTMLButtonElement).click();
  assert.equal(started, 1);
});

test('DOM data attributes support settings selection and theme state', () => {
  const button = el('button', { dataset: { id: 'models', v: 'dark' } }, ['Models']);
  assert.equal(button.dataset.id, 'models');
  assert.equal(button.getAttribute('data-v'), 'dark');
  assert.equal(button.hasAttribute('dataset'), false);
});
