// Load: many chats at once with steering, queued requests, stops and slow Telegram/Codex calls.
// Invariants: every message reaches its own thread exactly once (or, sent just before /stop, is
// cancelled with a notice — the documented stop version), every answer reaches its own
// topic exactly once, no card keeps a live ■ Стоп and no queue is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../lib/gateway.mjs';
import { State } from '../lib/state.mjs';

const OWNER = 123456789;
const PROJECT = { key: 'workspace', label: 'Workspace', path: '/home/user/workspace', favorite: true };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

// Seeded, so a failure reproduces.
function random(seed) {
  let x = seed >>> 0;
  return (min, max) => { x = (x * 1664525 + 1013904223) >>> 0; return min + x % (max - min + 1); };
}

// Behaves like the daemon where it matters: one active turn per thread, steer needs that exact turn,
// the answer streams as deltas, interrupt ends the turn as interrupted.
class SimCodex extends EventEmitter {
  connected = true;
  threads = new Map();
  answers = [];
  inputs = new Map();
  constructor(rand) { super(); this.rand = rand; }
  thread(id) { if (!this.threads.has(id)) this.threads.set(id, { turns: [], active: null, n: 0 }); return this.threads.get(id); }
  notify(method, params) { this.emit('notification', method, params); }
  record(id, input) { this.inputs.set(id, [...this.inputs.get(id) ?? [], ...input.filter(i => i.type === 'text').map(i => i.text)]); }
  async request(method, params) {
    await tick(this.rand(0, 3));
    const t = params?.threadId ? this.thread(params.threadId) : null;
    switch (method) {
      case 'thread/resume': return { thread: { id: params.threadId, name: `Chat ${params.threadId}`, status: { type: t.active ? 'active' : 'idle' } }, cwd: PROJECT.path, model: 'm', reasoningEffort: 'low', instructionSources: [] };
      case 'thread/turns/list': return { data: t.turns.slice(-1).map(turn => ({ id: turn.id, status: turn.status, startedAt: turn.startedAt, items: [] })), nextCursor: null };
      case 'turn/start': {
        if (t.active) throw new Error('turn already in progress');
        this.record(params.threadId, params.input);
        return { turn: this.startTurn(params.threadId) };
      }
      case 'turn/steer':
        if (!t.active) throw new Error('no active turn to steer');
        if (t.active.id !== params.expectedTurnId) throw new Error(`expected active turn id \`${params.expectedTurnId}\` but found \`${t.active.id}\``);
        this.record(params.threadId, params.input);
        return {};
      case 'turn/interrupt':
        if (!t.active || t.active.id !== params.turnId) throw new Error('no active turn to interrupt');
        t.active.interrupted = true;
        return {};
      case 'thread/backgroundTerminals/list': return { data: [], nextCursor: null };
      case 'thread/name/set': case 'thread/unsubscribe': return {};
      default: throw new Error(`Unexpected Codex request ${method}`);
    }
  }
  startTurn(id) {
    const t = this.thread(id);
    const turn = { id: `${id}-turn-${++t.n}`, status: 'inProgress', startedAt: Date.now() / 1000 };
    t.turns.push(turn);
    t.active = turn;
    void (async () => {
      await tick(this.rand(0, 5));
      this.notify('turn/started', { threadId: id, turn: { id: turn.id, startedAt: turn.startedAt, items: [] } });
      const item = { type: 'agentMessage', id: `${turn.id}-answer` };
      await tick(this.rand(5, 40));
      this.notify('item/started', { threadId: id, turnId: turn.id, item });
      for (let i = 0; i < 4 && !turn.interrupted; i++) { this.notify('item/agentMessage/delta', { threadId: id, turnId: turn.id, itemId: item.id, delta: `часть ${i} ` }); await tick(this.rand(1, 10)); }
      await tick(this.rand(5, 40));
      t.active = null;
      turn.status = turn.interrupted ? 'interrupted' : 'completed';
      const items = [];
      if (!turn.interrupted) {
        const text = `ответ ${turn.id}`;
        this.answers.push({ threadId: id, text });
        items.push({ ...item, text });
        this.notify('item/completed', { threadId: id, turnId: turn.id, item: items[0] });
      }
      this.notify('turn/completed', { threadId: id, turn: { id: turn.id, status: turn.status, items, completedAt: Date.now() / 1000, durationMs: 10 } });
    })();
    return { id: turn.id };
  }
  respond() {} reject() {}
  async close() { this.connected = false; }
}

function slowApi(rand) {
  const calls = [];
  const cardsSent = [];
  let id = 1000;
  const slow = () => tick(rand(0, 4));
  return {
    calls, cardsSent,
    async request(method, params) { await slow(); calls.push({ method, params }); return method === 'createForumTopic' ? { message_thread_id: ++id } : true; },
    async sendText(chatId, text, options = {}) {
      await slow();
      const messageId = ++id;
      calls.push({ method: 'sendText', text, options, messageId });
      if (String(text).startsWith('<pre>') && options.reply_markup?.inline_keyboard?.length) cardsSent.push(messageId);
      return [{ message_id: messageId }];
    },
    async sendAnswer(chatId, text, options = {}) { await slow(); calls.push({ method: 'sendAnswer', text, options }); return [{ message_id: ++id }]; },
    async editText(chatId, messageId, text, options = {}) { await slow(); calls.push({ method: 'editText', messageId, text, options }); return true; },
    stop() {},
  };
}

const seeds = process.env.LOAD_SEEDS ? Array.from({ length: Number(process.env.LOAD_SEEDS) }, (_, i) => i + 100) : [1, 7, 42];
for (const seed of seeds) {
  test(`eight chats at once keep every message and answer in place (seed ${seed})`, async t => {
    const rand = random(seed);
    const dir = await mkdtemp(join(tmpdir(), 'codex-load-'));
    const state = new State(join(dir, 'state.sqlite'));
    const codex = new SimCodex(rand);
    const api = slowApi(rand);
    const gateway = new Gateway({ api, codex, state, ownerId: OWNER, root: dir, dataDir: dir, projects: [PROJECT] });
    const errors = [];
    gateway.log = (kind, error) => { if (!/draft|reaction/.test(kind)) errors.push(`${kind}: ${error?.message ?? error}`); };
    t.after(async () => { await gateway.close(); state.close(); await rm(dir, { recursive: true, force: true }); });

    const chats = Array.from({ length: 8 }, (_, i) => ({ id: `C${i}`, topic: 21 + i }));
    for (const chat of chats) {
      state.saveTopic({ id: chat.topic, threadId: chat.id, name: `Workspace · ${chat.id}`, projectKey: PROJECT.key, auto: true });
      state.saveChat({ id: chat.id, title: chat.id, cwd: PROJECT.path, watching: true, watchSince: 1, model: 'm', effort: 'low', status: 'idle' });
    }
    const sent = new Map(chats.map(c => [c.id, []]));
    const stops = new Map(chats.map(c => [c.id, []]));
    let update = 1;
    const say = (chat, text) => gateway.receive({ update_id: update, message: { message_id: update++, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, message_thread_id: chat.topic, is_topic_message: true } });
    const work = [];
    for (let step = 0; step < 160; step++) {
      const chat = chats[rand(0, chats.length - 1)];
      const kind = rand(0, 99);
      const text = `m-${step}`;
      if (kind < 62) { sent.get(chat.id).push(text); work.push(say(chat, text)); }
      else if (kind < 82) { sent.get(chat.id).push(text); work.push(say(chat, `/queue ${text}`)); }
      else if (kind < 88) { stops.get(chat.id).push(step); work.push(say(chat, '/stop')); }
      else work.push(say(chat, '/context'));
      if (rand(0, 3) === 0) await tick(rand(1, 30));
    }
    await Promise.all(work);

    // Let everything finish; stopped chats keep their queue paused until resumed.
    for (let round = 0; round < 400; round++) {
      await tick(20);
      await gateway.eventChain;
      const open = state.chats().filter(c => c.status === 'active' || state.queuedTurns(c.id).some(i => i.status === 'waiting'));
      const busy = gateway.chains.size || gateway.tasks.size || gateway.workers.size || gateway.turnLocks.size || gateway.cardLocks.size || gateway.queueRunners.size
        || [...codex.threads.values()].some(th => th.active);
      if (!open.length && !state.pending().length && !busy) break;
      for (const c of open) if (c.queuePaused && c.status !== 'active' && !gateway.queueRunners.has(c.id)) { state.saveChat({ id: c.id, queuePaused: false }); void gateway.runQueued(c.id); }
    }

    for (const chat of chats) {
      const got = codex.inputs.get(chat.id) ?? [];
      assert.equal(new Set(got).size, got.length, `${chat.id}: a message reached Codex twice`);
      assert.deepEqual(got.filter(m => !sent.get(chat.id).includes(m)), [], `${chat.id}: a message reached another chat`);
      const cancelled = sent.get(chat.id).filter(m => !got.includes(m));
      const notices = api.calls.filter(c => c.method === 'sendText' && c.options.message_thread_id === chat.topic && /Отменено командой/.test(c.text)).length;
      assert.equal(cancelled.length, notices, `${chat.id}: lost without a notice: ${cancelled.join(', ')}`);
      for (const m of cancelled) assert.ok(stops.get(chat.id).some(step => step > Number(m.slice(2))), `${chat.id}: ${m} cancelled with no /stop after it`);
      const now = state.chat(chat.id);
      assert.notEqual(now.status, 'active', `${chat.id} left active`);
      assert.deepEqual(state.queuedTurns(chat.id), [], `${chat.id} left its queue`);
    }
    const delivered = api.calls.filter(c => c.method === 'sendAnswer');
    for (const answer of codex.answers) {
      const copies = delivered.filter(d => d.text === answer.text);
      assert.equal(copies.length, 1, `${answer.text} delivered ${copies.length}×`);
      assert.equal(copies[0].options.message_thread_id, chats.find(c => c.id === answer.threadId).topic, `${answer.text} went to another topic`);
    }
    assert.equal(delivered.length, codex.answers.length);
    // Every card that ever had ■ Стоп ends without buttons (a second card for one turn would stay live).
    const cards = new Map(api.cardsSent.map(id => [id, 1]));
    for (const call of api.calls) if (call.method === 'editText' && cards.has(call.messageId)) cards.set(call.messageId, call.options.reply_markup?.inline_keyboard?.length ?? 0);
    assert.deepEqual([...cards.entries()].filter(([, buttons]) => buttons > 0), [], 'a card still shows ■ Стоп');
    assert.deepEqual(errors, []);
  });
}
