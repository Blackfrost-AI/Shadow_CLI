/**
 * Waterfall chains — short-circuit, wrap, rewrite, and the failure modes that matter.
 *
 * These encode the invariants the flat hook runner could not express. The important ones are the
 * negative cases: a listener that forgets `next()` must terminate the chain (fail toward less
 * execution), and a listener that calls `next()` twice must not double-apply a side effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waterfall, WaterfallChain } from '../src/hooks/waterfall.js';

test('an empty chain is the identity function', async () => {
  const chain = waterfall<string>();
  assert.equal(await chain.run('unchanged', undefined), 'unchanged');
  assert.equal(chain.size, 0);
});

test('listeners run in registration order', async () => {
  const chain = waterfall<string>();
  const seen: string[] = [];
  chain.use('a', async (v, _c, next) => {
    seen.push('a');
    return next(v + 'a');
  });
  chain.use('b', async (v, _c, next) => {
    seen.push('b');
    return next(v + 'b');
  });
  assert.equal(await chain.run('', undefined), 'ab');
  assert.deepEqual(seen, ['a', 'b']);
});

test('rewrite: next(transformed) changes what downstream steps see', async () => {
  const chain = waterfall<string>();
  chain.use('redact', async (_v, _c, next) => next('REDACTED'));
  chain.use('shout', async (v, _c, next) => next(v.toUpperCase()));

  assert.equal(await chain.run('secret-token', undefined), 'REDACTED');
});

test('wrap: a listener can act on both sides of the inner call', async () => {
  const chain = waterfall<string>();
  const log: string[] = [];
  chain.use('audit', async (v, _c, next) => {
    log.push(`before:${v}`);
    const out = await next(v);
    log.push(`after:${out}`);
    return `${out}!`;
  });
  chain.use('inner', async (v, _c, next) => next(v + 'x'));

  assert.equal(await chain.run('v', undefined), 'vx!');
  assert.deepEqual(log, ['before:v', 'after:vx']);
});

test('short-circuit: returning without next() skips the remaining steps', async () => {
  const chain = waterfall<string>();
  let reached = false;
  chain.use('guard', async () => 'blocked'); // never calls next()
  chain.use('never', async (v, _c, next) => {
    reached = true;
    return next(v);
  });

  assert.equal(await chain.run('go', undefined), 'blocked');
  assert.equal(reached, false, 'a short-circuit must prevent downstream execution');
});

test('calling next() twice runs the downstream chain only once', async () => {
  const chain = waterfall<string>();
  let downstreamRuns = 0;
  chain.use('double-caller', async (v, _c, next) => {
    const a = await next(v);
    const b = await next(v); // a forgotten `return` — must be idempotent
    assert.equal(a, b);
    return a;
  });
  chain.use('counted', async (v, _c, next) => {
    downstreamRuns++;
    return next(v);
  });

  await chain.run('x', undefined);
  assert.equal(downstreamRuns, 1, 'downstream must not run twice for one value');
});

test('a throwing listener is annotated with its name and position', async () => {
  const chain = waterfall<string>();
  chain.use('ok', async (v, _c, next) => next(v));
  chain.use('explodes', async () => {
    throw new Error('boom');
  });

  await assert.rejects(
    () => chain.run('x', undefined),
    (err: Error) => {
      assert.match(err.message, /waterfall step "explodes" \(2\/2\) failed: boom/);
      assert.ok(err.cause instanceof Error, 'the original error is preserved as the cause');
      return true;
    },
  );
});

test('unsubscribe removes exactly the registered listener', async () => {
  const chain = waterfall<string>();
  const off = chain.use('temporary', async (v, _c, next) => next(v + '!'));
  chain.use('permanent', async (v, _c, next) => next(v + '?'));

  assert.equal(await chain.run('a', undefined), 'a!?');
  off();
  assert.equal(await chain.run('a', undefined), 'a?');
  assert.deepEqual(chain.names(), ['permanent']);
});

test('context is threaded to every listener', async () => {
  const chain = waterfall<string, { tool: string }>();
  const seen: string[] = [];
  chain.use('a', async (v, ctx, next) => {
    seen.push(ctx.tool);
    return next(v);
  });
  chain.use('b', async (v, ctx, next) => {
    seen.push(ctx.tool);
    return next(v);
  });

  await chain.run('x', { tool: 'run_shell' });
  assert.deepEqual(seen, ['run_shell', 'run_shell']);
});

test('names() reports execution order for a doctor surface', () => {
  const chain = new WaterfallChain<string>();
  chain.use('first', async (v, _c, next) => next(v));
  chain.use('second', async (v, _c, next) => next(v));
  assert.deepEqual(chain.names(), ['first', 'second']);
});

test('a listener registered during a run does not affect that run', async () => {
  // Snapshotting the entry list keeps a run's semantics stable: a listener that registers another
  // (a plugin loading another plugin) must not extend the chain it is currently inside.
  const chain = waterfall<string>();
  chain.use('adder', async (v, _c, next) => {
    chain.use('late', async (x, _c2, n) => n(x + 'LATE'));
    return next(v);
  });

  assert.equal(await chain.run('a', undefined), 'a');
  assert.equal(await chain.run('a', undefined), 'aLATE');
});