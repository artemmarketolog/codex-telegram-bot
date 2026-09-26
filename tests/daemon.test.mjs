import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDaemon } from '../scripts/ensure-codex-daemon.mjs';

test('leaves an existing shared daemon alone', async () => {
  const calls = [];
  const result = await ensureDaemon({ run: async action => {
    calls.push(action);
    return { status: 'running', appServerVersion: '0.155.1' };
  } });
  assert.deepEqual(calls, ['version']);
  assert.deepEqual(result, { status: 'running', action: 'none', version: '0.155.1' });
});

test('starts an absent daemon once and confirms it is running', async () => {
  const calls = [];
  const replies = [{ status: 'notRunning' }, { started: true }, { status: 'running', appServerVersion: '0.155.1' }];
  const result = await ensureDaemon({ run: async action => { calls.push(action); return replies.shift(); } });
  assert.deepEqual(calls, ['version', 'start', 'version']);
  assert.equal(result.action, 'started');
});

test('status-only and unknown states never start a daemon', async () => {
  const calls = [];
  assert.deepEqual(await ensureDaemon({ statusOnly: true, run: async action => {
    calls.push(action); return { status: 'notRunning' };
  } }), { status: 'notRunning', action: 'none' });
  assert.deepEqual(calls, ['version']);
  await assert.rejects(ensureDaemon({ run: async action => {
    assert.equal(action, 'version'); return { status: 'unexpected' };
  } }), /unrecognized state/);
});

test('failed start confirmation fails instead of retrying or stopping anything', async () => {
  const calls = [];
  await assert.rejects(ensureDaemon({ run: async action => {
    calls.push(action); return { status: 'notRunning' };
  } }), /did not produce a running daemon/);
  assert.deepEqual(calls, ['version', 'start', 'version']);
});
