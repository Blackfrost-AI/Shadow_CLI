import { el, mount } from '../dom.js';
import { getJson, postJson, putJson, del } from '../api.js';
import { viewShell, dotEl, reason } from '../parts.js';

/**
 * MCP servers management. Lists configured servers (stdio or http transport) as cards; supports
 * add, edit, and delete. Secret-bearing fields (env values, header values) are never shown — only
 * their keys — so the UI matches the masked shape the API returns.
 *
 * A note on the badge: /api/mcp returns CONFIGURATION, not a live connection. Servers connect at
 * session-spawn time, not here — so the badge shows the transport (stdio/http), and we deliberately
 * do NOT paint a green "connected" state the management surface can't actually verify.
 */

let servers = {};

async function load() {
  const r = await getJson('/api/mcp');
  servers = r.servers ?? {};
}

function transport(s) {
  return s.url ? 'http' : 'stdio';
}

function describe(s) {
  if (s.url) return s.url;
  return [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');
}

function render(host) {
  const names = Object.keys(servers).sort();
  const addBtn = el('button', { class: 'btn primary', style: 'margin-left:auto' }, ['+ Add server']);
  const head = el('div', { class: 'view-head' }, [
    el('h1', {}, ['MCP servers']),
    el('span', { class: 'muted', style: 'font-size:12px' }, ['global servers — written to ~/.shadow/config.json only']),
    addBtn,
  ]);

  const cards = names.map((name) => {
    const s = servers[name];
    const secretBits = [];
    if (s.envKeys?.length) secretBits.push(`env: ${s.envKeys.join(', ')}`);
    if (s.headerKeys?.length) secretBits.push(`headers: ${s.headerKeys.join(', ')}`);
    return el('div', { class: 'mcp-card' }, [
      dotEl('accent'),
      el('div', { class: 'mcp-main' }, [
        el('div', { class: 'mcp-name' }, [name]),
        el('div', { class: 'mcp-target' }, [describe(s)]),
        ...(secretBits.length ? [el('div', { class: 'mcp-target', style: 'color:var(--faint)' }, [secretBits.join(' · ')])] : []),
      ]),
      el('span', { class: 'badge kind-builtin' }, [transport(s)]),
      el('button', { class: 'btn-mini', onclick: () => editServer(host, name, s) }, ['edit']),
      el('button', { class: 'btn-mini danger', onclick: () => remove(host, name) }, ['remove']),
    ]);
  });

  const body = cards.length
    ? [el('div', { class: 'stack', style: 'margin-top:16px' }, cards)]
    : [el('p', { class: 'muted', style: 'margin-top:16px' }, ['No MCP servers configured. Add one to expose tools to sessions.'])];
  mount(host, [viewShell(head, body)]);
  addBtn.onclick = () => editServer(host, null, null);
}

function refresh(host) {
  void load()
    .then(() => render(host))
    .catch((e) => mount(host, [viewShell(el('div', { class: 'view-head' }, [el('h1', {}, ['MCP servers'])]), [el('p', { class: 'error' }, [`Failed: ${String(e)}`])])]));
}

function editServer(host, existingName, existing) {
  const isEdit = existingName !== null;
  const field = (attrs) => el('input', { class: 'field', style: 'max-width:none', ...attrs });
  const name = field({ placeholder: 'my-server', ...(isEdit ? { value: existingName, disabled: 'true' } : {}) });
  const kind = el('select', { class: 'field', style: 'max-width:none' }, [
    el('option', { value: 'stdio' }, ['stdio (local command)']),
    el('option', { value: 'http' }, ['http (remote URL)']),
  ]);
  kind.value = existing?.url ? 'http' : 'stdio';
  const command = field({ placeholder: 'npx', ...(existing?.command ? { value: existing.command } : {}) });
  const args = field({ placeholder: '-y @mcp/server-fs /path', ...(existing?.args ? { value: existing.args.join(' ') } : {}) });
  const url = field({ placeholder: 'https://mcp.example.com/v1', ...(existing?.url ? { value: existing.url } : {}) });
  const headers = field({ placeholder: 'header keys only — values set via env, kept out of the page', ...(existing?.headerKeys?.length ? { value: existing.headerKeys.join(', ') } : {}) });

  const status = el('div', { class: 'add-err', style: 'margin:0' }, []);
  const saveBtn = el('button', { class: 'btn primary' }, [isEdit ? 'Save' : 'Add']);
  const cancelBtn = el('button', { class: 'btn' }, ['Cancel']);

  const toggle = () => {
    const isHttp = kind.value === 'http';
    command.disabled = isHttp;
    args.disabled = isHttp;
    url.disabled = !isHttp;
  };
  kind.onchange = toggle;
  toggle();

  const row = (labelText, control) => el('div', { class: 'row', style: 'max-width:640px' }, [el('label', {}, [labelText]), control]);
  const form = el('div', { class: 'stack', style: 'max-width:640px;gap:12px' }, [
    row('Name', name), row('Transport', kind), row('Command', command), row('Args (space-sep)', args), row('URL', url), row('Header keys', headers),
    el('div', { class: 'kit-row' }, [saveBtn, cancelBtn]),
    status,
  ]);

  mount(host, [viewShell(
    el('div', { class: 'view-head' }, [el('h1', {}, [isEdit ? `Edit ${existingName}` : 'Add MCP server'])]),
    [form],
  )]);
  cancelBtn.onclick = () => refresh(host);

  saveBtn.onclick = () => {
    const body = { name: name.value.trim() };
    if (kind.value === 'http') {
      if (!url.value.trim()) {
        status.textContent = 'URL is required for http transport.';
        return;
      }
      body.url = url.value.trim();
    } else {
      if (!command.value.trim()) {
        status.textContent = 'Command is required for stdio transport.';
        return;
      }
      body.command = command.value.trim();
      const a = args.value.trim();
      if (a) body.args = a.split(/\s+/);
    }
    status.textContent = '';
    saveBtn.disabled = true;
    const op = isEdit ? putJson(`/api/mcp/${encodeURIComponent(existingName)}`, body) : postJson('/api/mcp', body);
    op.then(() => refresh(host)).catch((e) => {
      status.textContent = reason(e);
      saveBtn.disabled = false;
    });
  };
}

async function remove(host, name) {
  if (!confirm(`Delete MCP server "${name}"?`)) return;
  try {
    await del(`/api/mcp/${encodeURIComponent(name)}`);
    refresh(host);
  } catch (e) {
    alert(`Could not delete: ${reason(e)}`);
  }
}

export function mcpView(host) {
  refresh(host);
  return () => {};
}
