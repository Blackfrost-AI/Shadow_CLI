/**
 * The settings modal — the one management surface for the console (General · Models · Agents ·
 * MCP · Projects). A 1080×700 sheet with a 208px nav rail; each pane is fetched on entry and
 * writes through the same gated /api routes the rest of the console uses.
 *
 * Everything is rebuilt from server state after each write — the modal never holds derived
 * state, so two tabs (or the terminal) racing it cannot leave it lying.
 */

import { el } from './dom.js';
import { getJson, postJson, patchJson, del } from './api.js';
import { toast, confirmDialog } from './ui.js';
import { themeSetting, setTheme } from './theme.js';
import { endpointsPane } from './endpointsPane.js';

/* ------------------------------------------------------------------ bits -- */

const field = (labelText, inputEl, hint) =>
  el('label', { class: 'field' }, [
    el('span', { class: 'label' }, [labelText]),
    inputEl,
    hint ? el('span', { class: 'hint' }, [hint]) : null,
  ]);

const input = (attrs = {}) => el('input', { class: 'input', ...attrs });

/** A list entry: `.info` block on the left, actions on the right (the styles.css contract). */
const entry = (name, subs, actions) =>
  el('div', { class: 'set-row' }, [
    el('div', { class: 'info' }, [
      el('div', { class: 'name' }, (Array.isArray(name) ? name : [name]).filter(Boolean)),
      ...(subs ?? []).map((s) => el('div', { class: 'hint' }, [s])),
    ]),
    el('div', { style: 'display:flex;gap:6px;flex:none;align-items:center;' }, actions.filter(Boolean)),
  ]);

/** An action button that disables + relabels while its request is in flight. */
const action = (labelText, onClick, { danger: isDanger = false } = {}) => {
  const btn = el('button', { class: `btn btn-sm ${isDanger ? 'btn-danger' : 'btn-ghost'}` }, [labelText]);
  btn.onclick = async () => {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = '…';
    try {
      await onClick();
    } catch (e) {
      if (e.message !== 'cancelled') toast(`failed: ${e.message}`, { kind: 'error' });
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  };
  return btn;
};

const confirmDelete = (title, body) =>
  confirmDialog({ title, body, danger: true, confirmLabel: 'Delete' });

/* --------------------------------------------------------------- General -- */

function generalPane(body) {
  body.replaceChildren(
    el('h3', {}, ['Appearance']),
    el('p', { class: 'desc' }, ['Theme applies instantly and persists in this browser only.']),
    field(
      'Theme',
      (() => {
        const seg = el('div', { class: 'seg' }, []);
        const sync = () => {
          for (const b of [...seg.children]) b.classList.toggle('is-active', b.dataset.v === themeSetting());
        };
        for (const o of [
          ['light', 'Light'],
          ['dark', 'Dark'],
          ['auto', 'Auto'],
        ]) {
          const b = el('button', { dataset: { v: o[0] } }, [o[1]]);
          b.onclick = () => {
            setTheme(o[0]);
            sync();
          };
          seg.append(b);
        }
        sync();
        return seg;
      })(),
      'Auto follows the system setting',
    ),
  );
}

/* ---------------------------------------------------------------- Models -- */

async function modelsPane(body) {
  body.replaceChildren();
  let data;
  try {
    data = await getJson('/api/models');
  } catch (e) {
    body.append(el('p', { class: 'desc' }, [`models unavailable: ${e.message}`]));
    return;
  }
  const active = data.active ?? {};
  const models = data.models ?? [];

  body.append(
    el('h3', {}, ['Models & endpoints']),
    el('p', { class: 'desc' }, ['Manage connections and verify models. Saved changes apply to new sessions.']),
    el('p', { class: 'desc' }, [`Saved default: ${active.lastModel ?? active.model ?? '—'} · Vault ${data.vaultUnlocked ? 'unlocked' : 'locked'}`]),
    el('p', { class: 'desc' }, ['Endpoint test: model list only. Response test: a sample with a 64-token output limit; may cost tokens. No project files or conversation history are sent.']),
  );

  if (!models.length) body.append(el('p', { class: 'desc' }, ['No model presets yet — add one below.']));
  const reload = () => modelsPane(body);
  for (const m of models) {
    const isActive = active.lastModel ? active.lastModel === m.label : active.provider === m.provider && active.model === m.model;
    const label = m.label ?? m.model ?? '';
    const result = el('div', { class: 'model-probe-result', role: 'status', 'aria-live': 'polite', hidden: true }, []);
    const editor = el('div', { class: 'model-editor', hidden: true }, []);
    const testButtons = [];
    const runProbe = async (kind) => {
      if (kind === 'response' && !(await confirmDialog({ title: `Test ${label}?`, body: 'Sends one synthetic “Reply with OK.” request, with no tools, files or conversation history. Output is capped at 64 tokens. Your provider may charge for this test.', confirmLabel: 'Send test request' }))) return;
      result.hidden = false;
      result.dataset.state = 'pending';
      result.textContent = kind === 'endpoint' ? 'Checking endpoint… (15 second limit)' : 'Waiting for a model response… (15 second limit)';
      testButtons.forEach((b) => { b.disabled = true; });
      try {
        const r = await postJson(`/api/models/${encodeURIComponent(label)}/probe`, { kind });
        result.dataset.state = r.ok ? 'ok' : 'error';
        result.textContent = `${r.ok ? '✓' : '⚠'} ${r.message} · ${r.elapsedMs} ms${r.status ? ` · HTTP ${r.status}` : ''}`;
      } catch (e) {
        result.dataset.state = 'error';
        result.textContent = `Could not run the test: ${e.message}`;
      } finally { testButtons.forEach((b) => { b.disabled = false; }); }
    };
    testButtons.push(action('Test endpoint', () => runProbe('endpoint')), action('Test response', () => runProbe('response')));
    const card = el('section', { class: 'model-card', 'aria-label': label }, [
      entry(
        [
          label,
          isActive ? el('span', { class: 'tag-chip', style: 'margin-left:8px;' }, ['default']) : null,
          m.disabled ? el('span', { class: 'hint', style: 'display:inline;margin-left:8px;' }, ['disabled']) : null,
        ],
        [
          `${m.provider === 'openai' ? 'OpenAI-compatible' : m.provider ?? '—'} · ${m.model ?? '—'}`,
          m.baseUrl ?? 'Provider default endpoint',
          m.credentialStatus ?? (m.hasCredential ? 'Model credential configured' : 'No model-specific credential'),
        ],
        [
          action('Edit connection', async () => {
            if (!editor.hidden) { editor.hidden = true; return; }
            editModel(editor, m, data.vaultUnlocked, reload);
            editor.hidden = false;
          }),
          isActive
            ? null
            : action('Set default', async () => {
                await patchJson(`/api/models/${encodeURIComponent(label)}`, { action: 'default' });
                await reload();
              }),
          action(m.disabled ? 'Enable' : 'Disable', async () => {
            await patchJson(`/api/models/${encodeURIComponent(label)}`, { action: m.disabled ? 'enable' : 'disable' });
            await reload();
          }),
          action('Delete', async () => {
            if (!(await confirmDelete(`Delete "${label}"?`, 'The preset is removed from config. Vault slots are left in place.'))) throw new Error('cancelled');
            await del(`/api/models/${encodeURIComponent(label)}`);
            await reload();
          }, { danger: true }),
        ],
      ),
      el('div', { class: 'model-test-actions' }, testButtons),
      result,
      editor,
    ]);
    body.append(card);
  }

  // -- add form --
  const fLabel = input({ placeholder: 'work-laptop' });
  const fProvider = el('select', { class: 'input' }, [
    el('option', { value: 'openai' }, ['OpenAI-compatible']),
    el('option', { value: 'anthropic' }, ['Anthropic']),
    el('option', { value: 'mock' }, ['Mock']),
  ]);
  const fModel = input({ placeholder: 'Model ID reported by your server' });
  const fBase = input({ placeholder: 'http://localhost:11434/v1', type: 'url', spellcheck: 'false' });
  const fKey = input({ placeholder: 'Optional for a keyless local server', type: 'password', autocomplete: 'new-password' });
  const addBtn = el('button', { class: 'btn btn-primary btn-sm' }, ['Add preset']);
  addBtn.onclick = async () => {
    const payload = { label: fLabel.value.trim(), provider: fProvider.value, model: fModel.value.trim() };
    if (fBase.value.trim()) payload.baseUrl = fBase.value.trim();
    if (fKey.value) payload.apiKey = fKey.value;
    addBtn.disabled = true;
    try {
      await postJson('/api/models', payload);
      fLabel.value = fModel.value = fBase.value = fKey.value = '';
      await reload();
    } catch (e) {
      toast(
        e.message.includes('vault-locked')
          ? 'the vault is locked — add the key from an unlocked terminal, or add the model without one'
          : `add failed: ${e.message}`,
        { kind: 'error' },
      );
    } finally { addBtn.disabled = false; }
  };
  body.append(
    el('h3', { style: 'margin-top:24px;' }, ['Add model']),
    el('div', { class: 'set-form' }, [
      el('div', { class: 'set-form-row' }, [field('Label', fLabel), field('Provider', fProvider)]),
      el('div', { class: 'set-form-row' }, [field('Model', fModel), field('Base URL', fBase)]),
      el('div', { class: 'set-form-row' }, [field('API key', fKey), el('div', { class: 'field' }, [addBtn])]),
    ]),
  );
}

function editModel(host, model, vaultOpen, reload) {
  const fModel = input({ value: model.model, required: true });
  const fBase = input({ value: model.baseUrl ?? '', type: 'url', placeholder: 'Provider default', spellcheck: 'false' });
  const fKey = input({ type: 'password', autocomplete: 'new-password', placeholder: vaultOpen ? 'Leave blank to keep the existing key' : 'Unlock the vault in your terminal to change keys', disabled: !vaultOpen });
  const fReuse = input({ type: 'checkbox', class: '' });
  const reuse = field('Use the existing credential with the changed endpoint', fReuse, 'Only confirm if you trust this endpoint with that key.');
  reuse.hidden = true;
  fBase.oninput = () => { reuse.hidden = fBase.value.trim() === (model.baseUrl ?? ''); fReuse.checked = false; };
  const save = el('button', { class: 'btn btn-primary', type: 'button' }, ['Save connection']);
  const cancel = el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { fKey.value = ''; host.hidden = true; } }, ['Cancel']);
  const status = el('div', { role: 'status', class: 'model-probe-result', hidden: true }, []);
  save.onclick = async () => {
    save.disabled = true;
    status.hidden = true;
    try {
      await patchJson(`/api/models/${encodeURIComponent(model.label)}`, {
        action: 'update', model: fModel.value.trim(), baseUrl: fBase.value.trim(),
        ...(fKey.value ? { apiKey: fKey.value } : {}), reuseCredential: fReuse.checked,
      });
      fKey.value = '';
      await reload();
      toast('Connection saved. Start a new session to use it.');
    } catch (e) {
      status.hidden = false;
      status.dataset.state = 'error';
      status.textContent = e.message;
    } finally { save.disabled = false; }
  };
  host.replaceChildren(
    el('h3', {}, ['Edit connection']),
    el('div', { class: 'set-form-row' }, [field('Model ID', fModel), field('Base URL', fBase)]),
    field('Replace API key', fKey, 'Stored encrypted on your Shadow host. The existing key is never sent to the browser.'),
    reuse,
    el('div', { class: 'model-test-actions' }, [save, cancel]), status,
  );
}

/* ---------------------------------------------------------------- Agents -- */

async function agentsPane(body) {
  body.replaceChildren();
  let agents = [];
  try {
    ({ agents } = await getJson('/api/agents'));
  } catch (e) {
    body.append(el('p', { class: 'desc' }, [`agents unavailable: ${e.message}`]));
    return;
  }
  body.append(el('h3', {}, ['Agents']), el('p', { class: 'desc' }, ['Sub-agent definitions the model can launch. Built-ins are read-only.']));

  if (!agents.length) body.append(el('p', { class: 'desc' }, ['No agents defined.']));
  const reload = () => agentsPane(body);
  for (const a of agents) {
    body.append(
      entry(
        [
          a.name,
          a.builtin ? el('span', { class: 'hint', style: 'display:inline;margin-left:8px;' }, ['built-in']) : null,
        ],
        [a.description ?? '', `${(a.tools ?? []).length} tools${a.model ? ` · ${a.model}` : ''}`],
        [
          a.builtin
            ? null
            : action('Delete', async () => {
                if (!(await confirmDelete(`Delete agent "${a.name}"?`, 'Sessions already running it are unaffected.'))) throw new Error('cancelled');
                await del(`/api/agents/${encodeURIComponent(a.name)}`);
                await reload();
              }, { danger: true }),
        ],
      ),
    );
  }

  const fName = input({ placeholder: 'reviewer' });
  const fDesc = input({ placeholder: 'what this agent is for' });
  const fTools = input({ placeholder: 'read_file, run_shell' });
  const fPrompt = el('textarea', { class: 'input', rows: '4', placeholder: 'system prompt' });
  const addBtn = el('button', { class: 'btn btn-primary btn-sm' }, ['Create agent']);
  addBtn.onclick = async () => {
    try {
      await postJson('/api/agents', {
        name: fName.value.trim(),
        description: fDesc.value.trim(),
        systemPrompt: fPrompt.value,
        tools: fTools.value.split(',').map((t) => t.trim()).filter(Boolean),
      });
      await reload();
    } catch (e) {
      toast(`create failed: ${e.message}`, { kind: 'error' });
    }
  };
  body.append(
    el('h3', { style: 'margin-top:24px;' }, ['New agent']),
    el('div', { class: 'set-form' }, [
      el('div', { class: 'set-form-row' }, [field('Name', fName, 'lowercase a-z0-9._-'), field('Description', fDesc)]),
      el('div', { class: 'set-form-row' }, [field('Tools', fTools, 'comma-separated'), el('div', { class: 'field' }, [addBtn])]),
      field('System prompt', fPrompt),
    ]),
  );
}

/* ------------------------------------------------------------------- MCP -- */

async function mcpPane(body) {
  body.replaceChildren();
  let servers = {};
  try {
    ({ servers } = await getJson('/api/mcp'));
  } catch (e) {
    body.append(el('p', { class: 'desc' }, [`mcp unavailable: ${e.message}`]));
    return;
  }
  body.append(
    el('h3', {}, ['MCP servers']),
    el('p', { class: 'desc' }, ['Servers are spawned at boot — a new one takes effect on the next `shadow web` start. This edits the config.']),
  );

  const entries = Object.entries(servers);
  if (!entries.length) body.append(el('p', { class: 'desc' }, ['No MCP servers configured.']));
  const reload = () => mcpPane(body);
  for (const [name, cfg] of entries) {
    body.append(
      entry(
        name,
        [cfg.command ? `${cfg.command} ${(cfg.args ?? []).join(' ')}` : cfg.url ?? '—', ...(cfg.envKeys?.length ? [`env: ${cfg.envKeys.join(', ')}`] : [])],
        [
          action('Remove', async () => {
            if (!(await confirmDialog({ title: `Remove MCP server "${name}"?`, danger: true, confirmLabel: 'Remove' }))) throw new Error('cancelled');
            await del(`/api/mcp/${encodeURIComponent(name)}`);
            await reload();
          }, { danger: true }),
        ],
      ),
    );
  }

  const fName = input({ placeholder: 'context-cooler' });
  const fCommand = input({ placeholder: 'command (stdio server)' });
  const fArgs = input({ placeholder: '--arg value' });
  const fUrl = input({ placeholder: 'https://… (remote server)' });
  const addBtn = el('button', { class: 'btn btn-primary btn-sm' }, ['Add server']);
  addBtn.onclick = async () => {
    const payload = { name: fName.value.trim() };
    if (fUrl.value.trim()) payload.url = fUrl.value.trim();
    else {
      if (!fCommand.value.trim()) {
        toast('a command or a url is required', { kind: 'error' });
        return;
      }
      payload.command = fCommand.value.trim();
      payload.args = fArgs.value.split(' ').filter(Boolean);
    }
    try {
      await postJson('/api/mcp', payload);
      await reload();
    } catch (e) {
      toast(`add failed: ${e.message}`, { kind: 'error' });
    }
  };
  body.append(
    el('h3', { style: 'margin-top:24px;' }, ['Add server']),
    el('div', { class: 'set-form' }, [
      el('div', { class: 'set-form-row' }, [field('Name', fName), field('Command', fCommand)]),
      el('div', { class: 'set-form-row' }, [field('Args', fArgs), field('or URL', fUrl)]),
      el('div', { class: 'set-form-row' }, [el('div', { class: 'field' }, [addBtn])]),
    ]),
  );
}

/* -------------------------------------------------------------- Projects -- */

async function projectsPane(body, ctx) {
  body.replaceChildren();
  let projects = [];
  try {
    ({ projects } = await getJson('/api/projects'));
  } catch (e) {
    body.append(el('p', { class: 'desc' }, [`projects unavailable: ${e.message}`]));
    return;
  }
  body.append(
    el('h3', {}, ['Projects']),
    el('p', { class: 'desc' }, ['The allowlist every web session is jailed to. Removing one closes its open sessions.']),
  );

  if (!projects.length) body.append(el('p', { class: 'desc' }, ['No projects on the allowlist.']));
  const reload = () => projectsPane(body, ctx);
  for (const p of projects) {
    body.append(
      entry(
        p.label ?? p.path,
        [p.path],
        [
          action('Remove', async () => {
            if (
              !(await confirmDialog({
                title: `Remove "${p.label ?? p.path}"?`,
                body: 'Open web sessions inside it are closed immediately. Files on disk are untouched.',
                danger: true,
                confirmLabel: 'Remove',
              }))
            ) throw new Error('cancelled');
            await postJson('/api/projects/remove', { id: p.id });
            ctx?.onProjectsChanged?.();
            await reload();
          }, { danger: true }),
        ],
      ),
    );
  }

  const fPath = input({ placeholder: '/Users/you/code/project' });
  const fLabel = input({ placeholder: 'project (optional)' });
  const addBtn = el('button', { class: 'btn btn-primary btn-sm' }, ['Add project']);
  addBtn.onclick = async () => {
    try {
      const payload = { path: fPath.value.trim() };
      if (fLabel.value.trim()) payload.label = fLabel.value.trim();
      await postJson('/api/projects', payload);
      fPath.value = fLabel.value = '';
      ctx?.onProjectsChanged?.();
      await reload();
    } catch (e) {
      toast(`add failed: ${e.message}`, { kind: 'error' });
    }
  };
  body.append(
    el('h3', { style: 'margin-top:24px;' }, ['Add project']),
    el('div', { class: 'set-form' }, [
      el('div', { class: 'set-form-row' }, [field('Path', fPath), field('Label', fLabel)]),
      el('div', { class: 'set-form-row' }, [el('div', { class: 'field' }, [addBtn])]),
    ]),
  );
}

/* ----------------------------------------------------------------- modal -- */

const PANES = [
  { id: 'general', label: 'General', render: (body) => generalPane(body) },
  { id: 'models', label: 'Models & endpoints', render: (body) => void modelsPane(body) },
  { id: 'endpoints', label: 'Endpoints', render: (body) => void endpointsPane(body) },
  { id: 'agents', label: 'Agents', render: (body) => void agentsPane(body) },
  { id: 'mcp', label: 'MCP', render: (body) => void mcpPane(body) },
  { id: 'projects', label: 'Projects', render: (body, ctx) => void projectsPane(body, ctx) },
];

/**
 * Open the settings modal. Returns a close() handle; Escape and the backdrop close it too.
 * `ctx.onProjectsChanged` fires when the allowlist changes so the sidebar re-renders.
 */
export function openSettings(ctx = {}) {
  const previousFocus = document.activeElement;
  const pane = el('div', { class: 'set-pane scroll' }, []);
  const nav = el('div', { class: 'set-nav' }, []);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const onKey = (e) => {
    if ([...document.querySelectorAll('.modal-mask')].at(-1) !== mask) return;
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const focusable = [...mask.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((el) => el.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || !mask.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  const mask = el(
    'div',
    {
      class: 'modal-mask',
      onClick: (e) => {
        if (e.target === mask) close();
      },
    },
    [
      el('div', { class: 'modal set', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' }, [
        el('div', { class: 'set-grid' }, [
          nav,
          el('div', { style: 'display:flex;flex-direction:column;min-width:0;min-height:0;' }, [
            el('div', { class: 'modal-head' }, [
              el('span', { class: 't' }, ['Settings']),
              el('button', { class: 'icon-btn settings-close', 'aria-label': 'Close settings', title: 'Close', onClick: () => close() }, ['✕']),
            ]),
            pane,
          ]),
        ]),
      ]),
    ],
  );

  const show = (id) => {
    for (const b of [...nav.children]) {
      b.classList.toggle('is-active', b.dataset.id === id);
      if (b.dataset.id === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    // A separate host per tab keeps a late fetch from overwriting the newly selected pane.
    const currentPane = el('div', {}, []);
    pane.replaceChildren(currentPane);
    PANES.find((p) => p.id === id)?.render(currentPane, ctx);
  };
  for (const p of PANES) {
    const b = el('button', { class: 'set-item', dataset: { id: p.id } }, [p.label]);
    b.onclick = () => show(p.id);
    nav.append(b);
  }

  document.addEventListener('keydown', onKey);
  document.body.append(mask);
  show(PANES.some((p) => p.id === ctx.initialPane) ? ctx.initialPane : 'general');
  nav.querySelector('.is-active')?.focus();
  return { close };
}
