import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { isolateHome } from './helpers/isolateHome.js';
isolateHome('web-onboard-flow');
const { page } = await import('../src/onboard/webOnboard.js');

function browser(fetcher: (path: string, init: RequestInit) => Promise<Response>) {
  const { document, window } = parseHTML(page('fixture-token'));
  // Supply native select/checkbox state omitted by the lightweight DOM implementation.
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'selectedIndex', { value: 0, writable: true });
    Object.defineProperty(select, 'value', {
      get() {
        return select.options[select.selectedIndex]?.value ?? '';
      },
      set(value: string) {
        select.selectedIndex = Array.from(select.options).findIndex((o) => o.value === value);
      },
    });
  }
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.hasAttribute('checked');
    },
    set(this: HTMLInputElement, value: boolean) {
      this.toggleAttribute('checked', value);
    },
  });
  runInNewContext(document.querySelector('script')!.textContent!, {
    document,
    fetch: fetcher,
    URL,
  });
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const change = (id: string) =>
    input(id).dispatchEvent(new window.Event('change', { bubbles: true }));
  const edit = (id: string) =>
    input(id).dispatchEvent(new window.Event('input', { bubbles: true }));
  const click = async (id: string) => {
    input(id).dispatchEvent(new window.Event('click', { bubbles: true }));
    await delay(0);
    await delay(0);
  };
  const submit = async () => {
    document.getElementById('f')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await delay(0);
    await delay(0);
  };
  input('provider').value = 'custom';
  change('provider');
  input('baseUrl').value = 'http://127.0.0.1:8800';
  return { document, input, change, edit, click, submit };
}

test('browser discovery flows to model selection, review, retry and save without resetting the draft', async () => {
  let saves = 0;
  const requests: Record<string, unknown>[] = [];
  const ui = browser(async (path, init) => {
    if (path === '/probe')
      return Response.json({
        ok: true,
        source: 'live',
        provider: 'openai',
        hosting: 'self-hosted',
        baseUrl: 'http://127.0.0.1:8800/v1',
        models: ['glm-5.3-derisked', 'second-model'],
      });
    if (path === '/save') {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ++saves === 1
        ? Response.json({ ok: false, error: 'Retry this model check' })
        : Response.json({ ok: true });
    }
    return Response.json({ ok: true });
  });
  ui.input('apiKey').value = 'fixture-key';
  await ui.click('next');
  assert.equal(ui.input('step0').hidden, true);
  assert.equal(ui.input('step1').hidden, false);
  assert.equal(ui.input('model').value, 'glm-5.3-derisked');
  assert.equal(ui.input('baseUrl').value, 'http://127.0.0.1:8800/v1');
  assert.match(ui.input('endpointStatus').textContent!, /Live catalog/);
  await ui.click('next');
  assert.equal(ui.input('step2').hidden, false);
  assert.match(ui.input('review').textContent!, /glm-5.3-derisked/);
  await ui.click('back');
  assert.equal(ui.input('model').value, 'glm-5.3-derisked');
  await ui.click('next');
  ui.input('pw').value = ui.input('pw2').value = 'fixture password';
  await ui.submit();
  assert.equal(ui.input('step2').hidden, false);
  assert.match(ui.input('msg').textContent!, /Retry/);
  assert.equal(ui.input('apiKey').value, 'fixture-key');
  assert.equal(ui.input('pw').value, 'fixture password');
  await ui.submit();
  assert.equal(saves, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].selfHosted, true);
  assert.deepEqual(requests[1].models, ['glm-5.3-derisked']);
  assert.equal(ui.input('apiKey').value, '', 'drop secret fields after completion');
  assert.equal(ui.input('go').textContent, 'Done');
});

test('failed discovery stays in the browser and supports retry or an exact model ID', async () => {
  let probes = 0;
  const ui = browser(async (path) => {
    if (path === '/probe') {
      probes++;
      throw new Error('Fixture timeout');
    }
    return Response.json({ ok: true });
  });
  ui.input('apiKey').value = 'preserved-key';
  await ui.click('next');
  assert.equal(ui.input('step1').hidden, false);
  assert.match(ui.input('endpointStatus').textContent!, /entries are kept/);
  await ui.click('discover');
  assert.equal(probes, 2);
  assert.equal(ui.input('apiKey').value, 'preserved-key');
  ui.input('manualModel').value = 'glm-5.3-derisked';
  ui.edit('manualModel');
  await ui.click('next');
  assert.equal(ui.input('step2').hidden, false);
  assert.equal(ui.input('model').value, 'glm-5.3-derisked');
  assert.equal(ui.input('apiKey').value, 'preserved-key');
});
