# Inference Toolkit

Self-hosted inference is a first-class workload: local desktops, workstations, and data-center
nodes running GGUF-quantized open-weights models. These tools answer the standing questions —
*will this model fit, at which quant, with how much context and concurrency* — without guesswork.

The tools are **deferred** — they are not in the default schema. Find them with `tool_search`
by intent: model fit, VRAM, RAM, quant choice, context window, concurrency, OOM, KV cache.

## Reach for the right tool

| You are asked to | Tool | Risk |
|---|---|---|
| Inspect a GGUF file: metadata, architecture, quant mix | `infer_recon` | read |
| Will it fit: memory ceilings by quant/context/concurrency | `infer_capacity` | read |
| Measure throughput or latency | (none yet — `infer_bench` is planned) | exec |

## Tool contracts

**`infer_recon`** — read-only structured parse of a GGUF file: architecture, context length,
layer count, attention heads and KV-head geometry, embedding size, quantization mix with layer
counts, and a provenance tag per field (MEASURED / DECLARED / DERIVED / MODELLED). It never
executes or loads the model. Use it first: capacity math depends on its geometry.

**`infer_capacity`** — memory-capacity planning only. Given model identity (path or metadata),
it computes weight + activation + KV-cache footprints across pools (VRAM, host RAM, unified
memory) with binary units (GiB = 1024^3), sizes the KV cache from KV heads (not query heads), and
reports per-scenario ceilings (fits / fits with context N / does not fit) with the provenance of
every number. Host accelerator inventory is supplied by the harness, not by model input. It is
**memory-capacity only — it says nothing about speed, throughput, or latency**; a scenario that
fits can still be slow. When the search reports a bounded result (hit the iteration bound), it is
a floor, not a maximum. Unknown geometry fails closed rather than guessing.

## Verification rules

- Treat `unchecked` as unknown, not as a pass: pools that cannot be judged fail closed.
- A ceiling report is only as good as its inputs: check provenance tags before promising a number
  to the user. DECLARED/MODELLED values are estimates; MEASURED values carry harness receipts.
- Binary units throughout: never report `GB` when the math was `GiB`.
- Compare quants with the same context and concurrency assumptions, or don't compare them.
