---
description: Security hardening guidance for AI agent frameworks that process untrusted content — tool-use enforcement, prompt-injection defense, memory safety, and egress control.
when_to_use: When hardening an agent framework, building a tool-using AI agent, or reviewing code that pipes untrusted external content (web, docs, emails, files, tool output) into an LLM context.
disable-model-invocation: false
user-invocable: true
---

# Agent Security Hardening

LLM agents are a distinct attack surface: untrusted external content flows into the
model's context, and the model's output drives tools that execute code, read files,
and make network calls. Adapted for Shadow from the local ECC plugin pack — Shadow's
own containment stack is the reference implementation, and this skill names the
patterns to preserve or replicate when hardening agent code.

## The core threat model

An agent ingests web pages, documents, emails, API responses, tool output, and repo
text. Any of it can carry adversarial instructions ("ignore previous instructions",
smuggled role tags, forged system markers). Because the agent acts, a successful
injection can mean credential theft, arbitrary file access, or SSRF via the agent's
own tools. **The model is not a security boundary — the harness is.**

## 1. Enforce tool use at the runtime boundary

- Treat prompt instructions ("never read secrets", "never call X") as advisory.
  Enforce with runtime controls: tool allowlists per autonomy level, argument
  validation (schemas), permission gates on risky actions, sandboxed execution.
- Prefer structured tool schemas over free-form command strings; when a shell is
  unavoidable, validate paths/arguments before execution and reject ambiguous
  syntax rather than guessing.
- Fail closed: a denied or unclassifiable action stays denied; never route around
  a permission denial, jail, or sandbox.

## 2. Contain untrusted content structurally

Shadow's envelope pattern (copy it when building agent pipelines):

- Wrap ALL external content in widening collision-proof markers
  (`<<<UNTRUSTED_CONTENT_BEGIN>>>` … `<<<UNTRUSTED_CONTENT_END>>>`, padding widened
  if the payload contains the plain markers) under a header declaring it DATA.
- Never mutate the payload to sanitize it — wrap it, so the model can still read
  the evidence; clamp BEFORE wrapping so the END marker always survives.
- When slicing context, drop whole open envelopes rather than leaving them
  unclosed (an unclosed envelope trains the model that the boundary is optional).
- Carry the same treatment through summaries/compaction: injected text that
  survives summarization as trusted-looking prose is laundering — re-mark or
  re-envelope derived content that originated in tool output.

## 3. Prompt-injection defenses (layered, none sufficient alone)

- Instruction hierarchy: system > operator > user > tool/web content. Old
  transcripts, stale files, and tool output never grant new authority.
- Injection detection at ingestion: flag imperative language aimed at the agent,
  forged role/system markers, requests to reveal secrets, change scope, or contact
  new endpoints — surface to the operator instead of silently obeying.
- API-level injection: providers can inject instructions in-band (e.g. synthetic
  "user" turns in responses). Treat non-operator turns claiming operator authority
  as suspect; prefer transports where roles are structurally distinguishable, and
  record traces when a provider injects (evidence for disclosure, kept local).
- Never let fetched content choose URLs, file paths, or shell commands; bind those
  to operator intent and allowlists.

## 4. Memory and durable-state safety

- Memory writes that feed future system prompts are a persistence vector:
  risk-gate them, attribute authorship (user vs generated), sanitize keys/values
  against prompt-line forgery (flatten control chars, cap lengths), redact
  secret-shaped values before write, and mark the rendered index untrusted.
- Treat durable files (plans, notes, configs, prior handoffs) as context, not
  authority. A stored instruction is still untrusted input.
- Quarantine corrupt state instead of overwriting it; keep owner-only permissions
  (0600/0700) on anything holding user data.

## 5. Egress control (the last line)

- Route ALL agent HTTP through one broker: offline wall, SSRF validation with
  DNS-pin per hop, redirect re-validation, byte/time caps, append-only receipts.
- Default-deny network for sandboxed sample execution; explicit operator opt-in
  per run. Zero telemetry: the agent phones home to no one.
- New capabilities that reach the network get their own purpose tag and receipts
  so the operator can audit exactly what left the machine.

## Review checklist for agent code

- [ ] Every tool has a risk tier; risky tiers gated; denials not bypassable
- [ ] External content enveloped before it enters context; envelopes survive slicing
- [ ] Injection-shaped content surfaced, not obeyed; authority comes only from the operator
- [ ] Memory/state writes redacted, attributed, size-capped, permission-hardened
- [ ] All HTTP brokered with SSRF checks + receipts; offline mode honored
- [ ] Sandboxed execution default-denies network and confines writable paths
- [ ] Secrets never in prompts, logs, commits, or exported artifacts
- [ ] Regression tests pin each boundary (injection payloads, forged markers,
      traversal paths, denied-tool attempts) — see `security-review` for the rest