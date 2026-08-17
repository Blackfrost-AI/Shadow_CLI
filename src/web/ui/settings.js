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
    el('h3', {}, ['Models']),
    el('p', { class: 'desc' }, [`Active: ${active.model ?? '—'} (${active.provider ?? '—'})`]),
  );

  if (!models.length) body.append(el('p', { class: 'desc' }, ['No model presets yet — add one below.']));
  const reload = () => modelsPane(body);
  for (const m of models) {
    const isActive = active.provider === m.provider && active.model === m.model;
    const label = m.label ?? m.model ?? '';
    body.append(
      entry(
        [
          label,
          isActive ? el('span', { class: 'tag-chip', style: 'margin-left:8px;' }, ['active']) : null,
          m.disabled ? el('span', { class: 'hint', style: 'display:inline;margin-left:8px;' }, ['disabled']) : null,
        ],
        [
          `${m.provider ?? '—'} · ${m.model ?? '—'}${m.baseUrl ? ` · ${m.baseUrl}` : ''}${m.hasCredential ? ' · key set' : ''}`,
        ],
        [
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
    );
  }

  // -- add form --
  const fLabel = input({ placeholder: 'work-laptop' });
  const fProvider = el('select', { class: 'input' }, [
    el('option', { value: 'anthropic' }, ['Anthropic']),
    el('option', { value: 'openai' }, ['OpenAI-compatible']),
    el('option', { value: 'mock' }, ['Mock']),
  ]);
  const fModel = input({ placeholder: 'claude-sonnet-5' });
  const fBase = input({ placeholder: 'https://… (optional)' });
  const fKey = input({ placeholder: 'stored in the vault, never echoed', type: 'password' });
  const addBtn = el('button', { class: 'btn btn-primary btn-sm' }, ['Add preset']);
  addBtn.onclick = async () => {
    const payload = { label: fLabel.value.trim(), provider: fProvider.value, model: fModel.value.trim() };
    if (fBase.value.trim()) payload.baseUrl = fBase.value.trim();
    if (fKey.value) payload.apiKey = fKey.value;
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
    }
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
  { id: 'models', label: 'Models', render: (body) => void modelsPane(body) },
  { id: 'agents', label: 'Agents', render: (body) => void agentsPane(body) },
  { id: 'mcp', label: 'MCP', render: (body) => void mcpPane(body) },
  { id: 'projects', label: 'Projects', render: (body, ctx) => void projectsPane(body, ctx) },
];

/**
 * Open the settings modal. Returns a close() handle; Escape and the backdrop close it too.
 * `ctx.onProjectsChanged` fires when the allowlist changes so the sidebar re-renders.
 */
export function openSettings(ctx = {}) {
  const pane = el('div', { class: 'set-pane scroll' }, []);
  const nav = el('div', { class: 'set-nav' }, []);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
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
      el('div', { class: 'modal set' }, [
        el('div', { class: 'set-grid' }, [
          nav,
          el('div', { style: 'display:flex;flex-direction:column;min-width:0;min-height:0;' }, [
            el('div', { class: 'modal-head' }, [
              el('span', { class: 't' }, ['Settings']),
              el('button', { class: 'icon-btn', title: 'Close', onClick: () => close() }, ['✕']),
            ]),
            pane,
          ]),
        ]),
      ]),
    ],
  );

  const show = (id) => {
    for (const b of [...nav.children]) b.classList.toggle('is-active', b.dataset.id === id);
    PANES.find((p) => p.id === id)?.render(pane, ctx);
  };
  for (const p of PANES) {
    const b = el('button', { class: 'set-item', dataset: { id: p.id } }, [p.label]);
    b.onclick = () => show(p.id);
    nav.append(b);
  }

  document.addEventListener('keydown', onKey);
  document.body.append(mask);
  show('general');
  return { close };
}
