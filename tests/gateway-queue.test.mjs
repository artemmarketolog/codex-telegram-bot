import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../lib/gateway.mjs';
import { State } from '../lib/state.mjs';

const ownerId = 123456789;
const project = { key: 'project', label: 'Project', path: '/projects/example' };
const textInput = text => [{ type: 'text', text }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class Codex extends EventEmitter {
  connected = true;
  calls = [];
  turns = new Map();
  sequence = 0;
  async connect() { this.connected = true; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.beforeRequest) await this.beforeRequest(method, params);
    if (method === 'model/list') return { data: [{ model: 'test-model' }] };
    if (method === 'thread/resume') return {
      thread: { id: params.threadId, name: `Chat ${params.threadId}`, status: { type: this.turns.get(params.threadId)?.[0]?.status === 'inProgress' ? 'active' : 'idle' } },
      cwd: project.path, model: 'test-model', reasoningEffort: 'low', instructionSources: [],
    };
    if (method === 'thread/turns/list') return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    if (method === 'turn/start') {
      const turn = { id: `queued-turn-${++this.sequence}`, status: 'inProgress', startedAt: Date.now() / 1000, items: [] };
      this.turns.set(params.threadId, [turn]);
      return { turn };
    }
    if (['turn/steer', 'turn/interrupt', 'thread/name/set'].includes(method)) return {};
    throw new Error(`Unexpected fake Codex request: ${method}`);
  }
  async close() { this.connected = false; }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-gateway-queue-'));
  const state = new State(join(dir, 'state.sqlite'));
  const codex = new Codex();
  const sent = [];
  const downloads = [];
  const api = {
    async request(method, params) { sent.push({ method, params }); return method === 'getMe' ? { id: 987654321 } : true; },
    async sendText(chatId, text, options) { sent.push({ method: 'sendText', chatId, text, options }); return [{ message_id: 10000 + sent.length }]; },
    async editText(chatId, messageId, text, options) { sent.push({ method: 'editText', chatId, messageId, text, options }); return true; },
    async download(fileId, path) { downloads.push({ fileId, path }); await writeFile(path, 'queued file contents', { mode: 0o600 }); return { size: 20 }; },
    stop() {},
  };
  const gateway = new Gateway({ api, codex, state, ownerId, root: dir, dataDir: dir, projects: [project] });
  gateway.log = () => {};
  for (const [index, id] of ['A', 'B'].entries()) {
    state.saveTopic({ id: 21 + index, threadId: id, name: `Project · Chat ${id}`, projectKey: project.key, auto: true });
    state.saveChat({ id, title: `Chat ${id}`, cwd: project.path, watching: true, watchSince: 1, model: 'test-model', effort: 'low', status: 'active', turnId: `original-${id}`, startedAt: Date.now() });
    codex.turns.set(id, [{ id: `original-${id}`, status: 'inProgress', startedAt: Date.now() / 1000, items: [] }]);
  }
  t.after(async () => { await gateway.close(); state.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, state, codex, api, sent, downloads, gateway };
}

// Messages are sent in chat A's topic unless a test names another topic.
const message = (id, text, extra = {}) => ({ update_id: id, message: { message_id: id, text, from: { id: ownerId, is_bot: false }, chat: { id: ownerId, type: 'private' }, message_thread_id: 21, is_topic_message: true, ...extra } });
const callback = (f, id, type, data) => ({ update_id: id, callback_query: { id: `query-${id}`, from: { id: ownerId, is_bot: false }, message: { message_id: 500, chat: { id: ownerId, type: 'private' } }, data: f.gateway.button(type, type, data).callback_data } });
const calls = (f, method) => f.codex.calls.filter(call => call.method === method);

async function settled(f) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!f.gateway.draining && !f.gateway.queueRunners.size && !f.state.pending().length) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Gateway did not finish processing the test updates');
}
async function receive(f, update) { await f.gateway.receive(update); await settled(f); }
async function complete(f, id, status = 'completed') {
  const previous = f.codex.turns.get(id)[0];
  const turn = { ...previous, status, completedAt: Date.now() / 1000 };
  f.codex.turns.set(id, [turn]);
  await f.gateway.onEvent('turn/completed', { threadId: id, turn });
  await settled(f);
}

test('ordinary messages during active work steer the existing turn immediately', async t => {
  const f = await fixture(t);
  await receive(f, message(1, 'Уточнение: сохрани результат в PDF'));
  assert.deepEqual(calls(f, 'turn/steer').map(call => call.params), [{ threadId: 'A', expectedTurnId: 'original-A', input: textInput('Уточнение: сохрани результат в PDF') }]);
  assert.equal(calls(f, 'turn/start').length, 0);
  assert.deepEqual(f.state.queuedTurns('A'), []);
});

test('an explicit queued file is prepared once and duplicate Telegram updates neither steer nor duplicate it', async t => {
  const f = await fixture(t);
  const update = message(10, undefined, { caption: '/queue Проверь после текущего ответа', document: { file_id: 'test-file', file_unique_id: 'unique-file', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 20 } });
  await receive(f, update);
  await receive(f, update);
  const items = f.state.queuedTurns('A');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'waiting');
  assert.equal(items[0].messageId, 10);
  assert.equal(items[0].preview, 'Проверь после текущего ответа');
  assert.equal(f.downloads.length, 1);
  assert.equal(await readFile(f.downloads[0].path, 'utf8'), 'queued file contents');
  assert.ok(items[0].input[0].text.includes(f.downloads[0].path));
  assert.ok(items[0].input[0].text.startsWith('Проверь после текущего ответа'));
  assert.equal(calls(f, 'turn/steer').length, 0);
  assert.equal(calls(f, 'turn/start').length, 0);
});

test('queued turns start in FIFO order only after each preceding turn completes', async t => {
  const f = await fixture(t);
  await receive(f, message(20, '/queue First next request'));
  await receive(f, message(21, '/queue Second next request'));
  assert.equal(calls(f, 'turn/start').length, 0);
  await complete(f, 'A');
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('First next request')]);
  await f.gateway.runQueued('A');
  assert.equal(calls(f, 'turn/start').length, 1);
  await complete(f, 'A');
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('First next request'), textInput('Second next request')]);
  assert.deepEqual(f.state.queuedTurns('A'), []);
  assert.equal(calls(f, 'turn/steer').length, 0);
});

test('/stop interrupts the current turn and keeps queued requests paused after its completion', async t => {
  const f = await fixture(t);
  await receive(f, message(30, '/queue Later request'));
  await receive(f, message(31, '/stop'));
  assert.deepEqual(calls(f, 'turn/interrupt').map(call => call.params), [{ threadId: 'A', turnId: 'original-A' }]);
  assert.equal(f.state.chat('A').queuePaused, true);
  await complete(f, 'A', 'interrupted');
  await f.gateway.runQueued('A');
  assert.equal(calls(f, 'turn/start').length, 0);
  assert.equal(f.state.queuedTurns('A')[0].status, 'waiting');
});

test('queue pause, cancellation and resume preserve only the remaining waiting request', async t => {
  const f = await fixture(t);
  await receive(f, message(40, '/queue Cancel me'));
  await receive(f, message(41, '/queue Keep me'));
  const [cancelled] = f.state.queuedTurns('A');
  await receive(f, callback(f, 42, 'queue_pause', { id: 'A' }));
  await receive(f, callback(f, 43, 'queue_remove', { id: 'A', itemId: cancelled.id }));
  assert.equal(f.state.queueItem(cancelled.id).status, 'cancelled');
  assert.equal(calls(f, 'turn/interrupt').length, 0);
  await complete(f, 'A');
  assert.equal(calls(f, 'turn/start').length, 0);
  await receive(f, callback(f, 44, 'queue_resume', { id: 'A' }));
  assert.equal(f.state.chat('A').queuePaused, false);
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('Keep me')]);
});

test('queue-next applies once to the next message of its own topic while other topics keep steering', async t => {
  const f = await fixture(t);
  await receive(f, callback(f, 50, 'queue_next', { id: 'A' }));
  await receive(f, message(51, 'Normal correction for B', { message_thread_id: 22 }));
  const update = message(52, 'One queued message for A');
  await receive(f, update);
  await receive(f, update);
  await receive(f, message(53, 'Normal correction for A'));
  assert.deepEqual(f.state.queuedTurns('A').map(item => item.input), [textInput('One queued message for A')]);
  assert.deepEqual(f.state.queuedTurns('B'), []);
  assert.equal(f.state.get('queueNext'), null);
  assert.deepEqual(calls(f, 'turn/steer').map(call => [call.params.threadId, call.params.input]), [['B', textInput('Normal correction for B')], ['A', textInput('Normal correction for A')]]);
  assert.deepEqual(f.sent.filter(item => item.method === 'setMessageReaction').map(item => [item.params.message_id, item.params.reaction[0].emoji]), [[51, '👀'], [52, '✍'], [53, '👀']]);
});

test('startup recovery blocks uncertain dispatches and requires removal before the remaining queue resumes', async t => {
  const f = await fixture(t);
  const interrupted = f.state.queueTurn('A', { messageId: 60, input: textInput('May already have executed'), preview: 'Unconfirmed' });
  f.state.queueStatus(interrupted.id, 'dispatching');
  f.state.queueTurn('A', { messageId: 61, input: textInput('Definitely waiting'), preview: 'Next' });
  f.codex.turns.set('A', []);
  await f.gateway.start();
  await settled(f);
  assert.equal(f.state.queueItem(interrupted.id).status, 'uncertain');
  assert.equal(f.state.chat('A').queuePaused, true);
  await receive(f, callback(f, 62, 'queue_resume', { id: 'A' }));
  assert.equal(calls(f, 'turn/start').length, 0);
  assert.equal(f.state.chat('A').queuePaused, true);
  await receive(f, callback(f, 63, 'queue_remove', { id: 'A', itemId: interrupted.id }));
  await receive(f, callback(f, 64, 'queue_resume', { id: 'A' }));
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('Definitely waiting')]);
});

test('cancelling while the latest-turn lookup is pending prevents the selected queue item from dispatching', async t => {
  const f = await fixture(t);
  const item = f.state.queueTurn('A', { messageId: 70, input: textInput('Must not dispatch'), preview: 'Cancel during lookup' });
  f.codex.turns.set('A', []);
  const entered = deferred();
  const release = deferred();
  f.codex.beforeRequest = async method => { if (method === 'thread/turns/list') { entered.resolve(); await release.promise; } };
  const running = f.gateway.runQueued('A');
  await entered.promise;
  try {
    await f.gateway.receive(callback(f, 71, 'queue_remove', { id: 'A', itemId: item.id }));
    assert.equal(f.state.queueItem(item.id).status, 'cancelled');
  } finally { release.resolve(); await running; }
  assert.equal(calls(f, 'turn/start').length, 0);
  assert.equal(f.state.queueItem(item.id).status, 'cancelled');
});

test('text corrections reach the active turn while another queued attachment is still downloading', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const download = f.api.download;
  f.api.download = async (...args) => { entered.resolve(); await release.promise; return download(...args); };
  await f.gateway.receive(message(80, undefined, { caption: '/queue Read this file later', document: { file_id: 'slow-file', file_unique_id: 'slow-unique', file_name: 'later.txt', mime_type: 'text/plain', file_size: 20 } }));
  await entered.promise;
  try {
    await f.gateway.receive(message(81, 'Urgent correction during upload'));
    for (let i = 0; i < 100 && !calls(f, 'turn/steer').length; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls(f, 'turn/steer').map(call => call.params.input), [textInput('Urgent correction during upload')]);
    assert.equal(f.downloads.length, 0);
  } finally { release.resolve(); await settled(f); }
  assert.equal(f.state.queuedTurns('A').length, 1);
  assert.equal(calls(f, 'turn/start').length, 0);
});

test('ordinary input arriving during a queued start waits and then steers the newly started turn', async t => {
  const f = await fixture(t);
  f.codex.turns.set('A', []);
  const item = f.state.queueTurn('A', { messageId: 90, input: textInput('Queued request'), preview: 'Queued request' });
  const entered = deferred();
  const release = deferred();
  f.codex.beforeRequest = async method => { if (method === 'turn/start') { entered.resolve(); await release.promise; } };
  const queued = f.gateway.runQueued('A');
  await entered.promise;
  const ordinary = f.gateway.content({ message_id: 91, text: 'Correction during the start' }, 'A');
  let results;
  try {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls(f, 'turn/start').length, 1, 'Two concurrent starts were submitted for the same chat');
  } finally { release.resolve(); results = await Promise.allSettled([queued, ordinary]); }
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(f.state.queueItem(item.id).status, 'sent');
  assert.equal(calls(f, 'turn/start').length, 1);
  assert.deepEqual(calls(f, 'turn/steer').map(call => call.params), [{ threadId: 'A', expectedTurnId: f.codex.turns.get('A')[0].id, input: textInput('Correction during the start') }]);
});

test('/stop during an unconfirmed queued start interrupts that new turn as soon as its ID is known', async t => {
  const f = await fixture(t);
  f.codex.turns.set('A', []);
  const item = f.state.queueTurn('A', { messageId: 100, input: textInput('Starting request'), preview: 'Starting request' });
  const entered = deferred();
  const release = deferred();
  f.codex.beforeRequest = async method => { if (method === 'turn/start') { entered.resolve(); await release.promise; } };
  const queued = f.gateway.runQueued('A');
  await entered.promise;
  const stopping = f.gateway.stopTurn('A');
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await Promise.all([queued, stopping]);
  assert.equal(f.state.queueItem(item.id).status, 'sent');
  assert.equal(f.state.chat('A').queuePaused, true);
  assert.deepEqual(calls(f, 'turn/interrupt').map(call => call.params), [{ threadId: 'A', turnId: f.codex.turns.get('A')[0].id }]);
});

test('recovering a completed answer with a question keeps the queue waiting until the user answers', async t => {
  const f = await fixture(t);
  const item = f.state.queueTurn('A', { messageId: 110, input: textInput('Run after the answer'), preview: 'After question' });
  f.codex.turns.set('A', [{ id: 'original-A', status: 'completed', startedAt: Date.now() / 1000, completedAt: Date.now() / 1000, items: [
    { id: 'question-final', type: 'agentMessage', phase: 'final_answer', text: 'Какой формат выбрать?', questions: [{ id: 'format', question: 'PDF или DOCX?' }] },
  ] }]);
  await f.gateway.recoverChat('A');
  await settled(f);
  assert.equal(f.state.chat('A').awaitingAnswer, true);
  assert.equal(f.state.queueItem(item.id).status, 'waiting');
  assert.equal(calls(f, 'turn/start').length, 0);
  await receive(f, message(111, 'Выбери PDF'));
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('Выбери PDF')]);
  assert.equal(f.state.chat('A').awaitingAnswer, false);
  assert.equal(f.state.queueItem(item.id).status, 'waiting');
  await complete(f, 'A');
  assert.deepEqual(calls(f, 'turn/start').map(call => call.params.input), [textInput('Выбери PDF'), textInput('Run after the answer')]);
});
