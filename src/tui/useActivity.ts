import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityHistory,
  activityDraft,
  isRoutineCall,
  toolDraft,
  type ActivitySummary,
  type ToolEnd,
  type TranscriptDraft,
} from './activity.js';

export function useActivity() {
  const [history] = useState(() => new ActivityHistory());
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const lastProviderAt = useRef(Date.now());
  useEffect(() => () => history.reset(), [history]);
  const close = useCallback((): TranscriptDraft | null => {
    const closed = history.close();
    if (closed) setSummary(null);
    // Thinking remains inspectable, but an ordinary chat reply needs no activity receipt.
    return closed?.tools ? activityDraft(closed) : null;
  }, [history]);
  const reasoning = useCallback(
    (text: string, ms: number) => {
      history.reasoning(text, ms);
      setSummary(history.summary());
    },
    [history],
  );
  const complete = useCallback(
    (event: ToolEnd): TranscriptDraft[] => {
      const routine =
        event.result.ok &&
        !event.result.meta?.diff?.length &&
        isRoutineCall(event.call.name, event.call.input);
      const drafts: TranscriptDraft[] = [];
      if (!routine) {
        const previous = close();
        if (previous) drafts.push(previous);
      }
      history.tool(event);
      if (routine) setSummary(history.summary());
      else {
        const group = history.close()!;
        setSummary(null);
        drafts.push(toolDraft(event, group.id));
      }
      return drafts;
    },
    [history, close],
  );
  const reset = useCallback(() => {
    history.reset();
    setSummary(null);
  }, [history]);
  return { history, summary, close, reasoning, complete, reset, lastProviderAt };
}
