/**
 * Browser-based SECURE onboarding — the "HTML window" onboarding for a CLI.
 *
 * Spins up an EPHEMERAL loopback HTTP server, opens the browser to a self-contained form (no external
 * resources — a strict CSP blocks any outbound request, so a compromised page can't exfiltrate a key),
 * collects provider / API key / endpoint + a MASTER PASSWORD, and seals the secrets into the encrypted
 * vault (`createVault` → AES-256-GCM). The derived key is then cached in the OS keychain (where one
 * exists) so the password is typed once. Non-secret prefs (provider / model / baseUrl) go to config.json.
 *
 * Security model (same as an OAuth loopback flow): bind to 127.0.0.1 ONLY, a one-time token guards
 * /save, the server dies on completion or a 5-minute idle timeout. Keys never leave the machine.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  createVault,
  vaultExists,
  unlockWithKey,
  unlockWithPassword,
  saveSecrets,
  type VaultData,
} from '../auth/vault.js';
import { storeKey, retrieveKey, available as keychainAvailable } from '../auth/keychain.js';
import { saveGlobalConfig } from '../state/globalStore.js';

export interface PersistResult {
  /** true = added to an existing vault; false = a new vault was created. */
  merged: boolean;
  /** true = derived key is cached in the OS keychain. */
  cached: boolean;
}

/**
 * Seal one provider's key into the vault — MERGING into an existing vault (so multiple providers can
 * coexist) rather than overwriting it. On an existing vault it unlocks via the keychain-cached key, else
 * the supplied master password; on no vault it creates one (password required, min 8). Exported for tests.
 * Throws Error('need-password') / Error('bad-password') / Error('weak-password') for the caller to map.
 */
export function persistOnboardSecret(input: {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  password?: string;
}): PersistResult {
  const entry = { apiKey: input.apiKey, kind: 'apiKey' as const };
  if (vaultExists()) {
    // Merge — unlock, add/replace this provider, re-seal with the SAME key (keeps other providers).
    let data: VaultData | undefined;
    let key: Buffer | undefined;
    const cachedB64 = retrieveKey();
    if (cachedB64) {
      try {
        const k = Buffer.from(cachedB64, 'base64');
        data = unlockWithKey(k);
        key = k;
      } catch {
        /* stale cache — fall through to the password */
      }
    }
    if (!data || !key) {
      if (!input.password) throw new Error('need-password');
      try {
        const r = unlockWithPassword(input.password);
        data = r.data;
        key = r.key;
      } catch {
        throw new Error('bad-password');
      }
    }
    data[input.provider] = entry;
    saveSecrets(data, key);
    const cached = keychainAvailable() ? storeKey(key.toString('base64')) : Boolean(cachedB64);
    return { merged: true, cached };
  }
  // Fresh vault — the password sets the master password.
  if (!input.password || input.password.length < 8) throw new Error('weak-password');
  const key = createVault(input.password, { [input.provider]: entry });
  const cached = keychainAvailable() ? storeKey(key.toString('base64')) : false;
  return { merged: false, cached };
}

export interface WebOnboardResult {
  ok: boolean;
  provider?: string;
  cached?: boolean;
  /** true = added to an existing vault; false = created a new one. */
  merged?: boolean;
  reason?: string;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {
    /* the URL is printed too — the user can paste it */
  }
}

const SEC_HEADERS: Record<string, string> = {
  // Lock the page down: no network of any kind (default-src 'none'), inline style/script only, forms
  // may only POST back to us. A key entered here physically cannot be sent anywhere but loopback.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; connect-src 'self'; img-src data:; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** The self-contained onboarding page (dark, Shadow-branded; inline CSS+JS; token embedded). Exported
 *  for tests (verifies it embeds the token and makes NO external requests — CSP/offline-safe). */
export function page(token: string, hasVault = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shadow — secure setup</title>
<style>
 :root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--dim:#8b949e;--accent:#d97757;--cyan:#38dbf5;--line:#30363d}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
 .card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
 h1{margin:0 0 4px;font-size:20px}h1 span{color:var(--accent)}
 p.sub{margin:0 0 20px;color:var(--dim);font-size:13px}
 label{display:block;margin:14px 0 5px;font-size:13px;color:var(--dim)}
 input,select{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:14px}
 input:focus,select:focus{outline:none;border-color:var(--cyan)}
 button{width:100%;margin-top:22px;padding:12px;background:var(--accent);border:none;border-radius:8px;color:#0d1117;font-weight:700;font-size:15px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 .note{margin-top:16px;font-size:12px;color:var(--dim);text-align:center}
 .msg{margin-top:14px;padding:10px;border-radius:8px;font-size:13px;display:none}
 .ok{background:#1a3326;color:#4ade80;display:block}.err{background:#3a1e1e;color:#f87171;display:block}
 .row{display:flex;gap:10px}.row>div{flex:1}
</style></head><body>
<div class="card">
 <h1>THE <span>SHADOW</span> vault</h1>
 <p class="sub">${hasVault ? 'This machine already has a vault — add another provider to it. Your existing keys are kept.' : 'Your keys are encrypted at rest with a master password and never leave this machine.'}</p>
 <form id="f" autocomplete="off">
  <label>Provider</label>
  <select id="provider">
   <option value="anthropic" data-p="anthropic" data-url="">Anthropic</option>
   <option value="openai" data-p="openai" data-url="">OpenAI</option>
   <option value="openrouter" data-p="openai" data-url="https://openrouter.ai/api/v1">OpenRouter</option>
   <option value="groq" data-p="openai" data-url="https://api.groq.com/openai/v1">Groq</option>
   <option value="deepseek" data-p="openai" data-url="https://api.deepseek.com/v1">DeepSeek</option>
   <option value="mistral" data-p="openai" data-url="https://api.mistral.ai/v1">Mistral</option>
   <option value="xai" data-p="openai" data-url="https://api.x.ai/v1">xAI (Grok)</option>
   <option value="together" data-p="openai" data-url="https://api.together.xyz/v1">Together</option>
   <option value="zai" data-p="openai" data-url="https://api.z.ai/api/coding/paas/v4">Z.ai (GLM Coding Plan)</option>
   <option value="ollama" data-p="openai" data-url="http://localhost:11434/v1">Ollama (local)</option>
   <option value="lmstudio" data-p="openai" data-url="http://localhost:1234/v1">LM Studio (local)</option>
   <option value="custom" data-p="openai" data-url="">Custom / self-hosted</option>
  </select>
  <label>API key <span style="color:var(--dim)">(local endpoints: any value, e.g. sk-local)</span></label>
  <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off">
  <label>Base URL <span style="color:var(--dim)">(auto-filled; edit for custom)</span></label>
  <input id="baseUrl" type="text" placeholder="(provider default)">
  <label>Model <span style="color:var(--dim)">(optional)</span></label>
  <input id="model" type="text" placeholder="e.g. claude-opus-4-8">
  ${
    hasVault
      ? `<label>Master password <span style="color:var(--dim)">(to unlock — leave blank if cached in your keychain)</span></label>
  <input id="pw" type="password" placeholder="unlock existing vault" autocomplete="off">`
      : `<div class="row">
   <div><label>Master password</label><input id="pw" type="password" placeholder="min 8 chars"></div>
   <div><label>Confirm</label><input id="pw2" type="password" placeholder="repeat"></div>
  </div>`
  }
  <button id="go" type="submit">${hasVault ? 'Unlock &amp; add' : 'Encrypt &amp; save'}</button>
  <div id="msg" class="msg"></div>
  <p class="note">Nothing is transmitted — this page only talks to Shadow on your own machine.</p>
 </form>
</div>
<script>
 var TOKEN=${JSON.stringify(token)};
 var HASVAULT=${JSON.stringify(hasVault)};
 var sel=document.getElementById('provider'),base=document.getElementById('baseUrl');
 function fill(){var o=sel.options[sel.selectedIndex];base.value=o.getAttribute('data-url')||'';}
 sel.addEventListener('change',fill);fill();
 var msg=document.getElementById('msg');
 document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var o=sel.options[sel.selectedIndex];
  var pw=document.getElementById('pw').value;
  var pw2el=document.getElementById('pw2');var pw2=pw2el?pw2el.value:'';
  msg.className='msg';
  if(!HASVAULT){
   if(pw.length<8){msg.className='msg err';msg.textContent='Master password must be at least 8 characters.';return;}
   if(pw!==pw2){msg.className='msg err';msg.textContent='Passwords do not match.';return;}
  }
  var btn=document.getElementById('go');btn.disabled=true;btn.textContent=HASVAULT?'Unlocking…':'Encrypting…';
  fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   token:TOKEN,provider:o.getAttribute('data-p'),label:sel.value,apiKey:document.getElementById('apiKey').value,
   baseUrl:base.value.trim(),model:document.getElementById('model').value.trim(),password:pw})})
  .then(function(r){return r.json()}).then(function(d){
   if(d.ok){msg.className='msg ok';msg.textContent='✓ '+(d.merged?'Key added to your vault':'Vault created')+(d.cached?' and unlocked via your keychain':'')+'. You can close this tab and return to the terminal.';btn.textContent='Done';}
   else{msg.className='msg err';msg.textContent=d.error||'Failed to save.';btn.disabled=false;btn.textContent=HASVAULT?'Unlock & add':'Encrypt & save';}
  }).catch(function(){msg.className='msg err';msg.textContent='Could not reach Shadow (did the terminal close?).';btn.disabled=false;btn.textContent='Encrypt & save';});
 });
</script></body></html>`;
}

/** Run the browser onboarding flow; resolves once the vault is created (or the flow is abandoned). */
export async function runWebOnboard(write: (s: string) => void): Promise<WebOnboardResult> {
  return new Promise<WebOnboardResult>((resolve) => {
    const token = randomBytes(24).toString('base64url');
    let settled = false;
    const finish = (r: WebOnboardResult): void => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(r));
    };

    const server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
        res.end(page(token, vaultExists()));
        return;
      }
      if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1_000_000) req.destroy(); // no giant bodies
        });
        req.on('end', () => {
          try {
            const d = JSON.parse(body) as {
              token?: string;
              provider?: string;
              label?: string;
              apiKey?: string;
              baseUrl?: string;
              model?: string;
              password?: string;
            };
            const got = Buffer.from(d.token ?? '');
            const exp = Buffer.from(token);
            if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
              res.writeHead(403, { 'Content-Type': 'application/json', ...SEC_HEADERS });
              res.end(JSON.stringify({ ok: false, error: 'invalid session token' }));
              return;
            }
            const provider = d.provider === 'anthropic' ? 'anthropic' : 'openai';
            // Seal the key into the vault — MERGING into an existing vault so multiple providers coexist
            // (adding Z.ai no longer wipes an Anthropic key). Keyed by Shadow provider — the same shape
            // the credential resolver reads.
            let result;
            try {
              result = persistOnboardSecret({ provider, apiKey: d.apiKey ?? '', password: d.password });
            } catch (e) {
              const code = (e as Error).message;
              const msg =
                code === 'need-password'
                  ? 'This machine already has a vault — enter its master password to add this key.'
                  : code === 'bad-password'
                    ? 'Incorrect master password for your existing vault.'
                    : code === 'weak-password'
                      ? 'Master password must be at least 8 characters.'
                      : 'Could not save the key.';
              res.writeHead(400, { 'Content-Type': 'application/json', ...SEC_HEADERS });
              res.end(JSON.stringify({ ok: false, error: msg }));
              return;
            }
            // Non-secret prefs → config.json (provider / model / baseUrl). Clear lastModel: the last
            // `/model` pick otherwise OVERRIDES this freshly-onboarded provider at launch, so onboarding
            // would silently do nothing for anyone with saved presets.
            saveGlobalConfig({
              provider,
              lastModel: undefined,
              ...(d.model ? { model: d.model } : {}),
              ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
            });
            res.writeHead(200, { 'Content-Type': 'application/json', ...SEC_HEADERS });
            res.end(JSON.stringify({ ok: true, cached: result.cached, merged: result.merged }));
            finish({ ok: true, provider, cached: result.cached, merged: result.merged });
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...SEC_HEADERS });
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
        });
        return;
      }
      res.writeHead(404, SEC_HEADERS);
      res.end();
    });

    server.on('error', () => finish({ ok: false, reason: 'server error' }));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/?t=${token}`;
      write(`\nOpening secure onboarding in your browser…\n  ${url}\n`);
      write('If it does not open, paste that URL into any browser. Your keys stay on this machine.\n');
      openBrowser(url);
    });
    // Abandon after 5 minutes so a forgotten tab doesn't leave the server up.
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out (no submission in 5 minutes)' }), 5 * 60 * 1000);
    server.on('close', () => clearTimeout(timer));
  });
}
