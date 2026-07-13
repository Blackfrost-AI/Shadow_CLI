# Driving the Shadow Harness Effectively

To get the most power from the Shadow harness and make even weaker models highly effective:

- **Externalize everything important**: Use `todo_write` every turn for multi-step (the harness pins the live list in your system prompt fresh every time AND renders it in the TUI green-bordered Task list panel — beside the transcript when the terminal is wide, above it when narrow; includes full items + descriptions, progress). Plans in yellow side/top panel. Status bar always shows todo progress and plan. Write plans to plans/*.md. The TUI + prompt keep you and user perfectly aligned on state for every action you take.
- **Verify relentlessly**: After any edit or shell, re-read, re-run, check. "It should work" means you haven't verified yet.
- **Use isolation for safety/parallel**: `agent` with isolation:"worktree" for independent changes or risky experiments.
- **Background for scale**: Set run_in_background true for long tasks or fan-out; monitor via notifications.
- **Self-review**: Launch reviewer (agent with type reviewer) before big commits, when stuck, or pre-declare-done. Make state durable first.
- **Tool discipline**: Prefer specialized tools over shell when possible (read_file before edit, etc.). Always ground paths with glob/ls first.
- **Drive completion**: No stubs. Full task. Report outcomes faithfully with evidence.
- **Calibrate**: Lean hard on scaffolding for small models. Use full power for frontier.

The harness provides the execution, permissions, isolation, notifications, external state pinning, and safety. You provide the reasoning, decomposition, and persistent state management.

Follow the disciplines and the work you deliver will run far above the size of the model driving you.