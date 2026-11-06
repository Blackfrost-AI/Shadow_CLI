/** Explicit operator prompt controls. These never interpret payloads as slash commands. */
export function promptControlPayload(raw: string): string {
  const payload = raw.trim();
  if (!payload) throw new Error('Provide message text.');
  if (payload.startsWith('/')) throw new Error('Provide message text, not a nested slash command.');
  return payload;
}

/** Preserve FIFO and never interrupt tools. A queued follow-up does not request steering. */
export function promptSteeringAction(
  task: string, ahead: number, running: boolean, pendingSteer: boolean, allowSteering = true,
): 'inject' | 'end-turn' | 'none' {
  if (!allowSteering || !running || task.startsWith('/')) return 'none';
  if (ahead === 0) return 'inject';
  return pendingSteer ? 'none' : 'end-turn';
}
