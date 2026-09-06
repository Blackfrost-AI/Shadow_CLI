/**
 * The Endpoints pane of the settings modal — the console's reachability harness. The browser
 * runs under CSP `connect-src 'self'`, so it can never touch a LAN/external URL itself; every
 * probe goes through the server (/api/endpoints/*, which flows through the shadowFetch egress
 * chokepoint) and comes back as non-secret facts: reachable? latency? served models? backend?
 *
 * Three discovery modes share one results list:
 *   • Pinned hosts (PERMANENT): a host whose PORT may change. On pane entry — and on "Resolve" —
 *     the server's doctor probes it across the inference-port allowlist and reports whatever is
 *     running right now. ("Always select what's running on that box.")
 *   • Manual probe: type any base URL (or click a quick-pick) and probe it.
 *   • LAN scan (opt-in): enumerate private /24s on known inference ports, bounded.
 *
 * "Use as active" reuses the ONLY config-write path (POST /api/models then PATCH default) — no
 * new write API, and promotion is always an explicit click.
 *
 * Complements the Models pane's per-preset tests (Test endpoint / Test response): those verify a
 * SAVED preset; this pane DISCOVERS and pins endpoints before they exist.
 */

import { el } from './dom.js';
import { getJson, postJson, patchJson, del } from './api.js';
import { toast, confirmDialog } from './ui.js';

const LATENCY_OK = 150;
const LATENCY_WARN = 500;

function latencyTag(ms) {
  if (typeof ms !== 'number') return { cls: 'error', text: '?' };
  const cls = ms < LATENCY_OK ? 'ok' : ms < LATENCY_WARN ? 'warn' : 'error';
  return { cls, text: `${ms} ms` };
}

function ctxLabel(n) {
  if (!n) return '';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Normalize a probe result's model list to [{id, contextWindow?}] whichever field came back. */
function servedList(r) {
  if (r && Array.isArray(r.models) && r.models.length) return r.models;
  if (r && Array.isArray(r.servedModels) && r.servedModels.length) return r.servedModels.map((id) => ({ id }));
  return [];
}

function servedText(r) {
  const list = servedList(r);
  if (!list.length) return 'reachable — no model list returned';
  return list
    .slice(0, 6)
    .map((m) => (m.contextWindow ? `${m.id} (${ctxLabel(m.contextWindow)})` : m.id))
    .join(', ');
}

function hostPortLabel(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `endpoint-${u.hostname}-${port}`;
  } catch {
    return `endpoint-${Date.now()}`;
  }
}

export async function endpointsPane(body) {
  body.replaceChildren();
  let cancelled = false;

  const S = {
    quickpicks: [],
    known: [], // [{host,label?,ports?}]
    knownResolved: {}, // host -> {loading, result}
    results: [], // [{origin, baseUrl, r}]
    scanning: false,
  };

  // A status line styled like the Models pane's probe result (data-state drives the color).
  const status = el('div', { class: 'model-probe-result', role: 'status', 'aria-live': 'polite', hidden: true }, []);
  const say = (text, state) => {
    status.hidden = !text;
    status.dataset.state = state ?? 'pending';
    status.textContent = text ?? '';
  };

  const knownHost = el('div', { class: 'ep-section' }, []);
  const resultsHost = el('div', { class: 'ep-section' }, []);

  const row = (nameNodes, hints, actions) =>
    el('div', { class: 'set-row' }, [
      el('div', { class: 'info' }, [
        el('div', { class: 'name' }, nameNodes.filter(Boolean)),
        ...hints.filter(Boolean).map((h) => el('div', { class: 'hint' }, [h])),
      ]),
      el('div', { style: 'display:flex;gap:6px;flex:none;align-items:center;' }, actions.filter(Boolean)),
    ]);

  const action = (labelText, onClick, { danger: isDanger = false, primary = false } = {}) => {
    const btn = el('button', { class: `btn btn-sm ${isDanger ? 'btn-danger' : primary ? 'btn-primary' : 'btn-ghost'}` }, [labelText]);
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

  // ── use as active: the only config-write path (POST /api/models → PATCH default) ──
  async function useAsActive(baseUrl, models) {
    const ids = (models || []).map((m) => m.id).filter(Boolean);
    let modelId = ids[0];
    if (!modelId) {
      modelId = window.prompt('No served models were listed for this endpoint. Enter the model id to use:');
      if (!modelId) return;
      modelId = modelId.trim();
      if (!modelId) return;
    }
    const label = hostPortLabel(baseUrl);
    try {
      const snap = await getJson('/api/models');
      const existing = (snap.models || []).find((m) => m.baseUrl === baseUrl);
      if (existing) {
        await patchJson(`/api/models/${encodeURIComponent(existing.label)}`, { action: 'default' });
      } else {
        try {
          await postJson('/api/models', { label, provider: 'openai', model: modelId, baseUrl, selfHosted: true });
          await patchJson(`/api/models/${encodeURIComponent(label)}`, { action: 'default' });
        } catch (e) {
          if (/409|already exists/i.test(String(e.message ?? e))) {
            await patchJson(`/api/models/${encodeURIComponent(label)}`, { action: 'default' });
          } else {
            throw e;
          }
        }
      }
      if (!cancelled) say(`✓ active — ${baseUrl} · ${modelId} (new sessions use it)`, 'ok');
    } catch (e) {
      if (!cancelled) say(`Could not set active: ${e.message}`, 'error');
    }
  }

  // ── pinned hosts ──────────────────────────────────────────────────────────────

  function renderKnown() {
    const kids = [
      el('h3', {}, ['Pinned endpoints']),
      el('p', { class: 'desc' }, ['Permanent hosts — the port is discovered, not remembered. Resolve probes the inference-port allowlist and reports whatever is running now.']),
    ];
    if (!S.known.length) {
      kids.push(el('p', { class: 'desc' }, ['Nothing pinned yet. Pin a self-hosted box (IP or hostname) to keep it here permanently.']));
    }
    for (const k of S.known) {
      const res = S.knownResolved[k.host] || {};
      const rr = res.result;
      const best = rr && Array.isArray(rr.alive) && rr.alive.length ? rr.alive[0] : null;
      const lat = best ? latencyTag(best.latencyMs) : null;
      const hints = [];
      if (res.loading) hints.push('resolving…');
      else if (best) hints.push(`:${best.port} · ${lat.text} · ${best.server ?? best.serverHeader ?? 'unknown backend'}`, servedText(best));
      else if (rr) hints.push(`offline — nothing serving on ${rr.tried?.length ?? 0} tried ports`);
      else hints.push('not resolved yet');
      kids.push(
        row(
          [k.host, el('span', { class: 'tag-chip', style: 'margin-left:8px;' }, ['pinned']), k.label ? el('span', { class: 'hint', style: 'display:inline;margin-left:8px;' }, [k.label]) : null],
          hints,
          [
            action(res.loading ? 'Resolving' : 'Resolve', () => resolveHostNow(k.host)),
            best ? action('Use as active', () => useAsActive(best.baseUrl, servedList(best))) : null,
            action('Unpin', async () => {
              if (!(await confirmDialog({ title: `Unpin "${k.host}"?`, body: 'It will no longer be a permanent endpoint. Nothing else changes.', danger: true, confirmLabel: 'Unpin' }))) throw new Error('cancelled');
              await unpin(k.host);
            }, { danger: true }),
          ],
        ),
      );
    }
    const pinInput = el('input', { class: 'input', placeholder: 'host or IP — e.g. 192.168.1.20 or mybox.local', spellcheck: 'false' });
    const pinBtn = action('Pin', async () => {
      const host = pinInput.value.trim();
      if (!host) {
        say('Enter a host or IP to pin.', 'error');
        return;
      }
      const res = await postJson('/api/endpoints/known', { host });
      S.known = res.known || [];
      pinInput.value = '';
      renderKnown();
      const added = S.known[S.known.length - 1];
      if (added) void resolveHostNow(added.host);
    }, { primary: true });
    pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pinBtn.click();
    });
    kids.push(el('div', { class: 'set-form-row', style: 'margin-top:8px;max-width:520px;' }, [el('div', { class: 'field' }, [pinInput]), pinBtn]));
    knownHost.replaceChildren(...kids);
  }

  async function resolveHostNow(host) {
    S.knownResolved[host] = { loading: true };
    renderKnown();
    try {
      const result = await postJson('/api/endpoints/resolve', { host });
      if (cancelled) return;
      S.knownResolved[host] = { loading: false, result };
    } catch (e) {
      if (cancelled) return;
      S.knownResolved[host] = { loading: false, result: { alive: [] } };
      say(`Resolve failed for ${host}: ${e.message}`, 'error');
    }
    renderKnown();
  }

  async function unpin(host) {
    const res = await del(`/api/endpoints/known/${encodeURIComponent(host)}`);
    if (cancelled) return;
    S.known = res.known || [];
    delete S.knownResolved[host];
    renderKnown();
  }

  // ── results (probe + scan hits) ───────────────────────────────────────────────

  function renderResults() {
    const kids = [el('h3', { style: 'margin-top:24px;' }, ['Results'])];
    if (!S.results.length) {
      kids.push(el('p', { class: 'desc' }, ['Probe a URL, click a quick-pick, or scan — results land here.']));
    }
    for (const { origin, baseUrl, r } of S.results) {
      const ok = !!r?.ok;
      const needsKey = r?.errorKind === 'auth-required';
      const lat = ok ? latencyTag(r.latencyMs) : null;
      kids.push(
        row(
          [
            ok ? '✓ ' : needsKey ? '⚠ ' : '✗ ',
            baseUrl,
            origin === 'scanned' ? el('span', { class: 'tag-chip', style: 'margin-left:8px;' }, ['scanned']) : null,
            needsKey ? el('span', { class: 'tag-chip', style: 'margin-left:8px;' }, ['needs key']) : null,
          ],
          ok
            ? [`${lat.text} · ${r.server ?? r.serverHeader ?? 'unknown backend'}${r.reached ? ` · answered ${r.reached}` : ''}`, servedText(r)]
            : [`${r?.errorKind ?? 'error'} — ${r?.error ?? 'unreachable'}`],
          ok ? [action('Use as active', () => useAsActive(baseUrl, servedList(r)), { primary: true })] : [],
        ),
      );
    }
    resultsHost.replaceChildren(...kids);
  }

  // ── probe + scan ──────────────────────────────────────────────────────────────

  const urlInput = el('input', { class: 'input', placeholder: 'base url — e.g. http://192.168.1.20:8000/v1', type: 'url', spellcheck: 'false' });
  async function doProbe() {
    const baseUrl = urlInput.value.trim();
    if (!baseUrl) {
      say('Enter a base URL to probe.', 'error');
      return;
    }
    say(`Probing ${baseUrl}…`, 'pending');
    try {
      const r = await postJson('/api/endpoints/probe', { baseUrl });
      if (cancelled) return;
      S.results.unshift({ origin: 'probe', baseUrl, r });
      renderResults();
      say(r.ok ? `✓ ${baseUrl} reachable in ${r.latencyMs ?? '?'} ms` : `✗ ${baseUrl}: ${r.errorKind ?? 'unreachable'}`, r.ok ? 'ok' : 'error');
    } catch (e) {
      if (!cancelled) say(`Probe failed: ${e.message}`, 'error');
    }
  }
  const probeBtn = action('Probe', doProbe, { primary: true });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') probeBtn.click();
  });

  const chips = el('div', { class: 'ep-chips' }, []);

  const scanBtn = action('Scan local network', async () => {
    if (S.scanning) return;
    S.scanning = true;
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
    say('Probing private subnets on known inference ports…', 'pending');
    try {
      const res = await postJson('/api/endpoints/scan', {});
      if (cancelled) return;
      const hits = Array.isArray(res.results) ? res.results : [];
      for (const hit of hits) S.results.unshift({ origin: 'scanned', baseUrl: hit.baseUrl, r: hit });
      renderResults();
      const subnets = (res.subnets || []).map((s) => s.cidr).join(', ') || 'none';
      say(
        hits.length
          ? `Found ${hits.length} live endpoint(s) on ${subnets}${res.truncated ? ' (host cap reached)' : ''}`
          : `No live endpoints on ${subnets}. (Scan is opt-in, private subnets only, known inference ports.)`,
        hits.length ? 'ok' : 'pending',
      );
    } catch (e) {
      if (!cancelled) say(`Scan failed: ${e.message}`, 'error');
    } finally {
      if (!cancelled) {
        S.scanning = false;
        scanBtn.disabled = false;
        scanBtn.textContent = 'Scan local network';
      }
    }
  });

  body.append(
    el('h3', {}, ['Endpoints']),
    el('p', { class: 'desc' }, ['Discover and verify API + self-hosted inference servers. All probing runs server-side through the egress broker — the browser never leaves this origin, and nothing leaves this machine.']),
    status,
    knownHost,
    el('h3', { style: 'margin-top:24px;' }, ['Probe an endpoint']),
    el('div', { class: 'set-form-row', style: 'max-width:520px;' }, [el('div', { class: 'field' }, [urlInput]), probeBtn]),
    chips,
    el('h3', { style: 'margin-top:24px;' }, ['Discover on your network']),
    el('p', { class: 'desc' }, ['Opt-in · private subnets only · known inference ports (8000, 8080, 11434, 1234, 30000, …) · bounded by host cap and deadline.']),
    el('div', { class: 'set-form-row' }, [scanBtn]),
    resultsHost,
  );

  renderKnown();
  renderResults();

  // ── initial load: quick-picks + pinned hosts (auto-resolve = "select what's running") ──
  try {
    const [qp, kn] = await Promise.all([
      getJson('/api/endpoints/quickpicks').catch(() => ({ quickpicks: [] })),
      getJson('/api/endpoints/known').catch(() => ({ known: [] })),
    ]);
    if (cancelled) return;
    S.quickpicks = qp.quickpicks || [];
    S.known = kn.known || [];
    chips.replaceChildren(
      ...S.quickpicks.map((q) => {
        const b = el('button', { class: 'btn btn-sm btn-ghost', title: q.baseUrl }, [q.name]);
        b.onclick = () => {
          urlInput.value = q.baseUrl;
          void doProbe();
        };
        return b;
      }),
    );
    renderKnown();
    for (const k of S.known) void resolveHostNow(k.host);
  } catch (e) {
    if (!cancelled) say(`Failed to load: ${e.message}`, 'error');
  }
}
