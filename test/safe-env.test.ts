import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubbedEnv } from '../src/util/safeEnv.js';

test('scrubbedEnv drops provider secrets and keeps explicit child configuration', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/test',
    ANTHROPIC_API_KEY: 'secret-a',
    OPENAI_API_KEY: 'secret-b',
  } as NodeJS.ProcessEnv;
  const env = scrubbedEnv(['PATH', 'HOME'], { MCP_MODE: 'safe' }, source);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.MCP_MODE, 'safe');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});
