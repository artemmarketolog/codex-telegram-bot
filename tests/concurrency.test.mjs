// Several chats at once: a download, an answer or an upload in one chat never holds another chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../lib/gateway.mjs';
import { State } from '../lib/state.mjs';

const OWNER = 123456789;
const PROJECT = { key: 'workspace', label: 'Workspace', path: '/home/user/workspace', favorite: true };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
// Waits for a condition instead of a fixed pause: a busy machine must not fail the test.
async function until(condition, ms = 5000) {
  for (const deadline = Date.now() + ms; !condition() && Date.now() < deadline;) await tick(10);
  return condition();
}

class Codex extends EventEmitter {
  connected = true;
  calls = [];
  listed = [];
  turns = new Map();
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/list') return { data: this.listed, nextCursor: null };
    if (method === 'thread/resume') return { thread: { id: params.threadId, name: params.threadId, status: { type: 'idle' } }, cwd: PROJECT.path, model: 'm', reasoningEffort: 'low', instructionSources: [] };
    if (method === 'thread/turns/list') return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}` } };
    if (['thread/name/set', 'thread/backgroundTerminals/list'].includes(method)) return { data: [] };
    throw new Error(`Unexpected Codex request ${method}`);
  }
  respond() {} reject() {}
  async close() {}
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-concurrency-'));
  const state = new State(join(dir, 'state.sqlite'));
  const codex = new Codex();
  const gates = {};
  const calls = [];
  let id = 1000;
  const api = {
    async request(method, params) { calls.push({ method, params }); return method === 'createForumTopic' ? { message_thread_id: ++id } : true; },
    async sendText(chatId, text, options = {}) { calls.push({ method: 'sendText', text, options }); return [{ message_id: ++id }]; },
    async sendAnswer(chatId, text, options = {}) { if (gates.answer && text.includes('A')) await gates.answer.promise; calls.push({ method: 'sendAnswer', text, options }); return [{ message_id: ++id }]; },
    async editText() { return true; },
    async sendDocument(chatId, path, options = {}) { await gates.upload?.promise; calls.push({ method: 'sendDocument', path, options }); return { message_id: ++id }; },
    async download(fileId, path, { signal } = {}) { await gates.download?.promise; signal?.throwIfAborted(); await writeFile(path, 'x'); return { size: 1 }; },
    stop() {},
  };
  const gateway = new Gateway({ api, codex, state, ownerId: OWNER, root: dir, dataDir: dir, projects: [PROJECT] });
  gateway.log = () => {};
  for (const [index, chat] of ['A', 'B'].entries()) {
    state.saveTopic({ id: 21 + index, threadId: chat, name: `Workspace · ${chat}`, projectKey: PROJECT.key, auto: true });
    state.saveChat({ id: chat, title: chat, cwd: PROJECT.path, watching: true, watchSince: 1, model: 'm', effort: 'low', status: 'idle' });
  }
  t.after(async () => { for (const g of Object.values(gates)) g.open(); await gateway.close(); state.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, state, codex, api, calls, gates, gateway };
}
let update = 1;
const inTopic = (topic, fields) => ({ update_id: update, message: { message_id: update++, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, message_thread_id: topic, is_topic_message: true, ...fields } });
const started = f => f.codex.calls.filter(c => c.method === 'turn/start').map(c => c.params.threadId);

test('a download in one chat does not hold a message to another chat', async t => {
  const f = await fixture(t);
  f.gates.download = gate();
  await f.gateway.receive(inTopic(21, { document: { file_id: 'big', file_unique_id: 'u', file_name: 'big.zip', file_size: 1 } }));
  assert.ok(await until(() => f.gateway.mediaJobs.size === 1), 'the download in chat A did not start');
  await f.gateway.receive(inTopic(22, { text: 'задача для B' }));
  assert.ok(await until(() => started(f).includes('B')), 'chat B waited for chat A\'s download');
  assert.deepEqual(started(f), ['B']);
  f.gates.download.open();
  await f.gateway.drain();
  assert.deepEqual(started(f), ['B', 'A']);
});

test('a slow answer in one chat does not hold the events of another chat', async t => {
  const f = await fixture(t);
  f.gates.answer = gate();
  const answer = (thread, text) => f.codex.emit('notification', 'item/completed', { threadId: thread, turnId: `turn-${thread}`, item: { type: 'agentMessage', id: `${thread}-1`, text } });
  answer('A', 'ответ A');
  answer('B', 'ответ B');
  assert.ok(await until(() => f.calls.some(c => c.method === 'sendAnswer')), 'chat B waited for chat A\'s answer');
  assert.deepEqual(f.calls.filter(c => c.method === 'sendAnswer').map(c => c.text), ['ответ B']);
  f.gates.answer.open();
  await f.gateway.eventChain;
  assert.deepEqual(f.calls.filter(c => c.method === 'sendAnswer').map(c => c.text), ['ответ B', 'ответ A']);
});

test('a file upload from /files does not hold messages to other chats', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'report.txt');
  await writeFile(path, 'отчёт');
  const file = f.state.addFile('A', { path, name: 'report.txt', size: 10, direction: 'out' });
  f.gates.upload = gate();
  await f.gateway.receive({ update_id: update++, callback_query: { id: 'cb', from: { id: OWNER, is_bot: false }, data: f.gateway.button('x', 'file', { id: file.id }).callback_data,
    message: { message_id: 77, chat: { id: OWNER, type: 'private' }, message_thread_id: 21 } } });
  await f.gateway.receive(inTopic(22, { text: 'задача для B' }));
  assert.ok(await until(() => started(f).includes('B')), 'chat B waited for the upload');
  assert.deepEqual(started(f), ['B']);
  f.gates.upload.open();
  await Promise.allSettled([...f.gateway.tasks]);
  assert.equal(f.calls.filter(c => c.method === 'sendDocument').length, 1);
});

test('a chat started in the Codex app gets its topic by itself and shows its answers', async t => {
  const f = await fixture(t);
  const now = () => Date.now() / 1000;
  const thread = (id, extra = {}) => ({ id, source: 'vscode', parentThreadId: null, ephemeral: false, cwd: PROJECT.path, name: `Чат ${id}`, status: { type: 'notLoaded' }, createdAt: now(), updatedAt: now(), ...extra });
  const turn = (id, text) => ({ id, status: 'completed', startedAt: now(), items: [{ type: 'agentMessage', id: `${id}-answer`, text }] });
  const topics = () => f.calls.filter(c => c.method === 'createForumTopic').length;
  const answers = () => f.calls.filter(c => c.method === 'sendAnswer').map(c => c.text);
  f.codex.listed = [thread('old', { createdAt: now() - 3600, updatedAt: now() - 60 })];
  await f.gateway.pollDesktopThreads();   // switches auto topics on: what is already there stays as it is
  assert.equal(topics(), 0);
  await tick(20);
  f.codex.turns.set('N', [turn('N-1', 'ответ с компьютера')]);
  f.codex.listed = [thread('N'), thread('script', { source: 'exec' }), ...f.codex.listed];
  await f.gateway.pollDesktopThreads();
  assert.equal(topics(), 1);
  assert.deepEqual(answers(), ['ответ с компьютера']);
  assert.ok(f.gateway.subscribed.has('N'));
  // Idle for 30 minutes: unsubscribed. Worked in again on the computer: watched again, the answer arrives.
  f.gateway.subscribed.delete('N');
  f.state.saveChat({ id: 'N', watching: false });
  await tick(20);
  f.codex.turns.set('N', [turn('N-2', 'второй ответ'), ...f.codex.turns.get('N')]);
  f.codex.listed[0] = thread('N', { createdAt: f.codex.listed[0].createdAt, updatedAt: now() + 1 });
  await f.gateway.pollDesktopThreads();
  assert.equal(topics(), 1);
  assert.deepEqual(answers(), ['ответ с компьютера', 'второй ответ']);
  // The owner deleted the topic: it is not brought back.
  f.gateway.subscribed.delete('N');
  f.state.deleteTopic(f.state.topicForThread('N').id);
  f.codex.listed[0] = thread('N', { createdAt: f.codex.listed[0].createdAt, updatedAt: now() + 5 });
  await f.gateway.pollDesktopThreads();
  assert.equal(topics(), 1);
});

test('the card shows what the agent says along the way, not the final answer', async t => {
  const f = await fixture(t);
  const edits = [];
  f.api.editText = async (chatId, messageId, text) => { edits.push(text); return true; };
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'turn-A', startedAt: Date.now(), card: { messageId: 900, topicId: 21, turnId: 'turn-A', collapsed: false } });
  const item = (id, phase, text) => ({ threadId: 'A', turnId: 'turn-A', item: { type: 'agentMessage', id, phase, text } });
  await f.gateway.onEvent('item/completed', item('c1', 'commentary', '**Смотрю** логи,\nпотом перезапущу.'));
  await f.gateway.refreshStatus('A');
  assert.ok(edits.at(-1).endsWith('</pre>\n<b>Смотрю</b> логи,\nпотом перезапущу.'), edits.at(-1));
  assert.deepEqual(f.calls.filter(c => c.method === 'sendAnswer'), [], 'a comment was delivered as an answer');
  await f.gateway.onEvent('item/completed', { threadId: 'A', turnId: 'turn-A', item: { type: 'reasoning', id: 'r1', summary: ['Проверяю конфиг сервиса.'], content: [] } });
  await f.gateway.refreshStatus('A');
  assert.ok(edits.at(-1).endsWith('</pre>\n<b>Смотрю</b> логи,\nпотом перезапущу.\n\nПроверяю конфиг сервиса.'), edits.at(-1));
  await f.gateway.onEvent('turn/completed', { threadId: 'A', turn: { id: 'turn-A', status: 'completed', items: [], completedAt: Date.now() / 1000, durationMs: 1000 } });
  assert.match(edits.at(-1), /^<code>(💻 )?✓ [^<]*<\/code>\n<blockquote expandable><b>Смотрю<\/b> логи,\nпотом перезапущу\.\n\nПроверяю конфиг сервиса\.<\/blockquote>$/, 'the finished card lost its history');
  await f.gateway.onEvent('turn/started', { threadId: 'A', turn: { id: 'turn-A2', startedAt: Date.now() / 1000, items: [] } });
  await f.gateway.refreshStatus('A');
  const next = f.calls.filter(c => c.method === 'sendText' && c.text.startsWith('<pre>')).at(-1);
  assert.ok(next && !next.text.includes('Смотрю логи'), 'the next turn kept the old log');
});

test('«Новый чат» in Telegram (a topic named /new plus /new) is one chat in that topic', async t => {
  const f = await fixture(t);
  const service = { update_id: update, message: { message_id: update++, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, message_thread_id: 40, is_topic_message: true,
    forum_topic_created: { name: '/new', is_name_implicit: true } } };
  await f.gateway.receive(service);
  await f.gateway.receive(inTopic(40, { text: '/new' }));
  await Promise.allSettled([...f.gateway.tasks]);
  assert.equal(f.calls.filter(c => c.method === 'createForumTopic').length, 0, 'a second topic appeared');
  assert.ok(f.calls.some(c => c.method === 'sendText' && c.text.startsWith('📁 Workspace') && c.options.message_thread_id === 40), 'no project line in the topic');
  assert.ok(f.calls.some(c => c.method === 'editForumTopic' && c.params.message_thread_id === 40 && c.params.name === 'Новый чат · Workspace'));
});

test('a chat started in the bot gets a short title after its first answer, once, in Codex and in the topic', async t => {
  const f = await fixture(t);
  const asked = [];
  f.gateway.generateTitle = async text => { asked.push(text); return 'Статистика Москвы'; };
  const finish = async (turnId, question, answer) => {
    f.state.saveChat({ id: 'A', status: 'active', turnId, startedAt: Date.now() });
    await f.gateway.onEvent('turn/completed', { threadId: 'A', turn: { id: turnId, status: 'completed', completedAt: Date.now() / 1000, durationMs: 1000,
      items: [{ type: 'userMessage', content: [{ type: 'text', text: question }] }, { type: 'agentMessage', id: `${turnId}-a`, text: answer }] } });
  };
  f.state.saveChat({ id: 'A', aiTitle: 'pending', title: 'Ты можешь пожалуйста подключиться к рекламному кабинету' });
  await finish('turn-1', 'подключись к рекламному кабинету', 'Лидов 124');
  assert.ok(await until(() => f.state.chat('A').title === 'Статистика Москвы'));
  assert.equal(asked[0], 'Запрос: подключись к рекламному кабинету\n\nНачало ответа: Лидов 124');
  assert.ok(f.codex.calls.some(c => c.method === 'thread/name/set' && c.params.name === 'Статистика Москвы'));
  assert.ok(await until(() => f.calls.some(c => c.method === 'editForumTopic' && c.params.name === 'Статистика Москвы · Workspace')));
  await finish('turn-2', 'а за прошлую?', 'Лидов 98');
  assert.equal(asked.length, 1, 'titled again');
});

test('a title comes from one ephemeral read-only turn of a light model, unloaded right after', async t => {
  const f = await fixture(t);
  f.gateway.models = [{ model: 'gpt-6-astra', isDefault: true }, { model: 'gpt-6-luna' }];
  f.codex.request = async (method, params) => {
    f.codex.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'T1' } };
    if (method === 'turn/start') {
      setTimeout(() => {
        f.codex.emit('notification', 'item/completed', { threadId: 'T1', item: { type: 'agentMessage', text: '«Статистика Москвы за неделю».\nлишнее' } });
        f.codex.emit('notification', 'turn/completed', { threadId: 'T1', turn: { id: 't', status: 'completed', items: [] } });
      }, 5);
      return { turn: { id: 't' } };
    }
    return {};
  };
  assert.equal(await f.gateway.generateTitle('Запрос: статистика по Москве'), 'Статистика Москвы за неделю');
  const start = f.codex.calls.find(c => c.method === 'thread/start').params;
  assert.deepEqual([start.ephemeral, start.sandbox, start.model], [true, 'read-only', 'gpt-6-luna']);
  assert.match(f.codex.calls.find(c => c.method === 'turn/start').params.input[0].text, /«Запрос: статистика по Москве»/, 'the task did not reach the model');
  assert.ok(f.codex.calls.some(c => c.method === 'thread/unsubscribe' && c.params.threadId === 'T1'));
});
