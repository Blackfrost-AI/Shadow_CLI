# Third-Party Notices

Shadow is MIT-licensed (see `LICENSE`). This file records the third-party projects whose code or
design Shadow incorporates, as their licenses require.

---

## DeepSeek Harness

- **Project:** `deepseek-ai/deepseek-harness`
- **License:** MIT
- **Copyright:** Copyright (c) 2026 DeepSeek

Shadow adapts several *designs* from DeepSeek Harness in release 10.4.0. Where the adaptation is
close to the original, the source file carries a header naming this project and the notice. The
files concerned are:

| Shadow file | Adapted from | What was taken |
|---|---|---|
| `src/safety/sandboxPolicy.ts` | sandbox policy / profiles | The three-mode sandbox model (`read-only`, `workspace-write`, `danger-full-access`) and the single-policy-home structure |
| `src/safety/escalation.ts` | escalation | The one-rung, human-gated escalation ladder and the "no re-prompt after decline" rule |
| `src/safety/landlock.ts`, `native/shadow-landlock.c` | sandbox roots | The Landlock-based Linux confinement approach and read/write root separation |
| `src/agent/runtimeContext.ts` | runtime context | Folding live sandbox/workspace state into the system prompt each request |
| `src/agent/toolSpill.ts` | tool-result spill | Spilling oversized tool output to a session file and handing the model a locator |
| `src/hooks/waterfall.ts` | hook waterfall | Listener chains with `next()`: short-circuit, wrap, and rewrite semantics |

Shadow does **not** include DeepSeek Harness code that would compromise its zero-telemetry
guarantee; in particular the `telemetry/` subsystem was deliberately not adopted.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```