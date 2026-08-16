# Wire-Format Compatibility Matrix

Shadow is **provider-neutral**: it speaks the Anthropic Messages wire, the OpenAI Chat
Completions wire, and (opt-in) the OpenAI Responses wire, and it treats every OpenAI-compatible
endpoint — hosted or self-hosted — as a first-class target. This document is the
**transport-level** half of compatibility: what Shadow adapts to *automatically* when a server
pushes back, the SSE contract its parsers hold to, and the knobs that change the wire. The
*capability* half — which models are agentic enough to drive — lives in
[README.md](README.md) under **Model compatibility — tested models**.

---

## Wire formats

| Wire | Selects via | Status |
|---|---|---|
| Anthropic Messages | `provider: "anthropic"` | Default for Anthropic endpoints |
| OpenAI Chat Completions | `provider: "openai"` (any `baseUrl`) | Default for OpenAI + every OpenAI-compatible endpoint |
| OpenAI Responses (`/v1/responses`) | env `SHADOW_WIRE_API=responses` | Opt-in, **Codex-class backends only** — see below |

---

## The recovery ladder (what happens when a server rejects a request)

When a streaming request comes back 400, 429, or 5xx, Shadow does not fail immediately — it
walks a ladder of **specific, evidence-gated** recoveries, best match first. Nothing is stripped
blindly: every rung fires only when the server's error message (or the payload shape) identifies
the problem. The strip rungs retry once each; rung 1 rides out up to 5 backoff attempts and
rung 2 up to 5 shrinks.

| # | Rung | Evidence gate | Recovery | Remembered for session |
|---|---|---|---|---|
| 1 | Rate-limit / overload / server error | status 429 / 5xx | retry with backoff (up to 5 attempts) | — |
| 2 | Token overflow | message indicates prompt+max_tokens exceeds the context window | shrink `max_tokens` stepwise and retry | per-turn budget (5 shrinks) |
| 3 | Vision unsupported | message indicates images/vision not supported | strip images, retry | — (recovered in-band each turn: the images stay in history, so a turn containing them pays the 400 + retry again) |
| 4 | Bad image payload | message indicates a malformed/unreadable image | strip images (quoting the server's reason), retry | — |
| 5 | `tool_choice` rejected ("auto"/field semantics) | message indicates `tool_choice` unsupported | retry with `tool_choice: "none"` | ✅ OpenAI wire |
| 6 | Named request param rejected | message **names** `stream_options`, `tool_choice`, or `temperature` — and reads as a *field* rejection, not a *value* error | retry with that param stripped | ✅ OpenAI Chat Completions + Responses wires |
| 7 | Anything else | — | terminal `http_<status>`, surfaced verbatim | — |

**Rung 6 properties (the robustness ladder):**

- **Attribution, not guessing.** The strip fires only when the server's own error text names the
  param ("Unsupported parameter: 'stream_options'", "temperature is not supported for this
  model", …). A 400 naming nothing strippable stays terminal.
- **Value errors stay terminal.** A message that reads as *value* validation ("temperature 0.2
  is below the minimum", "must be <= 2, got 5", "out of range") is **not** stripped: removing
  the param would silently void a knob you set explicitly (sampling would re-default for the
  whole session). Shadow surfaces the server's words instead — the honest failure mode.
- **Multi-param banners walk.** A gateway that lists every rejected param in one message (or
  names a param Shadow never sent) does not stall the recovery: the candidates are tried in
  ladder order, one strip per 400, skipping params already stripped or absent from the body.
- **One 400 per param, ever — on the wires that remember.** The strip is remembered for the
  session on the OpenAI Chat Completions and Responses wires: every later request is built
  without the param, so those sessions never pay the same 400 twice. The memory lives on the
  provider instance, so a model switch (fresh instance) re-learns it once — deliberate, since
  rejections are usually model-specific. The Anthropic wire emits none of these params, so
  there is nothing to remember.
- **Silent by design.** Recovery is silent (it is a successful request, not an error).

---

## The SSE contract

Shadow's stream parsers (OpenAI, Anthropic, Responses, and MCP Streamable HTTP) share one SSE
assembler. It reassembles multi-line `data` frames the WHATWG-spec way, with three disclosed
deviations:

- **Multi-line data frames reassemble.** One event's `data` field may legally span several
  consecutive `data:` lines; they join with `\n` and parse as a single payload. A server that
  pretty-prints a JSON frame — or splits one across a flush boundary — is spec-entitled to do
  this, and Shadow parses it as one unit.
- **Dispatch is eager.** A frame ships the moment the accumulated lines parse as one complete
  JSON document — it does not wait for the terminating blank line. Spec-conformant streams get
  identical events (a few milliseconds earlier); the payoff is the next bullet.
- **Non-conforming streams stay incremental.** Some servers emit events back-to-back *without*
  the separating blank line. Eager dispatch gives those streams line-by-line delivery (nothing
  buffers until end of stream), and if a dispatched multi-line payload still fails to parse,
  Shadow retries each constituent line on its own — the pre-P2-03 behavior — so packed streams
  keep working too. Nothing that parsed before parses worse now; delivery and memory on packed
  streams are pre-P2-03-grade again.
- **Frames are JSON objects only.** `data: null` keepalives and bare primitives are filtered in
  the assembler layer, so no parser can crash property-accessing them. A mid-stream connection
  death surrenders whatever the assembler holds (flush-on-error) rather than eating it; an
  unparseable accumulation is force-dispatched at ~1 MB, so garbage streams cannot grow the
  buffer without bound.
- **Line hygiene:** CRLF is tolerated (a trailing CR is dropped), but **CR-only line splits are
  not supported** (Shadow splits on `\n`); exactly one leading space after `data:` is treated as
  syntax (a second space is content); a BOM between the colon and the payload is stripped
  (parity with the pre-P2-03 parsers); keepalive comments (`: ping`) pass through harmlessly; a
  final event missing its trailing blank line is flushed at end of stream.
- **Deliberate simplification:** a non-`data` field line (`event:`, `id:`, `:` comment)
  terminates the accumulating data field early instead of waiting for the blank line. Real
  servers never interleave field lines inside one multi-line data payload (OpenAI, Anthropic,
  vLLM, and SGLang all emit contiguous data lines), so this trades an unobserved spec corner for
  bounded accumulators.

**Tool-argument escaping, both directions:**

- **Sending:** on the OpenAI wire, tool inputs are serialized with strict `JSON.stringify` —
  `arguments` on the wire is always well-formed JSON, properly escaped. (On the Anthropic wire
  tool inputs ride as structured objects inside the body JSON.)
- **Receiving:** streamed argument *fragments* are accumulated as raw text and parsed leniently
  once the call completes — tolerating servers that stream arguments before the call name when
  chunks stay index/id-correlated, split mid-escape, or carry idiosyncratic whitespace. A call
  whose name never arrives is **not** silently tolerated: it surfaces a recoverable
  resend-the-call error.

---

## `SHADOW_WIRE_API` — the opt-in Responses wire

Setting `SHADOW_WIRE_API=responses` switches OpenAI-class endpoints from Chat Completions to
`/v1/responses`.

- **Codex-class backends only.** This wire exists for Codex-class servers that speak the Responses
  protocol natively. It is not a general upgrade path; Chat Completions remains the default and
  the recommended wire.
- **What maps:** tools are flattened to the Responses shape (`{type, name, description,
  parameters}`); `reasoning_effort` maps to `reasoning.effort`.
- **The caveat — reasoning is dropped between turns.** Shadow's Responses adapter is a stateless
  mapping over the same chat-style history: internal reasoning items are **not** round-tripped
  into subsequent requests on this wire. Do not choose it for workflows that depend on preserved
  reasoning; on those, use the provider's native wire (e.g. Anthropic thinking blocks, Gemini
  `thought_signature` round-trip).

---

## Provider notes

- **OpenAI-compatible, self-hosted (vLLM / SGLang / llama.cpp / Ollama / MLX / Shadow-managed
  GGUF):** Shadow sends `stream_options: { include_usage: true }` for usage accounting, the
  `temperature` contract above, and full tool-call payloads. Servers that reject any of these get
  the recovery ladder — on this wire stripped params are remembered, so the second request
  onward is clean.
- **Anthropic:** native Messages wire; prompt caching markers; thinking blocks round-trip.
- **Gemini (via the OpenAI-compatible wire):** `thought_signature` round-trip for thinking
  models.
- **GLM-4 (Z.ai):** transport works (OpenAI-compatible), but note GLM-4 tested as a **chat model,
  not agentic** — see the tested-models table in [README.md](README.md).

---

*Everything in this matrix is test-pinned: the ladder table, the value-error carve-out, the
multi-candidate walk, and the multi-line SSE frames across all four parsers are covered by
`test/provider-robustness.test.ts`; per-provider wire behaviors by `test/providers.test.ts`,
`test/responses-provider.test.ts`, and the `test/tool-choice-fallback.test.ts` suite.*
