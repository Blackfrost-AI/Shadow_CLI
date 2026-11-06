import { promptControlPayload, promptSteeringAction } from '../agent/promptControl.js';
import { expandPastes } from './composer.js';
import type { KeyEnv } from './keys/types.js';

export type PromptControlEnv = Pick<KeyEnv, 'runningRef' | 'compactingRef' | 'asyncCommandRef' |
  'modelSwitchingRef' | 'loopRef' | 'queuedTasksRef' | 'setQueued' | 'pastesRef' | 'pushLine'> & {
  startTurn: (text: string) => void;
};

/** Explicit controls share the same FIFO and paired-history boundary as ordinary input. */
export function dispatchPromptControl(env: PromptControlEnv, mode: 'steer' | 'queue', raw: string): void {
  try {
    const text = promptControlPayload(expandPastes(raw, env.pastesRef.current));
    if (mode === 'steer' && !env.runningRef.current) {
      throw new Error('No active turn to steer. Submit a message or use /queue <text>.');
    }
    const blocked = env.compactingRef.current || env.asyncCommandRef.current || env.modelSwitchingRef.current;
    if (!env.runningRef.current && !blocked && env.queuedTasksRef.current.length === 0) {
      env.startTurn(text);
      return;
    }
    const ahead = env.queuedTasksRef.current.length;
    env.setQueued([...env.queuedTasksRef.current, { text, kind: mode === 'steer' ? 'steer' : 'deferred' }]);
    const action = promptSteeringAction(text, ahead, env.runningRef.current,
      env.loopRef.current?.hasPendingSteer() ?? false, mode === 'steer' && !blocked);
    if (action === 'inject') env.loopRef.current?.requestSteer(text);
    else if (action === 'end-turn') env.loopRef.current?.requestSteer();
    env.pushLine({ text: action === 'inject' ? '  ↪ steering requested' : '  queued in order', dimColor: true });
  } catch (error) {
    env.pushLine({ text: `  ${(error as Error).message}`, dimColor: true });
  }
}
