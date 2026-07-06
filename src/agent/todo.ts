/**
 * Agent-maintained todo list — externalizes "what's done / what's next" out of
 * the model's context window into a tool the loop renders back into the system
 * prompt each turn. This is the single biggest crutch for weak/quanted models:
 * instead of holding a plan in its head, the model writes it once via `todo_write`
 * and the harness pins the live list in front of it every turn, so it just fills
 * the next step.
 *
 * The state is in-memory and session-scoped (NOT a file). A file-based todo would
 * drift from the live session — a weak model forgets to re-read it, and the list
 * on disk goes stale while the in-memory truth moves on. Keeping it here means
 * summarization can never eat it (it lives in the system prompt, not in the
 * message history) and it is always current.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Positional id assigned by the list (todo-1, todo-2, ...). Stable within a write. */
  id: string;
  subject: string;
  status: TodoStatus;
  description?: string;
}

/** Input shape the `todo_write` tool accepts — the whole list, replaced each call. */
export interface TodoWriteEntry {
  subject: string;
  status: TodoStatus;
  description?: string;
}

export type TodoListener = (items: TodoItem[]) => void;

export class TodoList {
  private items: TodoItem[] = [];
  private readonly listeners = new Set<TodoListener>();

  /**
   * Replace the entire list. `todo_write` is whole-list-replace (not incremental
   * updates) because that is the simplest contract for a weak model to get right:
   * one tool, one schema, "here is my full list right now." Returns the stored
   * snapshot so the tool can report it back to the model.
   */
  write(entries: TodoWriteEntry[]): TodoItem[] {
    this.items = entries.map((e, i) => {
      const item: TodoItem = {
        id: `todo-${i + 1}`,
        subject: e.subject,
        status: e.status,
      };
      if (e.description !== undefined) item.description = e.description;
      return item;
    });
    this.emit();
    return this.snapshot();
  }

  /** A defensive copy so consumers (the TUI, the prompt renderer) can't mutate state. */
  snapshot(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** Register a listener fired on every write. Returns an unsubscribe function. */
  onUpdate(fn: TodoListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Render the list as a markdown block for the system prompt, or '' when empty.
   * Returning '' (not a "no todos" placeholder) keeps the prompt clean before the
   * model has written its first list and after it clears the list.
   */
  block(): string {
    if (this.items.length === 0) return '';
    const lines = this.items.map((it) => {
      const tag =
        it.status === 'completed' ? 'done' : it.status === 'in_progress' ? 'in-progress' : 'pending';
      const desc = it.description ? ` — ${it.description}` : '';
      return `${it.id.replace('todo-', '')}. [${tag}] ${it.subject}${desc}`;
    });
    return `\n\n## Task list\n${lines.join('\n')}`;
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // a listener must never break a write
      }
    }
  }
}
