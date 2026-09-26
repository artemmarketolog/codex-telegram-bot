import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Gateway } from '../lib/gateway.mjs';
import { State } from '../lib/state.mjs';

const ownerId = 123456789;
const secret = 'fixture-private-token-9f3a1d27';
const projects = ['alpha', 'beta'].map(key => ({ key, label: key, path: `/projects/${key}`, favorite: true }));

class Codex extends EventEmitter {
  connected = false;
  calls = [];
  threads = new Map();
  turns = new Map();
  sequence = 0;
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.beforeRequest) await this.beforeRequest(method, params);
    if (method === 'thread/start') {
      const id = `native-${++this.sequence}`;
      const thread = { id, cwd: params.cwd, name: id, status: { type: 'idle' } };
      this.threads.set(id, thread);
      return { thread, cwd: params.cwd, model: 'test-model', reasoningEffort: 'low', instructionSources: [] };
    }
    if (method === 'thread/resume') return {
      thread: this.threads.get(params.threadId) ?? { id: params.threadId, name: 'Existing', status: { type: 'idle' } },
      cwd: projects[0].path, model: 'test-model', reasoningEffort: 'low', instructionSources: [],
    };
    if (method === 'thread/name/set' || method === 'turn/steer') return {};
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/turns/list') return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.sequence}`, status: 'inProgress', startedAt: Date.now() / 1000, items: [] };
      this.turns.set(params.threadId, [turn]);
      return { turn };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected test request: ${method}`);
  }
  respond(id, result) { this.calls.push({ method: 'respond', id, result }); }
  reject(id, error) { this.calls.push({ method: 'reject', id, error }); }
  async close() {}
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-gateway-extra-'));
  const state = new State(join(dir, 'state.sqlite'));
  const codex = new Codex();
  const sent = [];
  let topics = 200;
  const api = {
    async request(method, params) { sent.push({ method, params }); return method === 'createForumTopic' ? { message_thread_id: ++topics } : true; },
    async sendText(chatId, text, options) { sent.push({ method: 'sendText', text, options }); return [{ message_id: 1000 + sent.length }]; },
    async editText(chatId, messageId, text, options) { sent.push({ method: 'editText', text, options }); return true; },
    async sendPhoto(chatId, path, options) { sent.push({ method: 'sendPhoto', path, options }); return { message_id: 1000 + sent.length }; },
    async sendDocument(chatId, path, options) { sent.push({ method: 'sendDocument', path, options }); return { message_id: 1000 + sent.length }; },
    stop() {},
  };
  const gateway = new Gateway({ api, codex, state, ownerId, root: dir, dataDir: dir, projects, secrets: [secret] });
  gateway.models = [{ model: 'test-model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  gateway.log = () => {};
  t.after(async () => { await gateway.close(); state.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, state, codex, api, sent, gateway };
}

const message = (id, text, topic) => ({ update_id: id, message: { message_id: id, text, from: { id: ownerId, is_bot: false }, chat: { id: ownerId, type: 'private' }, ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } });
const watch = (f, extra = {}) => {
  f.state.saveChat({ id: 'chat', title: 'Chat', cwd: projects[0].path, watching: true, watchSince: 1, model: 'test-model', effort: 'low', status: 'active', turnId: 'desktop-turn', startedAt: Date.now(), ...extra });
  f.state.saveTopic({ id: 5, threadId: 'chat', name: 'alpha · Chat', projectKey: 'alpha', auto: true });
};
async function drained(f) {
  for (let n = 0; n < 200; n++) {
    if (!f.gateway.draining && !f.state.pending().length) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Gateway did not drain queued updates');
}

test('messages queued in a new topic create one chat in its captured project despite navigation', async t => {
  const f = await fixture(t);
  const topic = await f.gateway.newChat('alpha');
  await f.gateway.receive(message(1, 'First alpha message', topic.id));
  await f.gateway.receive(message(2, 'Second alpha message', topic.id));
  assert.deepEqual(f.state.pending().map(row => row.thread_id), [`topic:${topic.id}`, `topic:${topic.id}`]);
  f.codex.connected = true;
  await f.gateway.showProjectChats({}, 'beta');
  await f.gateway.drain();
  await drained(f);
  const starts = f.codex.calls.filter(call => call.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.cwd, projects[0].path);
  const turns = f.codex.calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  assert.equal(f.state.threadForMessage(1), f.state.threadForMessage(2));
  assert.equal(f.state.topic(topic.id).threadId, turns[0].params.threadId);
});

test('messages added during asynchronous dispatch drain without another user update', async t => {
  const f = await fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let reached;
  const firstStarted = new Promise(resolve => { reached = resolve; });
  f.codex.beforeRequest = async method => { if (method === 'turn/start') { reached(); await held; } };
  const topic = await f.gateway.newChat('alpha');
  await f.gateway.receive(message(10, 'First', topic.id));
  f.codex.connected = true;
  const running = f.gateway.drain();
  await firstStarted;
  await f.gateway.receive(message(11, 'Second while first request is pending', topic.id));
  release();
  await running;
  await drained(f);
  assert.equal(f.codex.calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method)).length, 2);
});

test('passive desktop dynamic and unsupported requests receive no automatic response', async t => {
  const f = await fixture(t);
  watch(f, { ownedTurnId: 'previous-telegram-turn' });
  for (const method of ['item/tool/call', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']) {
    await f.gateway.onRequest({ id: method, method, params: { threadId: 'chat', turnId: 'desktop-turn', tool: 'desktop_tool' } });
  }
  assert.equal(f.codex.calls.filter(call => ['respond', 'reject'].includes(call.method)).length, 0);
});

test('the card log redacts known complete secrets', async t => {
  const f = await fixture(t);
  watch(f);
  await f.gateway.onEvent('item/completed', { threadId: 'chat', turnId: 'desktop-turn', item: { type: 'agentMessage', id: 'c1', phase: 'commentary', text: `Output: ${secret}` } });
  const card = f.gateway.statusText(f.state.chat('chat'));
  assert.equal(card.includes(secret), false);
  assert.match(card, /секрет скрыт/);
});

test('completed generated image uses a photo preview once', async t => {
  const f = await fixture(t);
  watch(f);
  const imagePath = join(f.dir, 'generated.png');
  await writeFile(imagePath, 'test image bytes');
  const event = { threadId: 'chat', turnId: 'desktop-turn', item: { type: 'imageGeneration', id: 'image-1', savedPath: imagePath, status: 'completed' } };
  await f.gateway.onEvent('item/completed', event);
  await f.gateway.onEvent('item/completed', event);
  const photos = f.sent.filter(item => item.method === 'sendPhoto');
  assert.equal(photos.length, 1);
  assert.equal(photos[0].path, f.state.files('chat')[0].path);
  assert.notEqual(photos[0].path, imagePath);
  assert.equal(await readFile(photos[0].path, 'utf8'), 'test image bytes');
  assert.equal(photos[0].options.filename, 'generated.png');
  assert.equal(f.state.files('chat').length, 1);
});

test('recovery delivers an unseen generated image even when final text has no file link', async t => {
  const f = await fixture(t);
  watch(f);
  const imagePath = join(f.dir, 'recovered.png');
  await writeFile(imagePath, 'test image bytes');
  f.codex.turns.set('chat', [{ id: 'missed-turn', status: 'completed', startedAt: Date.now() / 1000, items: [
    { type: 'imageGeneration', id: 'image-missed', savedPath: imagePath, status: 'completed' },
    { type: 'agentMessage', id: 'answer-missed', phase: 'final_answer', text: 'Изображение готово.' },
  ] }]);
  await f.gateway.recoverChat('chat');
  await f.gateway.recoverChat('chat');
  const photos = f.sent.filter(item => item.method === 'sendPhoto');
  assert.equal(photos.length, 1);
  assert.equal(photos[0].path, f.state.files('chat')[0].path);
  assert.notEqual(photos[0].path, imagePath);
  assert.equal(await readFile(photos[0].path, 'utf8'), 'test image bytes');
  assert.equal(photos[0].options.filename, 'recovered.png');
});

