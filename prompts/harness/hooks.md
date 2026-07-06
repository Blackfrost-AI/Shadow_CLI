# Hooks and Lifecycle Awareness in the Shadow Harness

Shadow supports hooks at key points in the agent lifecycle (configured in settings or .shadow/hooks or similar).

Relevant phases the model should be aware of:
- pre_tool_use / post_tool_use: before/after tool execution. Can block on pre.
- user_prompt_submit: on new input.
- session_start / session_end.
- pre_compact / post_compact: around history summarization. Compaction can be blocked by hook.
- stop, subagent_stop.
- notification: for background task completion (<task-notification>).

## How to Work With Hooks

Structure work so hooks can observe (e.g. clear intent in commands, durable state).

If a hook denies, respect and adapt (or report).

Background work and sub-agents trigger notifications for main loop pickup.

The harness manages execution of hooks. You drive by producing work that benefits from observation and external control.

Use this for reliable, observable, interruptible long-running tasks.