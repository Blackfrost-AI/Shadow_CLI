import { el, mount } from '../dom.js';
import { getJson, postJson, patchJson, del } from '../api.js';
import { viewShell, dotEl, reason } from '../parts.js';

/**
 * Models management (the "APIs" surface). Lists presets from /api/models as a compact grid —
 * label, model id, base URL, group, and credential PRESENCE (never the secret itself) — and
 * supports add (with optional key), set-default, enable/disable, and delete.
 *
 * The vault-locked case is surfaced explicitly: the Add form's key field is disabled with a note
 * when the server reports vaultUnlocked=false, and a 409 from POST shows the message.
 */

let snapshot = null;

async function load() {
  snapshot = await getJson('/api/models');
}

/** The current default label the "★" action toggles against (lastModel, falling back to model). */
function defaultLabel(active) {
  return active?.lastModel ?? active?.model ?? null;
}

function render(host) {
  if (!snapshot) return;
  const { active, vaultUnlocked, models } = snapshot;
  const def = defaultLabel(active);

  // ── head: title · source · [+ Add preset] ──
  const addBtn = el('button', { class: 'btn primary', style: 'margin-left:auto' }, ['+ Add preset']);
  const head = el('div', { class: 'view-head' }, [
    el('h1', {}, ['Models']),
    el('span', { class: 'muted', style: 'font-size:12px' }, ['presets from ~/.shadow/config.json' + (vaultUnlocked ? '' : ' · vault locked')]),
    addBtn,
  ]);

  // ── grid ──
  const thead = el('div', { class: 'model-thead' }, [
    el('span', {}, ['label']), el('span', {}, ['model']), el('span', {}, ['base url']),
    el('span', {}, ['group']), el('span', {}, ['credential']), el('span', {}, []),
  ]);
  const rows = models.map((m) => {
    const isDefault = def && m.label === def;
    const label = el('span', { class: 'model-label' }, [
      dotEl(m.disabled ? 'faint' : 'ok'),
      m.label,
      ...(isDefault ? [el('span', { class: 'badge kind-custom', style: 'margin-left:2px' }, ['default'])] : []),
    ]);
    const cred = m.hasCredential
      ? el('span', { class: 'model-cred has' }, [`✓ ${m.credRef ?? 'stored'}`])
      : el('span', { class: 'model-cred none' }, ['— none']);
    const actions = el('span', { class: 'model-actions' }, [
      ...(isDefault ? [] : [el('button', { class: 'btn-mini', title: 'set as default', onclick: () => setDefault(host, m.label) }, ['default'])]),
      el('button', { class: 'btn-mini', onclick: () => toggle(host, m) }, [m.disabled ? 'enable' : 'disable']),
      el('button', { class: 'btn-mini danger', title: 'delete preset', onclick: () => remove(host, m.label) }, ['✕']),
    ]);
    return el('div', { class: `model-row${m.disabled ? ' disabled' : ''}` }, [
      label,
      el('span', { class: 'model-cell-mono' }, [m.model]),
      el('span', { class: 'model-cell-mono' }, [m.baseUrl ?? '—']),
      el('span', { class: 'muted' }, [m.group ?? '—']),
      cred,
      actions,
    ]);
  });
  const grid = el('div', { class: 'model-table' }, [thead, ...rows]);

  const hint = el('div', { class: 'hint-note' }, ['credentials are never displayed — only presence (✓) and an opaque vault pointer']);

  const body = [grid, hint];
  mount(host, [viewShell(head, body)]);

  addBtn.onclick = () => openAddForm(host);
}

/** The add form, shown inline in place of the grid. Cancel returns to the list. */
function openAddForm(host) {
  const { vaultUnlocked } = snapshot;
  const field = (attrs) => el('input', { class: 'field', style: 'max-width:none', ...attrs });
  const label = field({ placeholder: 'label — e.g. qwen-local' });
  const provider = el('select', { class: 'field', style: 'max-width:none' }, [
    el('option', { value: 'openai' }, ['openai (OpenAI-compatible)']),
    el('option', { value: 'anthropic' }, ['anthropic']),
    el('option', { value: 'mock' }, ['mock']),
  ]);
  const model = field({ placeholder: 'model id — e.g. qwen3-coder-30b' });
  const baseUrl = field({ placeholder: 'base url — e.g. http://127.0.0.1:8080/v1' });
  const apiKey = field({
    type: 'password',
    placeholder: vaultUnlocked ? 'api key (sealed into the vault, never written to config)' : 'unlock the vault to set a key',
    ...(vaultUnlocked ? {} : { disabled: 'true' }),
  });
  const status = el('div', { class: 'add-err', style: 'margin:0' }, []);
  const saveBtn = el('button', { class: 'btn primary' }, ['Add preset']);
  const cancelBtn = el('button', { class: 'btn' }, ['Cancel']);

  const row = (labelText, control) => el('div', { class: 'row', style: 'max-width:560px' }, [el('label', {}, [labelText]), control]);
  const form = el('div', { class: 'stack', style: 'max-width:560px;gap:12px' }, [
    row('Label', label), row('Provider', provider), row('Model', model), row('Base URL', baseUrl), row('API key', apiKey),
    el('div', { class: 'kit-row' }, [saveBtn, cancelBtn]),
    status,
  ]);
  mount(host, [viewShell(
    el('div', { class: 'view-head' }, [el('h1', {}, ['Add model preset'])]),
    [form],
  )]);

  cancelBtn.onclick = () => refresh(host);
  saveBtn.onclick = async () => {
    const l = label.value.trim();
    const m = model.value.trim();
    if (!l || !m) {
      status.textContent = 'Label and model are required.';
      return;
    }
    status.textContent = '';
    saveBtn.disabled = true;
    try {
      await postJson('/api/models', {
        label: l, provider: provider.value, model: m,
        baseUrl: baseUrl.value.trim() || undefined, apiKey: apiKey.value.trim() || undefined,
      });
      refresh(host);
    } catch (e) {
      status.textContent = reason(e);
      saveBtn.disabled = false;
    }
  };
}

function refresh(host) {
  void load()
    .then(() => render(host))
    .catch((e) => mount(host, [viewShell(el('div', { class: 'view-head' }, [el('h1', {}, ['Models'])]), [el('p', { class: 'error' }, [`Failed: ${String(e)}`])])]));
}

async function setDefault(host, label) {
  try {
    await patchJson(`/api/models/${encodeURIComponent(label)}`, { action: 'default' });
    refresh(host);
  } catch (e) {
    alert(`Could not set default: ${reason(e)}`);
  }
}

async function toggle(host, m) {
  try {
    await patchJson(`/api/models/${encodeURIComponent(m.label)}`, { action: m.disabled ? 'enable' : 'disable' });
    refresh(host);
  } catch (e) {
    alert(`Could not toggle: ${reason(e)}`);
  }
}

async function remove(host, label) {
  if (!confirm(`Delete model preset "${label}"? This cannot be undone.`)) return;
  try {
    await del(`/api/models/${encodeURIComponent(label)}`);
    refresh(host);
  } catch (e) {
    alert(`Could not delete: ${reason(e)}`);
  }
}

export function modelsView(host) {
  refresh(host);
  return () => {};
}
