import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../lib/state.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-state-topics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('migration drops only the global selection and keeps chats, bindings, files and queue', async t => {
  const path = join(await directory(t), 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chats (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL);`);
  for (const [key, value] of [['activeThread', '"A"'], ['activeDraft', '"draft:x"'], ['activeProject', '"p"'], ['queueNext', 'null'], ['telegramOffset', '42'], ['defaultModel', '"m"']]) legacy.prepare('INSERT INTO settings VALUES (?,?)').run(key, value);
  legacy.prepare('INSERT INTO chats VALUES (?,?)').run('A', JSON.stringify({ id: 'A', title: 'Chat', watching: true }));
  legacy.prepare('INSERT INTO messages VALUES (?,?)').run(7, 'A');
  legacy.close();
  const state = new State(path);
  assert.equal(state.get('activeThread'), null);
  assert.equal(state.get('activeDraft'), null);
  assert.equal(state.get('telegramOffset'), 42);
  assert.equal(state.get('defaultModel'), 'm');
  assert.equal(state.chat('A').title, 'Chat');
  assert.equal(state.threadForMessage(7), 'A');
  assert.equal(state.db.prepare('PRAGMA user_version').get().user_version, 1);
  state.set('activeThread', 'kept after migration');
  state.close();
  const reopened = new State(path);
  assert.equal(reopened.get('activeThread'), 'kept after migration', 'migration runs once');
  reopened.close();
});

test('a chat is bound to one topic and held updates are released to the chosen address', async t => {
  const state = new State(join(await directory(t), 'state.sqlite'));
  t.after(() => state.close());
  state.saveTopic({ id: 5, threadId: 'A', name: 'first', auto: true });
  state.saveTopic({ id: 6, threadId: 'A', name: 'recreated' });
  assert.equal(state.topic(5), null);
  assert.equal(state.topicForThread('A').id, 6);
  assert.deepEqual(state.saveTopic({ id: 6, pickerMessageId: 9 }), { id: 6, threadId: 'A', name: 'recreated', pickerMessageId: 9 });
  state.enqueue({ update_id: 1, message: {} }, 'lobby');
  state.enqueue({ update_id: 2, message: {} }, 'lobby');
  state.hold(1); state.hold(2);
  assert.deepEqual(state.pending(), []);
  assert.equal(state.unfinishedUpdates('lobby'), 2);
  assert.equal(state.release('lobby', 'topic:6'), 2);
  assert.deepEqual(state.pending().map(row => [row.id, row.thread_id]), [[1, 'topic:6'], [2, 'topic:6']]);
});
