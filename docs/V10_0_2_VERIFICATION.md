# Shadow 10.0.2 interruption checks

10.0.1's compiled runtime could close a provider connection on Escape while leaving the response
reader pending. The screen printed `interrupted`, but the turn stayed busy and subsequent prompts
queued indefinitely. 10.0.2 explicitly cancels response readers and releases pending reads on abort,
including streaming answers, HTTP error bodies, and non-stream fallback responses. Partial answers
are committed before the interrupt notice; repeated Escape produces one notice.

Run the Node test suite, both TypeScript checks, lint, production build, asset checks, release gate,
and normal gated packaging. The interruption regressions include non-cooperative transport cleanup,
buffered content, pre-aborted requests, Unicode decoding, HTTP 200/401/429/500 responses, fallback
cancellation, queued follow-ups, unsent drafts, and notice ordering.

On macOS and Linux, run the real terminal check against both the Node build and compiled binary:

```sh
python3 scripts/smoke-interrupt-pty.py node dist/index.js
python3 scripts/smoke-interrupt-pty.py ./dist-bin/shadow
```

The fixture uses a disposable profile, fake key, offline mode, and a loopback server. It leaves the
first response open, sends Escape before the first token or during an answer, verifies connection
closure, and requires the next prompt to finish. It also checks Ctrl+C during an answer and terminal
restoration on exit. No external provider or user configuration is used.

Source CI runs this terminal check on macOS and Linux. Signed-release CI also runs it against each
native macOS/Linux artifact, so a Node-only success cannot hide a compiled-runtime regression.
Windows retains its source suite and native signed installer/update checks under PowerShell 5.1
and 7; the POSIX PTY script does not exercise Windows keyboard input.
