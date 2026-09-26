import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../lib/state.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-state-queue-'));
  const path = join(dir, 'state.sqlite');
  const f = { state: new State(path), reopen() { this.state.close(); this.state = new State(path); } };
  t.after(async () => { f.state.close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}

const input = text => [{ type: 'text', text }];

test('prepared inputs and per-chat order survive reopen, while duplicate messages retain the original item', async t => {
  const f = await fixture(t);
  const prepared = [...input('Проверь фотографию'), { type: 'localImage', path: '/home/user/.codex-telegram/files/A/photo.jpg' }];
  const first = f.state.queueTurn('A', { messageId: 10, input: prepared, preview: 'Фотография' });
  const second = f.state.queueTurn('A', { messageId: 11, input: input('Теперь отчёт'), preview: 'Отчёт' });
  const other = f.state.queueTurn('B', { messageId: 10, input: input('Другой чат'), preview: 'Другой чат' });
  assert.equal(first.status, 'waiting');
  assert.ok(Number.isInteger(first.created) && first.created > 0);
  f.reopen();
  const duplicate = f.state.queueTurn('A', { messageId: 10, input: input('Changed duplicate'), preview: 'Changed' });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(f.state.queuedTurns('A'), [first, second]);
  assert.deepEqual(f.state.queuedTurns('B'), [other]);
  assert.deepEqual(f.state.queueItem(first.id).input, prepared);
  assert.equal(f.state.queueItem(9999), null);
});

test('recovery marks only interrupted dispatches uncertain, persists them and never returns them a second time', async t => {
  const f = await fixture(t);
  const waiting = f.state.queueTurn('A', { messageId: 1, input: input('Waiting') });
  const dispatching = f.state.queueTurn('A', { messageId: 2, input: input('In flight') });
  const otherDispatching = f.state.queueTurn('B', { messageId: 3, input: input('Another flight') });
  const alreadyUncertain = f.state.queueTurn('A', { messageId: 4, input: input('Already uncertain') });
  const sent = f.state.queueTurn('A', { messageId: 5, input: input('Sent') });
  f.state.queueStatus(dispatching.id, 'dispatching');
  f.state.queueStatus(otherDispatching.id, 'dispatching');
  f.state.queueStatus(alreadyUncertain.id, 'uncertain');
  f.state.queueStatus(sent.id, 'sent');
  f.reopen();
  const recovered = f.state.recoverQueue();
  assert.deepEqual(recovered.map(row => [row.id, row.status]), [[dispatching.id, 'uncertain'], [otherDispatching.id, 'uncertain']]);
  assert.equal(f.state.queueItem(waiting.id).status, 'waiting');
  assert.equal(f.state.queueItem(sent.id).status, 'sent');
  assert.deepEqual(f.state.recoverQueue(), []);
  f.reopen();
  assert.deepEqual(f.state.queuedTurns('A').map(row => [row.id, row.status]), [[waiting.id, 'waiting'], [dispatching.id, 'uncertain'], [alreadyUncertain.id, 'uncertain']]);
  assert.deepEqual(f.state.recoverQueue(), []);
});

test('cancellation checks the owning chat and refuses already dispatched, finished or cancelled items', async t => {
  const f = await fixture(t);
  for (const [index, status] of ['waiting', 'uncertain', 'dispatching', 'sent', 'error', 'cancelled'].entries()) {
    const item = f.state.queueTurn('A', { messageId: index, input: input(status) });
    f.state.queueStatus(item.id, status);
    assert.equal(f.state.cancelQueued(item.id, 'B'), false);
    assert.equal(f.state.queueItem(item.id).status, status);
    const allowed = ['waiting', 'uncertain'].includes(status);
    assert.equal(f.state.cancelQueued(item.id, 'A'), allowed);
    assert.equal(f.state.queueItem(item.id).status, allowed ? 'cancelled' : status);
    assert.equal(f.state.cancelQueued(item.id, 'A'), false);
  }
  assert.equal(f.state.cancelQueued(9999, 'A'), false);
  assert.deepEqual(f.state.queuedTurns('A').map(row => row.status), ['dispatching']);
});

test('status validation cannot corrupt a queued item and terminal duplicates do not queue it again', async t => {
  const f = await fixture(t);
  const item = f.state.queueTurn('A', { messageId: 10, input: input('One execution') });
  assert.throws(() => f.state.queueStatus(item.id, 'pending'), /Invalid queued turn status/);
  assert.equal(f.state.queueItem(item.id).status, 'waiting');
  assert.equal(f.state.queueStatus(item.id, 'sent'), true);
  assert.equal(f.state.queueStatus(9999, 'waiting'), false);
  f.reopen();
  const duplicate = f.state.queueTurn('A', { messageId: 10, input: input('Duplicate after send') });
  assert.equal(duplicate.id, item.id);
  assert.equal(duplicate.status, 'sent');
  assert.deepEqual(duplicate.input, input('One execution'));
  assert.deepEqual(f.state.queuedTurns('A'), []);
});
