import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpPermissionGate } from '../src/acp/gate.js';
import type { ApprovalRequest } from '../src/agent/approval.js';
import type { RequestPermissionParams, RequestPermissionResult } from '../src/acp/protocol.js';
import type { ToolCall } from '../src/provider/provider.js';

/**
 * The approval bridge: editor decisions ↔ loop decisions. Fail-closed floor pinned in every
 * direction — reject, cancel, transport error, unknown option, abort — plus the exact option set
 * the editor is shown and the acknowledgeOnly/user_question special cases.
 */

const call: ToolCall = { id: 'tc-1', name: 'run_shell', input: { command: 'ls' } };

function makeReq(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap_test',
    kind: 'permission',
    call,
    risk: 'exec',
    reason: 'wants to run a shell command',
    preview: 'ls',
    ...over,
  };
}

function makeGate(
  answer: RequestPermissionResult | undefined | 'throw',
  captured?: { params: RequestPermissionParams[]; signals: Array<AbortSignal | undefined> },
): { gate: AcpPermissionGate; findings: string[] } {
  const findings: string[] = [];
  const gate = new AcpPermissionGate(
    'session-1',
    async (params, signal) => {
      captured?.params.push(params);
      captured?.signals.push(signal);
      if (answer === 'throw') throw new Error('transport down');
      return answer;
    },
    (title, body) => findings.push(`${title}: ${body}`),
  );
  return { gate, findings };
}

const selected = (optionId: string): RequestPermissionResult => ({ outcome: { outcome: 'selected', optionId } });

test('allow_once → approve; reject_once → deny; allow_always → approveForSession', async () => {
  assert.equal(await makeGate(selected('allow_once')).gate.request(makeReq()), 'approve');
  assert.equal(await makeGate(selected('reject_once')).gate.request(makeReq()), 'deny');
  assert.deepEqual(await makeGate(selected('allow_always')).gate.request(makeReq()), { approveForSession: true });
});

test('reject_always and unknown option ids fail closed to deny', async () => {
  assert.equal(await makeGate(selected('reject_always')).gate.request(makeReq()), 'deny');
  assert.equal(await makeGate(selected('made_up_option')).gate.request(makeReq()), 'deny');
});

test('cancelled outcome → deny', async () => {
  assert.equal(await makeGate({ outcome: { outcome: 'cancelled' } }).gate.request(makeReq()), 'deny');
});

test('missing outcome / undefined result → deny', async () => {
  assert.equal(await makeGate({}).gate.request(makeReq()), 'deny');
  assert.equal(await makeGate(undefined).gate.request(makeReq()), 'deny');
});

test('transport failure → deny (fail-closed, never throws)', async () => {
  assert.equal(await makeGate('throw').gate.request(makeReq()), 'deny');
});

test('the editor sees exactly reject/allow-once/allow-always with the call details', async () => {
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  await makeGate(selected('allow_once'), captured).gate.request(
    makeReq({ call: { id: 'tc-77', name: 'write_file', input: { path: 'f' } }, risk: 'write', reason: 'writes a file' }),
  );
  assert.equal(captured.params.length, 1);
  const p = captured.params[0]!;
  assert.equal(p.sessionId, 'session-1');
  assert.deepEqual(p.toolCall, {
    toolCallId: 'tc-77',
    title: 'write_file',
    description: 'writes a file',
    kind: 'edit', // known tool beats the risk fallback
    rawInput: { path: 'f' },
  });
  assert.deepEqual(
    p.options.map((o) => [o.optionId, o.kind]),
    [
      ['reject_once', 'reject_once'],
      ['allow_once', 'allow_once'],
      ['allow_always', 'allow_always'],
    ],
  );
});

test('acknowledgeOnly: a single acknowledge option is shown, but the decision is ALWAYS deny', async () => {
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  // Even if the editor picks the (only) option, the call stays hard-blocked (F07-09).
  assert.equal(await makeGate(selected('acknowledge'), captured).gate.request(makeReq({ acknowledgeOnly: true })), 'deny');
  assert.equal(captured.params.length, 1);
  assert.deepEqual(
    captured.params[0]!.options.map((o) => o.optionId),
    ['acknowledge'],
  );
  // And transport failure changes nothing either.
  assert.equal(await makeGate('throw').gate.request(makeReq({ acknowledgeOnly: true })), 'deny');
});

test('user_question: first option auto-answered, no editor round-trip, finding emitted', async () => {
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  const { gate, findings } = makeGate(selected('allow_once'), captured);
  const decision = await gate.request(
    makeReq({
      kind: 'user_question',
      questions: [
        { question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] },
        { question: 'Pick a size', options: [{ label: 'S' }, { label: 'L' }], multiSelect: false },
      ],
    }),
  );
  assert.deepEqual(decision, {
    answers: [
      { question: 'Pick a color', selected: ['red'] },
      { question: 'Pick a size', selected: ['S'] },
    ],
  });
  assert.equal(captured.params.length, 0, 'questions never reach request_permission');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /auto-answered/i);
});

test('user_question with no questions yields empty answers without error', async () => {
  const { gate, findings } = makeGate(undefined);
  assert.deepEqual(await gate.request(makeReq({ kind: 'user_question' })), { answers: [] });
  assert.equal(findings.length, 0);
});

test('plan transitions auto-approve without asking the editor', async () => {
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  const { gate } = makeGate(selected('reject_once'), captured);
  assert.equal(await gate.request(makeReq({ kind: 'plan_enter' })), 'approve');
  assert.equal(await gate.request(makeReq({ kind: 'plan_exit' })), 'approve');
  assert.equal(captured.params.length, 0);
});

test('rawInput is scrubbed before it reaches the editor — secrets never cross the wire unredacted', async () => {
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  await makeGate(selected('allow_once'), captured).gate.request(
    makeReq({
      call: { id: 'tc-sec', name: 'run_shell', input: { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUI5 abcdefgh.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1' } },
      reason: 'sends a request with an embedded token',
    }),
  );
  const wire = JSON.stringify(captured.params[0]!.toolCall.rawInput);
  assert.ok(!wire.includes('eyJhbGci'), 'no raw JWT on the permission wire');
  assert.ok(wire.includes('[REDACTED]'), 'the scrub marker replaces it');
});

test('signal passed through to the transport; abort during a pending ask → deny', async () => {
  const ctrl = new AbortController();
  let sawSignal: AbortSignal | undefined;
  const gate = new AcpPermissionGate('s', async (_params, signal) => {
    sawSignal = signal;
    return new Promise<RequestPermissionResult | undefined>(() => {
      /* never settles on its own — only abort ends it */
    });
  });
  const p = gate.request(makeReq({ signal: ctrl.signal }));
  const done = Promise.resolve(p);
  ctrl.abort();
  assert.equal(await done, 'deny');
  assert.equal(sawSignal, ctrl.signal, 'the gate forwards the turn signal to the transport');
});

test('an already-aborted signal denies immediately', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const captured = { params: [] as RequestPermissionParams[], signals: [] as Array<AbortSignal | undefined> };
  assert.equal(await makeGate(selected('allow_once'), captured).gate.request(makeReq({ signal: ctrl.signal })), 'deny');
  assert.equal(captured.params.length, 0, 'nothing is asked once the turn is already gone');
});
