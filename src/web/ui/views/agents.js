import { el, mount } from '../dom.js';
import { getJson, postJson, putJson, del } from '../api.js';
import { viewShell, blockHead, reason } from '../parts.js';

/**
 * Agents management (the "sub-agent presets" surface). Lists built-ins + custom defs from
 * /api/agents as cards; supports create, edit (PUT), and delete. Built-ins are read-only.
 *
 * The editor offers the common tools as chips plus a free-text field for tool names not in the
 * curated list (the registry validates existence at sub-agent spawn time).
 */

// A curated set of the most-useful tools for sub-agents. Not exhaustive — the free-text field
// covers anything else. Mirrors the names in src/tools/*.ts.
const COMMON_TOOLS = [
  'read_file', 'grep', 'glob', 'run_shell', 'edit_file', 'write_file',
  'multi_edit', 'apply_patch', 'web_fetch', 'web_search', 'todo_write', 'view_image', 'memory',
];

let agents = [];

async function load() {
  const r = await getJson('/api/agents');
  agents = r.agents ?? [];
}

function render(host) {
  const newBtn = el('button', { class: 'btn primary', style: 'margin-left:auto' }, ['+ New agent']);
  const head = el('div', { class: 'view-head' }, [
    el('h1', {}, ['Agents']),
    el('span', { class: 'muted', style: 'font-size:12px' }, ['Sub-agent definitions the main loop can launch.']),
    newBtn,
  ]);

  const cards = agents.map((a) => {
    const kind = a.builtin ? 'builtin' : 'custom';
    const chips = (a.tools && a.tools.length ? a.tools : ['—']).map((t) => el('span', { class: 'tag-chip' }, [t]));
    const meta = el('div', { class: 'agent-meta' }, [
      el('div', {}, [`model: ${a.model ?? 'inherit'}`]),
      el('div', { class: 'faint' }, [a.maxIterations ? `max ${a.maxIterations} iterations` : 'default max iterations']),
      ...(a.builtin
        ? []
        : [el('div', { class: 'kit-row', style: 'justify-content:flex-end;margin-top:8px' }, [
            el('button', { class: 'btn-mini', onclick: () => edit(host, a) }, ['edit']),
            el('button', { class: 'btn-mini danger', onclick: () => remove(host, a.name) }, ['delete']),
          ])]),
    ]);
    return el('div', { class: 'agent-card' }, [
      el('div', { class: 'agent-main' }, [
        el('div', { class: 'agent-name-row' }, [
          el('span', { class: 'agent-name' }, [a.name]),
          el('span', { class: `badge kind-${kind}` }, [kind]),
        ]),
        el('div', { class: 'agent-desc' }, [a.description]),
        el('div', { class: 'agent-tools' }, chips),
      ]),
      meta,
    ]);
  });

  mount(host, [viewShell(head, [el('div', { class: 'stack' }, cards)])]);
  newBtn.onclick = () => edit(host, null);
}

function refresh(host) {
  void load()
    .then(() => render(host))
    .catch((e) => mount(host, [viewShell(el('div', { class: 'view-head' }, [el('h1', {}, ['Agents'])]), [el('p', { class: 'error' }, [`Failed: ${String(e)}`])])]));
}

/** The editor (inline form). `existing` is null for create, the agent for edit. PUT on edit, POST on create. */
function edit(host, existing) {
  const isEdit = existing !== null;
  const field = (attrs) => el('input', { class: 'field', style: 'max-width:none', ...attrs });
  const name = field({ placeholder: 'security-auditor', ...(isEdit ? { value: existing.name, disabled: 'true' } : {}) });
  const description = field({ placeholder: 'Short description', ...(isEdit ? { value: existing.description } : {}) });
  const model = field({ placeholder: '(optional) override model', ...(isEdit && existing.model ? { value: existing.model } : {}) });
  const maxIter = field({ type: 'number', placeholder: '(optional) max iterations', ...(isEdit && existing.maxIterations ? { value: String(existing.maxIterations) } : {}) });
  const extraTools = field({ placeholder: 'extra tools, comma-separated', ...(isEdit ? { value: existing.tools.filter((t) => !COMMON_TOOLS.includes(t)).join(', ') } : {}) });
  const systemPrompt = el('textarea', { class: 'field', style: 'max-width:none;min-height:120px;resize:vertical', placeholder: 'System prompt for this sub-agent…' });
  // `?? ''` guards the round trip: assigning undefined to .value yields the string "undefined",
  // which then saves over the real prompt.
  if (isEdit) systemPrompt.value = existing.systemPrompt ?? '';

  const selected = new Set(isEdit ? existing.tools : []);
  const chips = COMMON_TOOLS.map((t) => {
    const on = selected.has(t);
    const chip = el('button', { class: `tag-chip${on ? ' on' : ''}`, type: 'button', style: on ? 'color:var(--accent);border-color:var(--accent)' : '' }, [t]);
    chip.onclick = () => {
      if (selected.has(t)) {
        selected.delete(t);
        chip.style.color = '';
        chip.style.borderColor = '';
      } else {
        selected.add(t);
        chip.style.color = 'var(--accent)';
        chip.style.borderColor = 'var(--accent)';
      }
    };
    return chip;
  });

  const status = el('div', { class: 'add-err', style: 'margin:0' }, []);
  const saveBtn = el('button', { class: 'btn primary' }, [isEdit ? 'Save' : 'Create']);
  const cancelBtn = el('button', { class: 'btn' }, ['Cancel']);
  const row = (labelText, control) => el('div', { class: 'row', style: 'max-width:640px' }, [el('label', {}, [labelText]), control]);
  const form = el('div', { class: 'stack', style: 'max-width:640px;gap:12px' }, [
    row('Name', name), row('Description', description), row('Model', model), row('Max iters', maxIter),
    el('div', {}, [el('div', { class: 'card-key', style: 'margin-bottom:8px' }, ['Tools']), el('div', { class: 'agent-tools' }, chips)]),
    row('Extra tools', extraTools),
    el('div', {}, [el('div', { class: 'card-key', style: 'margin-bottom:8px' }, ['System prompt']), systemPrompt]),
    el('div', { class: 'kit-row' }, [saveBtn, cancelBtn]),
    status,
  ]);

  mount(host, [viewShell(
    el('div', { class: 'view-head' }, [el('h1', {}, [isEdit ? `Edit ${existing.name}` : 'New agent'])]),
    [form],
  )]);

  cancelBtn.onclick = () => refresh(host);
  saveBtn.onclick = () => {
    const tools = [...selected];
    for (const t of extraTools.value.split(',').map((s) => s.trim()).filter(Boolean)) tools.push(t);
    if (!name.value.trim() || !description.value.trim() || !systemPrompt.value.trim() || tools.length === 0) {
      status.textContent = 'Name, description, system prompt, and at least one tool are required.';
      return;
    }
    const body = {
      name: name.value.trim(), description: description.value.trim(), tools, systemPrompt: systemPrompt.value,
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
      ...(maxIter.value ? { maxIterations: Number(maxIter.value) } : {}),
    };
    status.textContent = '';
    saveBtn.disabled = true;
    const op = isEdit ? putJson(`/api/agents/${encodeURIComponent(body.name)}`, body) : postJson('/api/agents', body);
    op.then(() => refresh(host)).catch((e) => {
      status.textContent = reason(e);
      saveBtn.disabled = false;
    });
  };
}

async function remove(host, name) {
  if (!confirm(`Delete agent "${name}"?`)) return;
  try {
    await del(`/api/agents/${encodeURIComponent(name)}`);
    refresh(host);
  } catch (e) {
    alert(`Could not delete: ${reason(e)}`);
  }
}

export function agentsView(host) {
  refresh(host);
  return () => {};
}
