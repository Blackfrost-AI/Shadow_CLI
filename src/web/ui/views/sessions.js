import { el, mount } from '../dom.js';
import { getJson, postJson } from '../api.js';
import { viewShell, blockHead, statusDot, statusBadge, reason } from '../parts.js';
import { refreshRail } from '../rail.js';

/**
 * The session workspace: allowlisted projects as cards, the web sessions inside each, and the
 * controls to add a project, spin up a session in one, and remove a project. Clicking a session
 * opens its console — a plain `#/s/<id>` hash change, so a fresh chat view (and transcript store)
 * mounts with no splice between sessions. The Terminal mirror lives in the rail, not here.
 */

export function sessionsView(host) {
  let cancelled = false;
  let toastTimer = null;

  const open = (id) => {
    window.location.hash = `#/s/${id}`;
  };

  // The refusal line reads "✕ <reason>" (design line 398); the ✕ is a node, not part of the text,
  // so the .add-err flex row keeps its 6px gap. Passing '' clears it.
  const setErr = (node, msg) => (msg ? node.replaceChildren(el('span', {}, ['✕']), msg) : node.replaceChildren());

  async function loadData() {
    const [p, s] = await Promise.all([getJson('/api/projects'), getJson('/api/sessions')]);
    return { projects: p.projects ?? [], sessions: s.sessions ?? [] };
  }

  async function load() {
    if (cancelled) return;
    let data;
    try {
      data = await loadData();
    } catch (e) {
      mount(host, [viewShell(blockHead('Workspace'), [el('p', { class: 'error' }, [`Failed to load: ${String(e)}`])])]);
      return;
    }
    if (!cancelled) render(data.projects, data.sessions);
  }

  async function addProject(path, field, errEl) {
    setErr(errEl, '');
    field.classList.remove('err');
    if (!path) {
      setErr(errEl, 'enter a path');
      field.classList.add('err');
      return;
    }
    try {
      await postJson('/api/projects', { path });
      refreshRail();
      await load();
    } catch (e) {
      setErr(errEl, reason(e));
      field.classList.add('err');
    }
  }

  async function removeProject(id, errEl) {
    try {
      await postJson('/api/projects/remove', { id });
      refreshRail();
      await load();
    } catch (e) {
      if (errEl) errEl.textContent = reason(e);
    }
  }

  async function newSession(project, errEl) {
    errEl.textContent = '';
    try {
      const { id } = await postJson('/api/sessions', { projectRoot: project.path });
      refreshRail();
      // Show the "created" toast, then hand off to the console. The short delay lets the toast
      // register before this view unmounts on the hash change.
      showToast(project.label || project.path);
      toastTimer = setTimeout(() => open(id), 650);
    } catch (e) {
      errEl.textContent = reason(e);
    }
  }

  function showToast(where) {
    const t = el('div', { class: 'toast' }, [el('span', { class: 'ok' }, ['✓']), `Session created in ${where} — opening console…`]);
    const inner = host.querySelector('.view-inner');
    if (inner) inner.append(t);
  }

  function sessionRow(s) {
    const meta = `${s.model ?? '—'} · ${s.autonomy ?? '—'} · ${s.clients ?? 0} viewing`;
    const row = el('div', { class: 'ws-sess', role: 'button', tabindex: '0' }, [
      statusDot(s.status),
      el('span', { style: 'min-width:0' }, [
        el('span', { style: 'font-weight:500' }, [s.title || 'untitled']), ' ',
        el('span', { class: 'id' }, [s.id.slice(0, 8)]),
      ]),
      statusBadge(s.status),
      ...(s.lastError ? [el('span', { class: 'err' }, [s.lastError])] : []),
      el('span', { class: 'meta' }, [meta]),
    ]);
    row.addEventListener('click', () => open(s.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(s.id);
      }
    });
    return row;
  }

  function projectCard(p, sessions) {
    const err = el('span', { class: 'err', style: 'font-size:11px' }, ['']);
    const newBtn = el('button', { class: 'btn-mini', title: 'create a session here' }, ['+ new session']);
    const removeBtn = el('button', { class: 'btn-mini danger' }, ['remove']);
    newBtn.addEventListener('click', () => newSession(p, err));
    removeBtn.addEventListener('click', () => removeProject(p.id, err));

    const cardHead = el('div', { class: 'proj-card-head' }, [
      el('span', { class: 'muted' }, ['▤']),
      el('span', { class: 'label' }, [p.label || p.path]),
      el('span', { class: 'path' }, [p.path]),
      el('span', { class: 'acts' }, [newBtn, removeBtn, err]),
    ]);
    const rows = sessions.length
      ? sessions.map(sessionRow)
      : [el('div', { class: 'ws-empty' }, ['no sessions yet — start one with “+ new session”'])];
    return el('div', { class: 'proj-card' }, [cardHead, ...rows]);
  }

  function render(projects, sessions) {
    const web = sessions.filter((s) => s.origin === 'web');

    const addErr = el('div', { class: 'add-err' }, []);
    const field = el('input', { class: 'field', type: 'text', placeholder: '/path/to/project' });
    const addBtn = el('button', { class: 'btn primary' }, ['Add project']);
    addBtn.addEventListener('click', () => addProject(field.value.trim(), field, addErr));
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addProject(field.value.trim(), field, addErr);
    });

    const cards = projects.map((p) => projectCard(p, web.filter((s) => s.displayPath === p.path)));

    const body = [
      el('div', { class: 'add-project' }, [field, addBtn]),
      addErr,
      ...(cards.length
        ? [el('div', { class: 'stack' }, cards)]
        : [el('p', { class: 'muted' }, ['No projects on the allowlist yet — add one above to create sessions in it.'])]),
    ];
    mount(host, [viewShell(
      blockHead('Workspace', 'Projects are an explicit allowlist — a session can only run in a directory you added on purpose.'),
      body,
    )]);
  }

  void load();
  return () => {
    cancelled = true;
    if (toastTimer) clearTimeout(toastTimer);
  };
}
