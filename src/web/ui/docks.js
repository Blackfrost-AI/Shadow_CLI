/**
 * The docks: the strips that sit between the transcript and the composer. Rendered from the
 * session model on every notify, but only when their inputs actually changed (a cheap JSON
 * fingerprint per dock) — so a text delta never rebuilds an open approval strip.
 *
 *   approval dock — the amber strip: tool, reason, arg digest, preview, Reject / Allow once /
 *                   Allow for this session (or a single Acknowledge for informational asks)
 *   question dock — the composer for user_question asks: multi-select options with
 *                   descriptions, custom-answer input, Submit
 *   todo dock     — the live task list
 *   queue dock    — prompts typed while the turn runs, in order, individually removable
 */

import { el } from './dom.js';
import { toast } from './ui.js';

/**
 * @param {Element} host  mounts the docks here, in order
 * @param {Object} model  the session model
 * @param {Object} actions
 *   decide(approvalId, 'approve'|'deny'|'session')
 *   answerQuestions(approvalId, answers) — answers: [{ question, selected }]
 *   unqueue(i)
 */
export function createDocks(host, model, actions) {
  let prints = { approvals: '', todo: '', queue: '' };

  // ---- approval dock --------------------------------------------------------------
  const approvalDock = () => {
    const asks = model.snapshot().approvals;
    if (!asks.length) return null;

    return el(
      'div',
      { class: 'dock dock-approve' },
      asks.map((ask) => {
        const isQuestion = ask.kind === 'user_question' && ask.questions?.length;
        const inner = el('div', { class: 'dock-inner' }, [
          el('div', { class: 'dock-title' }, [
            isQuestion ? '✋ Question' : ask.acknowledgeOnly ? 'ℹ Notice' : '⚠ Approval needed',
            el('span', { class: 'n' }, [ask.tool]),
          ]),
          el('div', { class: 'why' }, [
            el('strong', {}, [ask.reason || (isQuestion ? 'The agent needs your input.' : 'This action is gated.')]),
          ]),
          ask.argHint ? el('div', { class: 'why' }, [el('code', {}, [ask.argHint])]) : null,
          ask.preview
            ? el('pre', { class: 'scroll', style: 'max-height:180px;overflow:auto;margin:0;font:var(--sw-f-md-code-sm);background:var(--sw-bg-layer-1);border:1px solid var(--sw-border-2);border-radius:8px;padding:8px 10px;white-space:pre-wrap;' }, [ask.preview])
            : null,
        ]);
        if (isQuestion) inner.append(questionComposer(ask, actions));
        else inner.append(approvalActions(ask, actions));
        return el('div', { class: 'dock' , style: 'margin:0;padding:0;max-width:none;width:100%;' }, [inner]);
      }),
    );
  };

  const approvalActions = (ask, actions) =>
    el('div', { class: 'dock-actions' }, [
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          onClick: () => actions.decide(ask.id, 'deny'),
        },
        [ask.acknowledgeOnly ? 'Dismiss' : 'Reject'],
      ),
      ask.acknowledgeOnly
        ? null
        : el(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              onClick: () => actions.decide(ask.id, 'session'),
            },
            ['Allow for this session'],
          ),
      el(
        'button',
        {
          class: 'btn btn-primary btn-sm',
          onClick: () => actions.decide(ask.id, ask.acknowledgeOnly ? 'deny' : 'approve'),
        },
        [ask.acknowledgeOnly ? 'Acknowledge' : 'Allow once'],
      ),
    ]);

  const questionComposer = (ask, actions) => {
    const answers = new Map(); // question → Set(selected labels)
    const customs = new Map(); // question → custom text

    const submit = () => {
      const payload = (ask.questions ?? []).map((q) => ({
        question: q.question,
        selected: [...(answers.get(q.question) ?? []), ...(customs.get(q.question) ? [customs.get(q.question)] : [])],
      }));
      if (payload.some((p) => p.selected.length === 0)) {
        toast('pick an option (or write a custom answer) for every question', { kind: 'error' });
        return;
      }
      actions.answerQuestions(ask.id, payload);
    };

    const blocks = (ask.questions ?? []).map((q) => {
      const selected = new Set();
      answers.set(q.question, selected);
      const opts = (q.options ?? []).map((o) => {
        const box = el('span', { class: 'box' }, ['✓']);
        const row = el(
          'button',
          {
            class: 'q-opt',
            onClick: () => {
              if (q.multiSelect) {
                if (selected.has(o.label)) selected.delete(o.label);
                else selected.add(o.label);
              } else {
                selected.clear();
                selected.add(o.label);
                // single-select: reflect immediately
                for (const b of optRows) b.classList.toggle('is-selected', b.dataset.label === o.label);
                return;
              }
              row.classList.toggle('is-selected', selected.has(o.label));
            },
          },
          [
            box,
            el('span', {}, [o.label]),
            o.description ? el('span', { style: 'font:var(--sw-f-xxs);color:var(--sw-t-caption);margin-left:auto;padding-left:12px;text-align:right;' }, [o.description]) : null,
          ],
        );
        row.dataset.label = o.label;
        return row;
      });
      const optRows = opts;
      const custom = el('input', {
        class: 'input q-custom',
        placeholder: 'Custom answer…',
        onkeydown: (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            customs.set(q.question, ev.target.value.trim());
            submit();
          }
        },
        oninput: (ev) => customs.set(q.question, ev.target.value.trim()),
      });
      return el('div', { class: 'q-block', style: 'display:flex;flex-direction:column;gap:6px;' }, [
        el('div', { class: 'q' }, [q.question]),
        el('div', { class: 'q-opts' }, opts),
        (q.options?.length ?? 0) > 1 || q.multiSelect ? custom : null,
      ]);
    });

    return el('div', { class: 'q-blocks', style: 'display:flex;flex-direction:column;gap:12px;' }, [
      ...blocks,
      el('div', { class: 'dock-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', onClick: submit }, ['Submit']),
      ]),
    ]);
  };

  // ---- todo dock --------------------------------------------------------------------
  const todoDock = () => {
    const items = model.snapshot().todo;
    if (!items?.length) return null;
    return el('div', { class: 'dock dock-todo' }, [
      el('div', { class: 'dock-inner' }, [
        el('div', { class: 'dock-title' }, ['Tasks', el('span', { class: 'n' }, [`${items.filter((i) => i.status === 'completed').length}/${items.length}`])]),
        ...items.map((it) =>
          el('div', { class: 'todo-item' + (it.status === 'completed' ? ' is-done' : it.status === 'in_progress' ? ' is-active' : '') }, [
            el('span', { class: 'todo-box' }, [it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '●' : '']),
            el('span', { style: 'min-width:0;' }, [
              it.subject,
              it.description ? el('div', { style: 'font:var(--sw-f-xxs);color:var(--sw-t-caption);' }, [it.description]) : null,
            ]),
          ]),
        ),
      ]),
    ]);
  };

  // ---- queue dock ---------------------------------------------------------------------
  const queueDock = () => {
    const q = model.snapshot().queue;
    if (!q.length) return null;
    return el('div', { class: 'dock dock-queue' }, [
      el('div', { class: 'dock-inner' }, [
        el('div', { class: 'dock-title' }, ['Queued', el('span', { class: 'n' }, [String(q.length)])]),
        ...q.map((item, i) =>
          el('div', { class: 'q-item' }, [
            el('span', { class: 'glyph', style: 'color:var(--sw-t-caption);' }, ['↩']),
            el('span', { class: 'preview' }, [item.text]),
            el('button', { class: 'icon-btn sm', onClick: () => actions.unqueue(i) }, ['✕']),
          ]),
        ),
      ]),
    ]);
  };

  const refresh = () => {
    const s = model.snapshot();
    const next = {
      approvals: JSON.stringify(s.approvals.map((a) => [a.id, a.receivedAt])),
      todo: JSON.stringify(s.todo),
      queue: JSON.stringify(s.queue),
    };
    const approvalChange = next.approvals !== prints.approvals;
    const todoChange = next.todo !== prints.todo;
    const queueChange = next.queue !== prints.queue;
    if (!approvalChange && !todoChange && !queueChange) return;
    prints = next;

    // Order: approvals (most urgent; questions render inside it) → todo → queue.
    const kids = [];
    const a = approvalDock();
    if (a) kids.push(a);
    const t = todoDock();
    if (t) kids.push(t);
    const q = queueDock();
    if (q) kids.push(q);
    host.replaceChildren(...kids);
  };

  refresh();
  return { refresh };
}
