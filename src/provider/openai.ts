/**
 * OpenAI Chat Completions adapter (`/chat/completions`, streaming). One class
 * covers OpenAI and any OpenAI-compatible endpoint (OpenRouter, Groq, xAI,
 * DeepSeek, Together, local vLLM / LM Studio) — they differ only by baseUrl and
 * key. Differences from Anthropic the mapping handles: the system prompt is a
 * first message, tool calls are `tool_calls` on an assistant message, and each
 * tool RESULT is its own `{role:'tool'}` message (the API cannot batch them).
 *
 * The SSE→ProviderEvent transform is the exported async generator `parseOpenAISSE`
 * (unit-testable, no network); the class wires fetch → line-splitter → parser.
 */
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Effort,
  type Message,
  type Provider,
  type ProviderEvent,
  type StopReason,
} from './provider.js';
import { streamWithRetry } from './stream.js';
import { sseEvents, parseSseData, nonEmptyParts } from './sse.js';
import { eventsFromOpenAICompletion } from './nonStream.js';
import { parseToolArgs } from './toolJson.js';
import { ThinkingSplitter } from '../util/thinkingTags.js';
import { isLocalBaseUrl } from '../safety/offline.js';
import type { ModelCapabilities } from '../config.js';
import { familyProfile } from '../config/familyProfiles.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly selfHosted: boolean;
  private readonly dashScope: boolean;
  // Per-endpoint stream knobs (P1A-04). A vLLM/SGLang frontier serve sends NO SSE keepalives during
  // prefill, so a big-context Qwen 3.8 Max first-token can exceed the 120s default; `idleTimeoutMs`
  // (config) / `SHADOW_IDLE_MS` (env) raise the frame for exactly that serve.
  private readonly idleTimeoutMs: number | undefined;
  private readonly firstByteTimeoutMs: number | undefined;
  private readonly streamRetries: number | undefined;
  // P1A-06: declarative capability block from the ModelEntry. Consulted FIRST by the request
  // builder — it is the user's assertion of what this exact endpoint supports, overriding any
  // id-regex guess (a vLLM `--served-model-name` alias, an open proxy reusing a Qwen alias, etc.).
  private readonly capabilities: ModelCapabilities | undefined;
  // Set once a 400 proves this endpoint rejects `tool_choice: "auto"` (a vLLM/SGLang serve without
  // the tool-parser flags). Remembered for the session so later turns build with `"none"` directly
  // instead of eating a 400 + retry every turn. Instance-scoped: it describes THIS endpoint.
  private toolChoiceUnsupported = false;
  // P2-03 (F01-05): optional params this endpoint 400-rejected and the stream ladder stripped.
  // Remembered for the session: later turns build WITHOUT them instead of eating a 400 + retry
  // every turn (same remember-for-the-session shape as toolChoiceUnsupported above).
  private readonly strippedParams = new Set<string>();
  // F06-08: reasoning round-trip mode from config ('last' default, 'none' = capture+replay off).
  private readonly reasoningRoundtrip: 'last' | 'none';

  constructor(opts: {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    selfHosted?: boolean;
    idleTimeoutMs?: number;
    firstByteTimeoutMs?: number;
    streamRetries?: number;
    capabilities?: ModelCapabilities;
    /** F06-08 cfg knob — reasoning round-trip mode ('last' default; 'none' = fully off). */
    reasoningRoundtrip?: 'last' | 'none';
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model;
    // Shadow's existing local-endpoint boundary covers loopback, mDNS and private/LAN IPs.
    // Keep this decision on the provider instance: it reflects the endpoint actually receiving
    // the request, including providers created by live model switches and fallback activation.
    this.selfHosted = opts.selfHosted === true || isLocalBaseUrl(this.baseUrl);
    this.dashScope = isDashScopeBaseUrl(this.baseUrl);
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.firstByteTimeoutMs = opts.firstByteTimeoutMs;
    this.streamRetries = opts.streamRetries;
    this.capabilities = opts.capabilities;
    this.reasoningRoundtrip = opts.reasoningRoundtrip ?? 'last';
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.model;
    const preserveReasoning = shouldPreserveProviderReasoning(model, {
      selfHosted: this.selfHosted,
      dashScope: this.dashScope,
      capabilities: this.capabilities,
      reasoningRoundtrip: this.reasoningRoundtrip,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const bodyOpts = {
      selfHosted: this.selfHosted,
      dashScope: this.dashScope,
      capabilities: this.capabilities,
      toolChoiceNone: this.toolChoiceUnsupported,
      stripParams: this.strippedParams as ReadonlySet<string>,
      reasoningRoundtrip: this.reasoningRoundtrip,
    };
    yield* streamWithRetry({
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body: buildOpenAIBody(req, model, true, bodyOpts),
      parse: (lines) => parseOpenAISSE(lines, model, preserveReasoning, this.capabilities),
      signal: req.signal,
      nonStreamBody: buildOpenAIBody(req, model, false, bodyOpts),
      parseNonStream: (obj) => eventsFromOpenAICompletion(obj, model, preserveReasoning),
      // P1A-04: per-endpoint stream knobs. A local serve on a long prefill must never hit the 120s
      // watchdog as a silent re-POST hazard; the bus knows it's self-hosted so the rescue suppresses.
      idleTimeoutMs: this.idleTimeoutMs,
      firstByteTimeoutMs: this.firstByteTimeoutMs,
      streamRetries: this.streamRetries,
      selfHosted: this.selfHosted,
      // F11-01: a serve without tool-parser flags 400s on tool_choice:auto. streamWithRetry retries
      // with "none" in-band; remember it so subsequent turns skip the 400 entirely.
      onToolChoiceUnsupported: () => { this.toolChoiceUnsupported = true; },
      // P2-03: remember a 400-rejected optional param for the rest of the session.
      onParamStripped: (param) => { this.strippedParams.add(param); },
    });
  }
}

// ── request shaping ──────────────────────────────────────────────────────────

type OAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OAIContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: { google: { thought_signature: string } };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Keep ordinary text from being reinterpreted as a multimodal control token by a model's chat
 * processor. This matters for agentic workloads because tool output routinely contains model
 * configs and templates. For example, Kimi K3's config.json contains the literal token
 * `<|kimi_image_placeholder|>`; replaying that line alongside two real image_url parts makes its
 * server count three placeholders for two images and reject the request.
 *
 * Shadow never needs to place these tokens itself: real media is represented structurally by an
 * image_url part and the server inserts its own placeholders. Escaping only the opening `<` keeps
 * the text readable to the model while preventing exact special-token matching. The neutral
 * history remains byte-for-byte unchanged.
 */
const MEDIA_CONTROL_TOKEN = /<\|[^<>\r\n]{0,128}(?:image|video|audio|media|vision)[^<>\r\n]{0,128}\|>|<(?:image|video|audio)(?:[_ -]?placeholder)?\s*>/gi;

export function escapeMultimodalControlTokens(text: string): string {
  return text.replace(MEDIA_CONTROL_TOKEN, (token) => `&lt;${token.slice(1)}`);
}

/** Map the provider-neutral Message[] into OpenAI chat messages. */
export function toOpenAIMessages(
  req: CompletionRequest,
  activeModel = req.model,
  opts: { preserveProviderReasoning?: boolean; reasoningRoundtrip?: 'last' | 'none' } = {},
): OAIMessage[] {
  const clean = escapeMultimodalControlTokens;
  const out: OAIMessage[] = [{ role: 'system', content: clean(req.system) }];

  // F06-08: reasoning replay is a CONTINUATION contract — the model needs its own preserved
  // thinking to keep the current tool-calling thread, not a replay of every turn's thinking.
  // Replaying the whole history re-sent the entire reasoning budget of every past turn each
  // request (unbounded growth on long sessions), so replay lands on the NEWEST assistant
  // message that carries reasoning for this model, and nowhere else.
  let lastReasoningIdx = -1;
  if (opts.preserveProviderReasoning && (opts.reasoningRoundtrip ?? 'last') === 'last') {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const mm = req.messages[i]!;
      const r = mm.providerReasoning;
      if (mm.role === 'assistant' && r?.text && r.model === activeModel) {
        lastReasoningIdx = i;
        break;
      }
    }
  }

  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i]!;
    if (m.role === 'system') continue; // system is prepended above; ignore embedded
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: { google: { thought_signature: string } };
      }[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += clean(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: clean(JSON.stringify(b.input ?? {})) },
            // Echo Gemini's thought_signature back, or multi-turn tool use 400s.
            ...(b.signature ? { extra_content: { google: { thought_signature: b.signature } } } : {}),
          });
        }
      }
      const assistant: Extract<OAIMessage, { role: 'assistant' }> =
        toolCalls.length > 0
          ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
          : { role: 'assistant', content: text };
      // Qwen 3.8 preserved thinking is message-level wire state. Replay it only to the exact
      // model that produced it AND only when the active endpoint advertises that contract. This
      // prevents a switch to a local/proxy preset with the same model id from receiving a
      // DashScope-only field. Do not run it through `clean`: the provider contract requires the
      // history byte-for-byte. lastReasoningIdx already encodes the preserve gate, the roundtrip
      // mode, and the exact-model match — only the newest qualifying turn replays (F06-08).
      const reasoning = m.providerReasoning;
      if (i === lastReasoningIdx && reasoning?.text) {
        if (reasoning.field === 'reasoning') assistant.reasoning = reasoning.text;
        else assistant.reasoning_content = reasoning.text;
      }
      out.push(assistant);
    } else {
      // role 'user' or 'tool'. Each tool_result becomes its own tool message;
      // text + images become a single user message. (OpenAI cannot batch tool results.)
      let text = '';
      const images: OAIContentPart[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolCallId, content: clean(b.content) });
        else if (b.type === 'text') text += clean(b.text);
        else if (b.type === 'image') images.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
      }
      if (images.length > 0) {
        // Multimodal: OpenAI/Gemini take an array of content parts (text first, then images).
        const parts: OAIContentPart[] = [];
        if (text) parts.push({ type: 'text', text });
        parts.push(...images);
        out.push({ role: 'user', content: parts });
      } else if (text) {
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

/** Reasoning models split their output budget between hidden thinking AND the answer, so a small
 *  cap returns an empty turn (all budget spent thinking). Give them generous output headroom; a
 *  larger explicit --max-output-tokens still wins via Math.max. NOTE: 64k is the OUTPUT limit on the
 *  big cloud reasoners (gpt-5/o, Gemini, Grok) but equals the TOTAL context window on some small
 *  local/OpenRouter reasoners (e.g. deepseek-r1 @ 64k) — there this floor overflows the window. The
 *  stream layer catches that 400 and shrinks max_tokens on retry (see looksLikeTokenOverflow), so the
 *  floor stays generous without making small-window models fail on their first turn. */
const REASONING_MAX_TOKENS = 64_000;
/** Qwen 3.8 Max maps its highest reasoning tier to a 262,144-token thinking budget. A 64k cap
 *  can therefore end before visible content; this remains a ceiling, not a generation target. */
const QWEN38_MAX_TOKENS = 262_144;

/**
 * OpenAI reasoning models (GPT-5 family, o-series) reject `max_tokens` and `temperature`
 * and accept `reasoning_effort`. `gpt-5-chat` is the non-reasoning chat variant — excluded.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /(^|[-/])(gpt-5|o[1345])(\b|[-.])/i.test(model) && !/gpt-5-chat/i.test(model);
}

/** Shadow's 5-level effort → OpenAI's 3-level reasoning_effort (xhigh/max collapse to high). */
export function toReasoningEffort(effort: Effort | undefined): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}

/**
 * Grok reasoning variants that ACCEPT `reasoning_effort` (grok-3-mini, grok-4-fast-reasoning, …).
 * Deliberately narrow: plain grok-4 auto-reasons and 400s if the param is sent, so it's excluded.
 */
export function isGrokReasoningModel(model: string): boolean {
  // `fast` matches grok-4-fast-non-reasoning too — exclude the explicit non-reasoning variant.
  return /grok/i.test(model) && /(mini|reasoning|fast)/i.test(model) && !/non[-_]?reasoning/i.test(model);
}

/**
 * Gemini reasons invisibly over the OpenAI-compat endpoint but takes `max_tokens` (NOT
 * max_completion_tokens), so without a floor its hidden thinking burns the whole budget and the
 * turn returns empty on a heavy task. `gemma` (a different family) is NOT matched.
 */
export function isGeminiModel(model: string): boolean {
  return /gemini/i.test(model);
}

/** DeepSeek's reasoner (R1 / deepseek-reasoner / R1 distills). Shadow already routes its
 *  reasoning_content to the thinking channel — it just needs the budget floor too. */
export function isDeepSeekReasoner(model: string): boolean {
  // deepseek-reasoner, deepseek-r1, DeepSeek-R1-Distill-* (first), and bare R1 distills (second).
  return /deepseek[-_ ]?r(?:1|easoner)/i.test(model) || /(^|[-_/])r1[-_]?(distill|0528)/i.test(model);
}

/** Qwen's reasoners: QwQ and Qwen3 "thinking" variants. */
export function isQwenReasoner(model: string): boolean {
  return /\bqwq\b/i.test(model) || /qwen[\w.-]*think/i.test(model);
}

/** Any announced Qwen 3.8 id, including vendor-prefixed future open-weight variants. */
export function isQwen38Model(model: string): boolean {
  // A hyphen between 3 and 8 means parameter count in established ids (`Qwen3-8B`,
  // `Qwen3-80B`), not version 3.8. Require a real minor-version separator and a boundary.
  return /qwen[^\s]*3[._]8(?=$|[/_.-])/i.test(model);
}

/** Hosted DashScope Qwen 3.8 Max variants with a documented adaptive-reasoning contract. */
export function isQwen38MaxModel(model: string): boolean {
  return isQwen38Model(model) && /3[._]8[._-]?max(?:$|[/_.-])/i.test(model);
}

/**
 * Whether an endpoint/model pair supports replaying assistant `reasoning_content` on later tool
 * turns. DashScope documents this for 3.8 Max; Qwen's open-weight 3.5+ chat templates consume the
 * same historical field. Keep the self-hosted gate: a public OpenAI-compatible proxy that happens
 * to reuse a Qwen alias must not inherit model-private reasoning wire state by name alone.
 */
export function shouldPreserveQwenReasoning(
  model: string,
  opts: { selfHosted?: boolean; dashScope?: boolean; capabilities?: ModelCapabilities },
): boolean {
  // P1A-06: an explicit capability block asserting `preserveThinking` (or naming a reasoning
  // replay field) DECLARES the contract, consulted BEFORE any id-regex — required for a
  // `--served-model-name` alias whose id carries no Qwen marker.
  if (opts.capabilities?.preserveThinking === true || opts.capabilities?.reasoningField != null) return true;
  if (opts.dashScope === true && isQwen38MaxModel(model)) return true;
  if (opts.selfHosted !== true) return false;
  return isQwen38Model(model) || /qwen[^\s]*3[._]5(?=$|[/_.-])/i.test(model) || isQwenReasoner(model);
}

/** Moonshot's Kimi "thinking" variants (kimi-k2-thinking, kimi-k3-thinking-turbo, vendor-prefixed
 *  forms). A deliberately separate matcher — the Kimi and Qwen families share nothing but the
 *  word "thinking", so neither may inherit the other's wire contract by regex accident. */
export function isKimiThinkingModel(model: string): boolean {
  return /kimi[\w.-]*think/i.test(model);
}

/**
 * General reasoning-replay gate — the single entry point for the adapter's capture/replay flag.
 * Kimi thinking models carry the contract in the MODEL itself: Moonshot's tool-calling docs
 * require echoing assistant `reasoning_content` back on later turns, and the open-weight chat
 * template consumes the same field — so the id alone activates replay on any endpoint (hosted,
 * OpenRouter, local). Qwen replay stays behind its endpoint gate (shouldPreserveQwenReasoning):
 * there the field is endpoint-private, not a property of the weights.
 */
export function shouldPreserveProviderReasoning(
  model: string,
  opts: {
    selfHosted?: boolean;
    dashScope?: boolean;
    capabilities?: ModelCapabilities;
    /** F06-08 cfg knob: 'none' disables capture AND replay entirely (opt-out of the round trip). */
    reasoningRoundtrip?: 'last' | 'none';
  },
): boolean {
  if (opts.reasoningRoundtrip === 'none') return false;
  return isKimiThinkingModel(model) || shouldPreserveQwenReasoning(model, opts);
}

/**
 * Whether reasoning replay can be classified from the model id ALONE, using the same id-regex
 * family detectors the request path relies on. Groups any model whose id carries a recognized
 * reasoning marker (DeepSeek R1, Gemini, OpenAI o-series, Grok R, QwQ / Qwen*-think, Qwen 3.8,
 * the Qwen 3.5 reasoning arc, ...) into "classifiable".
 */
export function hasKnownReasoningMarker(model: string): boolean {
  return (
    isReasoningModel(model) ||
    isQwen38Model(model) ||
    /qwen[^\s]*3[._]5(?=$|[/_.-])/i.test(model) ||
    /qwq/i.test(model) ||
    /qwen[^\s]*think/i.test(model)
  );
}

/**
 * ALIAS-SAFE REASONING REPLAY diagnostic (P1A-10).
 *
 * A self-hosted `--served-model-name` endpoint can present an arbitrary alias whose id carries NO
 * known reasoning-family marker. Shadow cannot classify such a model by id alone, so if it IS a
 * reasoning model its `reasoning_content` / `preserve_thinking` contract is ambiguous and would be
 * SILENTLY dropped on tool turns — the model would neither think out loud nor see its own prior
 * reasoning history. This is the exact hazard the user's note flags: Qwen 3.8 / 3.5 / (and per the
 * operator, 2.5) "share the same architecture/arc" but reach Shadow through aliases.
 *
 * The PRE-SET OVERRIDE is a per-model `capabilities` block (P1A-06): declaring `preserveThinking:
 * true` (or naming a `reasoningField`) pins the contract — consulting capabilities before any
 * id-regex in `shouldPreserveQwenReasoning` — and simultaneously silences this warning.
 *
 * Returns a human-readable warning to surface when the contract is alias-ambiguous, or null when
 * the contract is provably safe (a capability override is declared, the endpoint is public/canonical,
 * or the id is id-classifiable).
 */
export function assessReasoningReplayAlias(
  model: string,
  opts: { selfHosted?: boolean; dashScope?: boolean; capabilities?: ModelCapabilities } = {},
): string | null {
  // Pre-set override present → contract declared, no ambiguity, no warning.
  if (opts.capabilities?.preserveThinking === true || opts.capabilities?.reasoningField != null) return null;
  // Public / canonical endpoints are classified by their catalog; only self-hosted aliases can hide.
  if (opts.selfHosted !== true) return null;
  // Id already carries a recognized reasoning marker → classification succeeds → safe.
  if (hasKnownReasoningMarker(model)) return null;
  // P1A-10 scope (re-audited 2026-08-09): only a QWEN-looking id warrants the warning — the replay
  // contract is a Qwen-family arc, and warning on EVERY unclassifiable self-hosted id made llama/
  // mistral/gemma users read a spurious reasoning-replay warning at every startup. A fully opaque
  // `--served-model-name` alias is covered by the qwen-selfhosted preset (P1A-06 step 4) instead.
  if (!/qwen/i.test(model)) return null;
  // Alias-ambiguous: warn and point at the pre-set override that resolves it.
  return (
    `Model "${model}" is served from a self-hosted endpoint and its id matches no known ` +
    `reasoning-family marker, so reasoning replay (preserve_thinking / reasoning_content) is ` +
    `ambiguous and would be dropped if this model reasons. Pin the contract with a per-model ` +
    `capabilities block on its config entry — for a Qwen 3.8 Max serve the full contract is: ` +
    `"capabilities": { "preserveThinking": true, "reasoning": "interleaved", ` +
    `"effortScale": ["low","medium","xhigh"], "maxOutputTokens": 262144 } ` +
    `(preserveThinking alone activates replay + preserve_thinking; maxOutputTokens is what ` +
    `raises the output floor to 262k on an aliased id). Declaring it also silences this warning.`
  );
}

/** DashScope's public and workspace-scoped OpenAI-compatible endpoints. */
export function isDashScopeBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'https:' && (!u.port || u.port === '443') &&
      (/^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i.test(u.hostname) || u.hostname.endsWith('.maas.aliyuncs.com')) &&
      /\/compatible-mode\/v1\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Qwen 3.8 Max accepts low/medium/xhigh; Shadow's high/max aliases map to its maximum tier. */
export function toQwen38ReasoningEffort(effort: Effort | undefined): 'low' | 'medium' | 'xhigh' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'xhigh';
}

/**
 * Models that emit their reasoning INLINE in `content` as `<think>…</think>`, rather than on a
 * separate `reasoning_content` field.
 *
 * This gate is why it matters (C6): every `delta.content` used to be pushed through
 * ThinkingSplitter for EVERY model. So asking Shadow to document `<think>` tags, write a chat
 * template, or explain this very feature made the answer visibly truncate mid-sentence — the
 * prose after the tag was routed to the reasoning channel and lost from history, because only
 * `turn.text` is committed. Splitting is now limited to the families that actually do it.
 */
export function emitsInlineThinking(model: string): boolean {
  return isDeepSeekReasoner(model) || isQwenReasoner(model) || /minimax|glm|yi-|internlm|skywork/i.test(model);
}

/**
 * One place, every family: any model that does HIDDEN reasoning and therefore needs the output
 * budget floored so thinking can't consume it all. Replaces the scattered per-provider checks.
 */
export function isReasoningModel(model: string): boolean {
  return (
    isOpenAIReasoningModel(model) ||
    isGrokReasoningModel(model) ||
    isGeminiModel(model) ||
    isDeepSeekReasoner(model) ||
    isQwenReasoner(model)
  );
}

/** Shadow's effort ladder, ascending. Used to clamp a request onto an endpoint's declared scale. */
const EFFORT_LADDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Map a Shadow /effort onto the endpoint's DECLARED acceptance vocabulary (ascending), so a scale
 * that lacks a tier never receives it (P1A-06 AC4). Rounds UP to the nearest supported tier at or
 * above the request; a request above every declared tier uses the highest. With NO /effort dial
 * supplied, the HIGHEST declared tier is the safe default for a maximum-reasoning model. Returns
 * undefined only when the caller supplies no declared scale (the residual decision is theirs).
 */
function clampToDeclaredScale(effort: Effort | undefined, scale: readonly Effort[]): Effort | undefined {
  if (scale.length === 0) return undefined;
  const wantIdx = effort == null
    ? EFFORT_LADDER.length - 1
    : Math.max(0, EFFORT_LADDER.indexOf(effort));
  for (const tier of scale) {
    if (EFFORT_LADDER.indexOf(tier) >= wantIdx) return tier;
  }
  return scale[scale.length - 1];
}

/**
 * Resolve the wire `reasoning_effort` under P1A-06 capability rules. A DECLARED `effortScale` is
 * the endpoint's literal acceptance vocabulary → we clamp onto it and send that exact value. With
 * no declared scale we fall back to the legacy mappings (Qwen 3.8 Max 3-tier, or OpenAI 3-tier),
 * preserving byte-identical DashScope behavior.
 */
function resolveEffortWire(
  effort: Effort | undefined,
  qwenMax: boolean,
  caps: ModelCapabilities | undefined,
  familyScale?: readonly Effort[],
): string | undefined {
  if (caps?.effortScale && caps.effortScale.length > 0) {
    return clampToDeclaredScale(effort, caps.effortScale);
  }
  // Family knowledge (familyProfiles.ts effortScale — e.g. Kimi thinking's low/high/max) is the
  // same vocabulary rule one rung down: a declared capability block still outranks it.
  if (familyScale && familyScale.length > 0) {
    return clampToDeclaredScale(effort, familyScale);
  }
  return qwenMax ? toQwen38ReasoningEffort(effort) : toReasoningEffort(effort);
}

export function buildOpenAIBody(
  req: CompletionRequest,
  fallbackModel: string,
  stream = true,
  opts: {
    selfHosted?: boolean;
    dashScope?: boolean;
    capabilities?: ModelCapabilities;
    toolChoiceNone?: boolean;
    /** P2-03: params this endpoint already 400-rejected this session — stripped up-front. */
    stripParams?: ReadonlySet<string>;
    /** F06-08: reasoning round-trip mode ('last' default; 'none' = capture+replay off). */
    reasoningRoundtrip?: 'last' | 'none';
  } = {},
): Record<string, unknown> {
  const model = req.model || fallbackModel;
  const caps = opts.capabilities;
  // Model names alone are not capabilities: a local/proxy server may expose the same alias but
  // support only ordinary Chat Completions. The Qwen 3.8 Max adaptive-reasoning wire contract
  // (reasoning_effort + preserve_thinking + a 262k output floor) is activated by either a verified
  // endpoint behind the MAX id, or an EXPLICIT capability block (P1A-06 — required for a
  // `--served-model-name` alias, which carries no Qwen marker in its id).
  const verifiedQwenMax = (opts.dashScope === true || opts.selfHosted === true) && isQwen38MaxModel(model);
  // F10-06: `preserveThinking: true` ALONE declares the contract. It previously also required
  // `reasoning != null`, an undocumented coupling that produced an inconsistent wire state: the
  // replay gate (shouldPreserveQwenReasoning) accepted the lone field and replayed history, while
  // this gate rejected it and never sent `preserve_thinking` — the endpoint saw replayed thinking
  // it was never told to preserve. One declared field now yields one consistent contract.
  const declaredQwenMax = caps?.preserveThinking === true;
  const qwenMaxContract = verifiedQwenMax || declaredQwenMax;
  const isQwenMaxId = isQwen38MaxModel(model);
  const preserveReasoning = shouldPreserveProviderReasoning(model, opts);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req, model, {
      preserveProviderReasoning: preserveReasoning,
      reasoningRoundtrip: opts.reasoningRoundtrip,
    }),
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };

  // Output budget floor, resolved in precedence order:
  //   1. declared `capabilities.maxOutputTokens` (operator assertion — ALWAYS wins);
  //   2. Qwen 3.8 Max adaptive 262k thinking budget (by id or verified endpoint);
  //   3. family knowledge (familyProfiles.ts minOutputTokens — e.g. deepseek/qwen reasoners);
  //   4. the generic 64k hidden-reasoner floor.
  // This must be a CEILING, not a target: the stream layer's shrink ladder self-corrects if the
  // server's real context window is smaller (see looksLikeTokenOverflow / stream.ts).
  const family = familyProfile(model);
  const reasoningFloor =
    caps?.maxOutputTokens ??
    (isQwenMaxId ? QWEN38_MAX_TOKENS : family?.minOutputTokens) ??
    (isReasoningModel(model) ? REASONING_MAX_TOKENS : undefined);

  if (isOpenAIReasoningModel(model)) {
    // GPT-5/o-series reject `max_tokens` (use max_completion_tokens); the cap is reasoning+answer.
    body.max_completion_tokens = Math.max(req.maxOutputTokens, REASONING_MAX_TOKENS);
    const wire = resolveEffortWire(req.effort, false, caps);
    if (wire != null) body.reasoning_effort = wire;
  } else if (opts.dashScope === true && isQwenMaxId) {
    // Hosted DashScope Qwen 3.8 Max — byte-identical historical wire contract (P1A-06 AC3).
    body.max_completion_tokens = Math.max(req.maxOutputTokens, QWEN38_MAX_TOKENS);
    body.reasoning_effort = resolveEffortWire(req.effort, true, caps);
    body.preserve_thinking = true;
  } else if (qwenMaxContract) {
    // Self-hosted Qwen 3.8 Max (AC1) or an aliased/declared Max serve (AC2). A self-hosted serve
    // takes `max_tokens` (vLLM/SGLang budget reasoning + answer together); the floor is applied
    // pre-shrink and the ladder self-corrects. Effort value is gated on the declared scale (AC4).
    body.max_tokens = Math.max(req.maxOutputTokens, reasoningFloor ?? REASONING_MAX_TOKENS);
    const wire = resolveEffortWire(req.effort, true, caps);
    if (wire != null) body.reasoning_effort = wire;
    body.preserve_thinking = true;
    if (opts.selfHosted) body.temperature = req.temperature ?? 1.0;
  } else {
    // Every other reasoning family (Gemini, Grok, DeepSeek-R1, Qwen-QwQ) takes `max_tokens` and
    // gets the SAME floor — one check, so a new reasoner can't silently run out. Non-reasoning
    // models keep their exact cap.
    const floored = reasoningFloor != null ? Math.max(req.maxOutputTokens, reasoningFloor) : req.maxOutputTokens;
    // A DOCUMENTED provider output cap (family knowledge — DeepSeek's 8k chat / 64k reasoner
    // limits, F09-06) clamps the first request under it: without this the 65,536 default spends
    // three 400-shrink round-trips EVERY turn re-discovering a published number. The ladder stays
    // as the net for undocumented caps; a declared capabilities.maxOutputTokens is the operator's
    // own floor and is never re-capped by family knowledge.
    const familyCap = caps?.maxOutputTokens == null ? family?.maxOutputCap : undefined;
    body.max_tokens = familyCap != null ? Math.min(floored, familyCap) : floored;
    // Effort reaches the wire only where the acceptance vocabulary is KNOWN: Grok's documented
    // reasoning variants (legacy 3-tier mapping), a DECLARED capabilities.effortScale, or family
    // knowledge (Kimi thinking's low/high/max). The scale gates the value — a tier the endpoint
    // never declared is never sent (P1A-06 AC4 extended to family scales).
    const familyScale = family?.effortScale;
    if (isGrokReasoningModel(model) || (caps?.effortScale?.length ?? 0) > 0 || (familyScale?.length ?? 0) > 0) {
      const wire = resolveEffortWire(req.effort, false, caps, familyScale);
      if (wire != null) body.reasoning_effort = wire;
    }
    // Sampling controls are intentionally a self-hosted-only feature. Public/cloud providers
    // have model-specific parameter rules (and OpenAI reasoning models reject temperature), so
    // provider instances must explicitly prove their endpoint is local before this is emitted.
    if (opts.selfHosted) body.temperature = req.temperature ?? 1.0;
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    // Normally "auto". A serve proven to reject auto tool choice (F11-01 — no vLLM/SGLang
    // tool-parser flags) gets "none": tools still render in the prompt and a tool-trained model
    // emits calls as text that Shadow's text-tool-call recovery parses. Tools stay attached either
    // way so the model knows what's available.
    body.tool_choice = opts.toolChoiceNone ? 'none' : 'auto';
  }
  // P2-03 (F01-05): params proven rejected by this endpoint are stripped up-front — the stream
  // ladder proved the recovery on first contact; later turns skip the 400 entirely. Applied
  // LAST so it wins over every emitter above (including tool_choice, which the generic ladder
  // strips outright when a server rejects the field itself rather than just the "auto" value).
  if (opts.stripParams) {
    for (const param of opts.stripParams) delete body[param];
  }
  return body;
}

// ── SSE → ProviderEvent (exported for unit tests; no network) ────────────────

interface OAISSE {
  // OpenAI-compat backends can return an error as a `data:` frame on an HTTP-200 stream
  // (rate limit, content filter, server error mid-generation). Without this the frame has
  // no `choices`, falls through, and the turn ends as a silent empty `end_turn`.
  error?: { message?: string; code?: string | number; type?: string };
  choices?: {
    delta?: {
      content?: string;
      // Reasoning models (DeepSeek, some OpenAI-compat) stream the chain of thought
      // in a separate field rather than inline tags. Both spellings seen in the wild.
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        // Gemini (OpenAI-compat) attaches a thought_signature here that MUST be echoed
        // back on the next request or multi-turn tool use 400s.
        extra_content?: { google?: { thought_signature?: string } };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface OAICallState {
  id: string;
  name: string;
  args: string;
  signature: string;
}

function findKeyById(calls: Map<string, OAICallState>, id: string): string | undefined {
  for (const [k, v] of calls) if (v.id === id) return k;
  return undefined;
}

export async function* parseOpenAISSE(
  lines: AsyncIterable<string>,
  model = '',
  preserveQwenReasoning = false,
  capabilities?: ModelCapabilities,
): AsyncIterable<ProviderEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: StopReason = 'end_turn';
  // Tool calls accumulate keyed by a synthetic key (insertion-ordered for flush). Backends
  // vary wildly: some omit `index`, some reuse index 0 for every call. We key by `id` when a
  // chunk introduces one, correlate args-only continuation chunks by `index`, else attach to
  // the most-recent call — so distinct calls never merge and continuations never split.
  const calls = new Map<string, OAICallState>();
  const indexToKey = new Map<number, string>();
  let lastKey: string | null = null;
  let keySeq = 0;
  // Only split inline  thinking for the families that actually emit it (see emitsInlineThinking).
  // An unknown/empty model keeps the old permissive behavior — a local serve whose id we don't
  // recognize is far more likely to be a reasoner than to be writing prose ABOUT think tags.
  // P1A-06: a declared `reasoning: 'inline' | 'interleaved'` capability forces inline splitting
  // for an aliased serve whose id the regexes can't classify.
  const splitInline =
    model === '' ||
    capabilities?.reasoning === 'inline' ||
    capabilities?.reasoning === 'interleaved' ||
    emitsInlineThinking(model);
  const splitter = new ThinkingSplitter(); // routes inline <think>/<thinking> spans to the reasoning channel
  /**
   * Did ANY `data:` frame arrive? A gateway that ignores `stream: true` (a misconfigured
   * LiteLLM/vLLM, a corporate proxy, an older Ollama /v1) answers 200 with a plain JSON completion
   * body. Every line of it fails the `data:` test and is skipped, so the turn used to parse to
   * exactly [usage 0/0/0, done end_turn] — no text, no tool calls, no error. The loop saw a clean
   * finish and stopped, so EVERY turn came back blank, forever, with no diagnostic anywhere. The
   * non-stream fallback could not help: it only fires when the parse THROWS, and this never throws.
   */
  let sawDataFrame = false;
  let preservedReasoning = '';
  let preservedReasoningField: 'reasoning_content' | 'reasoning' | undefined;
  /** Bounded copy of a non-SSE body so we can still recover the turn from it. */
  const rawBody: string[] = [];
  let rawBodyBytes = 0;
  const RAW_BODY_CAP = 8 * 1024 * 1024; // never buffer an unbounded stream

  for await (const ev of sseEvents(lines)) {
    if (ev.kind === 'other') {
      // Not a data frame. Until one arrives, buffer the raw body so a gateway that ignored
      // `stream: true` (plain JSON completion) can still be recovered after the loop.
      if (!sawDataFrame && rawBodyBytes < RAW_BODY_CAP) {
        rawBody.push(ev.line);
        rawBodyBytes += ev.line.length + 1;
      }
      continue;
    }
    sawDataFrame = true;
    // P2-03 (F01-08): spec-compliant SSE reassembly — one event's data field may span several
    // `data:` lines (joined with '\n' on dispatch). '[DONE]' is filtered per part so it works as
    // a lone terminator or the last part of a multi-line event.
    const parts = nonEmptyParts(ev.parts).filter((x) => x.trim() !== '[DONE]');
    if (parts.length === 0) continue;

    for (const parsed of parseSseData(parts.join('\n'), parts)) {
      const obj = parsed as OAISSE;

      // An error frame on a 200 stream: surface it (recoverable) instead of dropping it,
      // so the loop reports a real failure rather than a clean empty turn.
      if (obj.error) {
        const message = obj.error.message ?? 'provider returned an error frame';
        const code = obj.error.code ?? obj.error.type ?? 'provider_stream_error';
        yield { type: 'error', recoverable: true, code: String(code), message: String(message) };
        stopReason = 'end_turn';
        continue;
      }

      // The final usage chunk has empty `choices`; capture tokens whenever present.
      if (obj.usage) {
        const cached = obj.usage.prompt_tokens_details?.cached_tokens ?? 0;
        cacheReadTokens = cached;
        // OpenAI's prompt_tokens INCLUDES cached tokens; the rest of Shadow assumes disjoint
        // (Anthropic) semantics, so subtract to avoid double-counting cost + context.
        if (typeof obj.usage.prompt_tokens === 'number') inputTokens = Math.max(0, obj.usage.prompt_tokens - cached);
        if (typeof obj.usage.completion_tokens === 'number') outputTokens = obj.usage.completion_tokens;
      }

      const choice = obj.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      // Separate reasoning field (DeepSeek `reasoning_content`, some `reasoning`) → reasoning channel.
      const reasoningField = typeof delta?.reasoning_content === 'string'
        ? 'reasoning_content'
        : typeof delta?.reasoning === 'string'
          ? 'reasoning'
          : undefined;
      const reasoning = reasoningField ? delta?.[reasoningField] : undefined;
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'thinking', delta: reasoning };
        if (preserveQwenReasoning) {
          preservedReasoning += reasoning;
          preservedReasoningField ??= reasoningField;
        }
      }
      // Inline <think>/<thinking> spans in the content are split out to the same channel.
      if (delta?.content) {
        if (!splitInline) {
          yield { type: 'text', delta: delta.content };
        } else {
          for (const span of splitter.push(delta.content)) {
            yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
          }
        }
      }

      for (const tc of delta?.tool_calls ?? []) {
        let key: string;
        const existingById = tc.id ? findKeyById(calls, tc.id) : undefined;
        const idxKey = typeof tc.index === 'number' ? indexToKey.get(tc.index) : undefined;
        if (existingById) {
          key = existingById; // a later chunk re-stating a known id
        } else if (idxKey !== undefined && !(tc.id && calls.get(idxKey)!.id && calls.get(idxKey)!.id !== tc.id)) {
          // Continuation by index — INCLUDING a chunk that introduces the id late (name-first,
          // id-later), but NOT when the index already holds a DIFFERENT id (reused index).
          key = idxKey;
        } else if (tc.id) {
          key = `k${keySeq++}`; // a NEW id → a new call (even if index is absent or reused)
          calls.set(key, { id: tc.id, name: '', args: '', signature: '' });
          if (typeof tc.index === 'number') indexToKey.set(tc.index, key);
        } else if (typeof tc.index === 'number') {
          key = `k${keySeq++}`; // first chunk carried only an index
          calls.set(key, { id: '', name: '', args: '', signature: '' });
          indexToKey.set(tc.index, key);
        } else {
          key = lastKey ?? `k${keySeq++}`; // no id, no index → continue the most recent call
          if (!calls.has(key)) calls.set(key, { id: '', name: '', args: '', signature: '' });
        }
        lastKey = key;
        const cur = calls.get(key)!;
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        const sig = tc.extra_content?.google?.thought_signature;
        if (typeof sig === 'string' && sig) cur.signature = sig;
        if (typeof tc.function?.arguments === 'string') {
          cur.args += tc.function.arguments;
          yield { type: 'tool_call_partial', id: cur.id, name: cur.name, jsonDelta: tc.function.arguments };
        }
      }

      if (choice.finish_reason) stopReason = mapOpenAIFinish(choice.finish_reason);
    }
  }

  // Surface any held-back tail (e.g. an unclosed reasoning tag) at stream end.
  for (const span of splitter.flush()) {
    yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
  }

  // Flush accumulated tool calls at stream end (insertion order = stream order).
  let flushN = 0;
  const usedIds = new Set<string>();
  for (const c of calls.values()) {
    const idx = flushN++;
    if (!c.name && !c.args) continue; // a slot that never received a name or args is not a real call
    // De-dupe ids: a backend that omits or reuses ids would otherwise yield duplicate
    // tool_use ids → a hard 400 (duplicate_tool_use_id) once bridged to Anthropic.
    let id = c.id || `call_${idx}`;
    while (usedIds.has(id)) id = `call_${idx}_${usedIds.size}`;
    usedIds.add(id);
    // A call with args but NO name: some OpenAI-compatible wires stream the arguments without
    // ever sending the function name. Emitting it produced `unknown tool: ` downstream and a
    // wasted round trip; the Anthropic parser already handles the identical case as a recoverable
    // `nameless_tool_call`, so mirror that and let the model resend.
    if (!c.name) {
      yield {
        type: 'error',
        recoverable: true,
        code: 'nameless_tool_call',
        message: 'tool call streamed without a name (endpoint omitted the function name) — resend the call',
      };
      continue;
    }
    const parsed = parseToolArgs(c.args); // repair ladder before giving up
    if (parsed.ok) {
      yield {
        type: 'tool_call',
        call: { id, name: c.name, input: parsed.value, ...(c.signature ? { signature: c.signature } : {}) },
      };
    } else {
      yield {
        type: 'error',
        recoverable: true,
        code: 'bad_tool_json',
        message: `tool "${c.name}" ${parsed.error}`,
      };
    }
  }

  // Not an SSE stream at all — the body was a plain completion (or nothing).
  if (!sawDataFrame) {
    const body = rawBody.join('\n').trim();
    if (body) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        // It IS a valid completion, just not streamed. Recover the turn rather than failing it —
        // the same generator the non-stream path uses, so the two agree exactly. It emits its own
        // usage + done, so return immediately after.
        let produced = false;
        for (const ev of eventsFromOpenAICompletion(parsed, model, preserveQwenReasoning)) {
          produced = true;
          yield ev;
        }
        if (produced) return;
      }
    }
    // Nothing usable. Say so LOUDLY: a clean `done` here is what made this silent and permanent.
    yield {
      type: 'error',
      recoverable: true,
      code: 'not_sse',
      message:
        'the endpoint returned a 200 with no SSE frames — it is ignoring `stream: true`. ' +
        'Check the base URL and any gateway/proxy in front of it' +
        (body ? `. First bytes: ${body.slice(0, 200)}` : ' (the body was empty)'),
    };
    yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens };
    yield { type: 'done', stopReason };
    return;
  }

  if (preservedReasoning && preservedReasoningField) {
    yield { type: 'reasoning_block', text: preservedReasoning, field: preservedReasoningField };
  }

  // Some servers omit finish_reason:'tool_calls'; infer it from emitted calls.
  if (calls.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';

  yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens };
  yield { type: 'done', stopReason };
}

function mapOpenAIFinish(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn';
  }
}
