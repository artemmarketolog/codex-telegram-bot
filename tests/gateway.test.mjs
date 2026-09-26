import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway, IDLE_UNSUBSCRIBE_MS } from '../lib/gateway.mjs';
import { State } from '../lib/state.mjs';
import { TelegramApiError } from '../lib/telegram.mjs';

const OWNER = 123456789;
const PROJECT = { key: 'workspace', label: 'Workspace', path: '/home/user/workspace', favorite: true };

class FakeCodex extends EventEmitter {
  connected = false;
  started = 0;
  calls = [];
  turns = new Map();
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/resume') return {
      thread: { id: params.threadId, name: `Chat ${params.threadId}`, status: { type: 'idle' } },
      cwd: PROJECT.path, model: 'model-old', reasoningEffort: 'high', instructionSources: [],
    };
    if (method === 'thread/turns/list') return { data: this.turns.get(params.threadId) ?? [] };
    if (method === 'thread/list') return { data: this.listed ?? [], nextCursor: null };
    if (method === 'thread/start') { const id = this.started++ ? `NEW-${this.started}` : 'NEW'; return { thread: { id, name: null, status: { type: 'idle' } }, cwd: params.cwd, model: params.model, reasoningEffort: params.config.model_reasoning_effort, instructionSources: [] }; }
    if (method === 'turn/interrupt') { for (const turn of this.turns.get(params.threadId) ?? []) if (turn.id === params.turnId) turn.status = 'interrupted'; return {}; }
    if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}` } };
    if (['turn/steer', 'thread/name/set', 'thread/unsubscribe', 'thread/unarchive', 'thread/archive'].includes(method)) return {};
    if (method === 'thread/backgroundTerminals/list') return { data: this.terminals ?? [], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: this.childStatus?.[params.threadId] ?? 'idle' } } };
    throw new Error(`Unexpected fake Codex method: ${method}`);
  }
  respond(id, result) { this.calls.push({ method: 'respond', id, result }); }
  reject(id, error) { this.calls.push({ method: 'reject', id, error }); }
  async close() {}
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-gateway-test-'));
  const state = new State(join(dir, 'state.sqlite'));
  const codex = new FakeCodex();
  const sent = [];
  let topics = 100;
  const api = {
    async request(method, params) { sent.push({ method, params }); return method === 'createForumTopic' ? { message_thread_id: ++topics, name: params.name } : true; },
    async sendText(chatId, text, options) { sent.push({ method: 'sendText', chatId, text, options }); return [{ message_id: 1000 + sent.length }]; },
    async editText(chatId, messageId, text, options) { sent.push({ method: 'editText', chatId, messageId, text, options }); return true; },
    async sendDocument(chatId, path, options) { sent.push({ method: 'sendDocument', chatId, path, options }); return { message_id: 1000 + sent.length }; },
    stop() {},
  };
  const gateway = new Gateway({ api, codex, state, ownerId: OWNER, root: dir, dataDir: dir, projects: [PROJECT], secrets: ['unit-test-secret-value'] });
  // Buttons and commands run beside the poller; the tests check their effect once they finish.
  const receive = gateway.receive.bind(gateway);
  gateway.receive = async update => { await receive(update); await Promise.allSettled([...gateway.tasks]); };
  gateway.log = () => {};
  for (const [index, id] of ['A', 'B'].entries()) {
    state.saveChat({ id, title: `Chat ${id}`, cwd: PROJECT.path, model: 'model-old', effort: 'high', watching: true, status: 'idle' });
    state.saveTopic({ id: 10 + index, threadId: id, name: `Workspace · Chat ${id}`, projectKey: PROJECT.key, auto: true });
  }
  gateway.models = [{ model: 'model-new', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] }];
  t.after(async () => { await gateway.close(); state.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, state, codex, sent, gateway };
}

function message(updateId, text, extra = {}) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, text, ...extra } };
}

const topicMessage = (updateId, topic, text, extra = {}) => message(updateId, text, { message_thread_id: topic, is_topic_message: true, ...extra });
const methods = (f, name) => f.sent.filter(item => item.method === name);

function callback(updateId, data, extra = {}) {
  return { update_id: updateId, callback_query: { id: `query-${updateId}`, from: { id: OWNER, is_bot: false }, message: { message_id: 55, chat: { id: OWNER, type: 'private' } }, data, ...extra } };
}

async function dispatchPending({ gateway, codex }) {
  codex.connected = true;
  await gateway.drain();
  codex.connected = false;
}

test('unauthorized senders and non-private owner updates cannot enqueue work or activate callbacks', async t => {
  const f = await fixture(t);
  const action = f.gateway.button('Stop', 'stop', { id: 'A' }).callback_data;
  const updates = [
    message(1, '/new', { from: { id: 123, is_bot: false } }),
    message(2, '/new', { from: { id: OWNER, is_bot: true } }),
    message(3, '/new', { chat: { id: -1001, type: 'supergroup' } }),
    message(4, '/new', { chat: { id: 123, type: 'private' } }),
    callback(5, action, { from: { id: 123, is_bot: false } }),
    callback(6, action, { message: { message_id: 1, chat: { id: 123, type: 'private' } } }),
    callback(7, action, { message: { message_id: 1, chat: { id: OWNER, type: 'group' } } }),
    callback(8, action, { message: undefined, inline_message_id: 'inline' }),
  ];
  for (const update of updates) await f.gateway.receive(update);
  assert.deepEqual(f.state.pending(), []);
  assert.deepEqual(f.codex.calls, []);
  assert.deepEqual(f.sent, []);
});

test('duplicate update IDs dispatch a user message to Codex exactly once', async t => {
  const f = await fixture(t);
  const update = topicMessage(20, 11, 'Проверь проект');
  await f.gateway.receive(update);
  await f.gateway.receive(update);
  assert.equal(f.state.pending().length, 1);
  await dispatchPending(f);
  await f.gateway.receive(update);
  await dispatchPending(f);
  assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.deepEqual(f.state.pending(), []);
});

test('menu navigation never changes where a topic message goes', async t => {
  const f = await fixture(t);
  f.gateway.projects.push({ key: 'second', label: 'Second', path: '/tmp/second', favorite: true });
  f.codex.connected = true;
  await f.gateway.receive(callback(24, f.gateway.button('Second', 'project', { key: 'second' }).callback_data));
  f.codex.connected = false;
  await f.gateway.receive(topicMessage(25, 10, 'Работай в чате этой темы'));
  assert.equal(f.state.pending()[0].thread_id, 'A');
  await dispatchPending(f);
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'turn/start').map(call => call.params.threadId), ['A']);
});

test('replying to an earlier bot answer targets its original chat without changing the active chat', async t => {
  const f = await fixture(t);
  f.state.bind(77, 'A');
  await f.gateway.receive(message(30, 'Продолжи этот ответ', { reply_to_message: { message_id: 77 } }));
  await dispatchPending(f);
  const call = f.codex.calls.find(item => item.method === 'turn/start');
  assert.equal(call.params.threadId, 'A');
  assert.equal(call.params.input[0].text, 'Продолжи этот ответ');
});

test('a model callback changes the selected chat encoded in the button, not the current chat', async t => {
  const f = await fixture(t);
  f.gateway.models = [{ model: 'model-new', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
  const action = f.gateway.button('Choose model', 'effort', { id: 'A', model: 'model-new', effort: 'high' }).callback_data;
  await f.gateway.receive(callback(40, action));
  assert.equal(f.state.chat('A').model, 'model-new');
  assert.equal(f.state.chat('A').modelOverride, true);
  assert.equal(f.state.chat('B').model, 'model-old');
  assert.equal(f.state.get('defaultModel'), null);
  assert.equal(f.state.get('defaultEffort'), null);
  assert.equal(f.sent.filter(item => item.method === 'answerCallbackQuery').length, 1);
});

test('a stop button interrupts the precise chat and currently running turn encoded in its action', async t => {
  const f = await fixture(t);
  f.codex.turns.set('A', [{ id: 'running-A', status: 'inProgress' }]);
  f.codex.turns.set('B', [{ id: 'running-B', status: 'inProgress' }]);
  const action = f.gateway.button('Stop A', 'stop', { id: 'A' }).callback_data;
  await f.gateway.receive(callback(50, action));
  const interrupts = f.codex.calls.filter(item => item.method === 'turn/interrupt');
  assert.deepEqual(interrupts.map(item => item.params), [{ threadId: 'A', turnId: 'running-A' }]);
});

test('replying /stop to an answer interrupts that answer’s chat rather than the active chat', async t => {
  const f = await fixture(t);
  f.state.bind(88, 'A');
  f.codex.turns.set('A', [{ id: 'running-A', status: 'inProgress' }]);
  f.codex.turns.set('B', [{ id: 'running-B', status: 'inProgress' }]);
  await f.gateway.receive(message(60, '/stop', { reply_to_message: { message_id: 88 } }));
  assert.deepEqual(f.codex.calls.filter(item => item.method === 'turn/interrupt').map(item => item.params), [{ threadId: 'A', turnId: 'running-A' }]);
});

test('artifact delivery rejects credentials, symlinks to credentials and known secret contents', async t => {
  const f = await fixture(t);
  const credentials = join(f.dir, 'project', '.env');
  await mkdir(join(f.dir, 'project'), { recursive: true });
  await writeFile(credentials, 'not-for-delivery');
  const symlinkPath = join(f.dir, 'innocent.txt');
  await symlink(credentials, symlinkPath);
  const secretCopy = join(f.dir, 'copied-log.txt');
  await writeFile(secretCopy, 'a log containing unit-test-secret-value');
  const normal = join(f.dir, 'result.txt');
  await writeFile(normal, 'useful result');
  const text = [credentials, symlinkPath, secretCopy, normal].map(path => `[file](${path})`).join('\n');
  await f.gateway.sendArtifacts('A', text, 'result-1');
  await f.gateway.sendArtifacts('A', text, 'result-1');
  const sent = f.sent.filter(item => item.method === 'sendDocument');
  assert.equal(sent.length, 1);
  const [file] = f.state.files('A');
  assert.equal(f.state.files('A').length, 1);
  assert.equal(sent[0].path, file.path);
  assert.equal(file.path.startsWith(join(f.dir, 'files', 'A', 'outputs') + '/'), true);
  assert.equal(file.originalPath, normal);
  assert.equal(file.name, 'result.txt');
  assert.deepEqual(sent[0].options, { caption: 'result.txt', filename: 'result.txt', message_thread_id: 10 });
  assert.equal(await readFile(file.path, 'utf8'), 'useful result');
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.dir, 'files', 'A', 'outputs'))).mode & 0o777, 0o700);
});

test('failed artifact delivery keeps a private snapshot and retries it after a restart without the temporary source', async t => {
  const f = await fixture(t);
  const source = join(f.dir, 'temporary-output.txt');
  await writeFile(source, 'result survives losing the temporary source');
  const sendDocument = f.gateway.api.sendDocument;
  f.gateway.api.sendDocument = async () => { throw new Error('Simulated rejected upload'); };
  const text = `[result](${source})`;
  await f.gateway.sendArtifacts('A', text, 'retry-result');
  const [saved] = f.state.files('A');
  assert.ok(saved?.path);
  assert.equal(f.state.wasDelivered(saved.deliveryKey), false);
  assert.equal(await readFile(saved.path, 'utf8'), 'result survives losing the temporary source');
  await unlink(source);
  f.gateway.api.sendDocument = sendDocument;
  const reopened = new State(join(f.dir, 'state.sqlite'));
  const restarted = new Gateway({ api: f.gateway.api, codex: new FakeCodex(), state: reopened, ownerId: OWNER, root: f.dir, dataDir: f.dir, projects: [PROJECT] });
  try {
    await restarted.sendArtifacts('A', text, 'retry-result');
    await restarted.sendArtifacts('A', text, 'retry-result');
    const documents = f.sent.filter(item => item.method === 'sendDocument');
    assert.deepEqual(documents.map(item => item.path), [saved.path]);
    assert.equal(documents[0].options.filename, 'temporary-output.txt');
    assert.equal(reopened.files('A').length, 1);
    assert.equal(reopened.wasDelivered(saved.deliveryKey), true);
  } finally { await restarted.close(); reopened.close(); }
});

test('a saved file button revalidates its path after a file has been replaced by a credential symlink', async t => {
  const f = await fixture(t);
  const credentials = join(f.dir, '.ssh', 'config');
  await mkdir(join(f.dir, '.ssh'), { recursive: true });
  await writeFile(credentials, 'private-credential-data');
  const artifact = join(f.dir, 'old-result.txt');
  await writeFile(artifact, 'original safe result');
  const file = f.state.addFile('A', { path: artifact, name: 'old-result.txt', direction: 'out' });
  const action = f.gateway.button('Download previous file', 'file', { id: file.id }).callback_data;
  await unlink(artifact);
  await symlink(credentials, artifact);
  await f.gateway.receive(callback(70, action));
  assert.equal(f.sent.filter(item => item.method === 'sendDocument').length, 0);
});

test('/new opens a project topic; the first message creates the chat there and renames the topic', async t => {
  const f = await fixture(t);
  await f.gateway.receive(message(80, '/new'));
  const picker = methods(f, 'sendText').at(-1);
  const pick = picker.options.reply_markup.inline_keyboard[0][0];
  assert.equal(pick.text, 'Workspace');
  await f.gateway.receive(callback(81, pick.callback_data));
  const created = methods(f, 'createForumTopic');
  assert.deepEqual(created.map(item => item.params.name), ['Новый чат · Workspace']);
  const topic = f.state.topic(101);
  assert.equal(topic.projectKey, PROJECT.key);
  assert.equal(topic.threadId, null);
  assert.equal(methods(f, 'editText').at(-1).messageId, 55);
  assert.match(methods(f, 'editText').at(-1).text, /→ «Новый чат · Workspace»/);
  assert.equal(methods(f, 'sendText').at(-1).options.message_thread_id, 101);
  await f.gateway.receive(topicMessage(82, 101, 'Собери отчёт по продажам'));
  await dispatchPending(f);
  const start = f.codex.calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.cwd, PROJECT.path);
  assert.equal(start.params.config.model_reasoning_effort, 'medium', 'effort defaults to the model default, not ultra');
  assert.equal(f.state.topic(101).threadId, 'NEW');
  assert.equal(f.codex.calls.find(call => call.method === 'turn/start').params.threadId, 'NEW');
  assert.deepEqual(methods(f, 'editForumTopic').map(item => [item.params.message_thread_id, item.params.name]), [[101, 'Собери отчёт по продажам · Workspace']]);
  assert.deepEqual(methods(f, 'setMessageReaction').map(item => [item.params.message_id, item.params.reaction[0].emoji]), [[82, '👀']]);
});

const created = (id, topic, implicit) => ({ update_id: id, message: { message_id: id, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, message_thread_id: topic, forum_topic_created: { name: 'ОК', icon_color: 1, ...(implicit ? { is_name_implicit: true } : {}) } } });
const lineOf = (f, topic) => { const line = methods(f, 'sendText').find(item => item.text === '📁 Workspace' && item.options.message_thread_id === topic); return line && { ...line, id: f.sent.indexOf(line) + 1001 }; };
const press = (f, id, button, topic, messageId) => callback(id, button.callback_data, { message: { message_id: messageId, message_thread_id: topic, chat: { id: OWNER, type: 'private' } } });

test('a lobby message starts a workspace chat at once in a new topic with a project line', async t => {
  const f = await fixture(t);
  await f.gateway.receive(message(90, 'Проверь сертификаты'));
  await f.gateway.receive(message(91, 'И домен тоже'));
  assert.deepEqual(methods(f, 'createForumTopic').map(item => [item.params.name, item.params.icon_custom_emoji_id]), [['Новый чат · Workspace', '5348227245599105972']]);
  assert.deepEqual(f.state.held('lobby'), []);
  assert.deepEqual(f.state.pending().map(row => row.thread_id), ['topic:101', 'topic:101'], 'messages sent together share one topic');
  assert.equal(methods(f, 'sendText').some(item => /Новый чат в:/.test(item.text)), false, 'no project question');
  await dispatchPending(f);
  assert.equal(f.codex.calls.find(call => call.method === 'thread/start').params.cwd, PROJECT.path);
  assert.equal(f.state.topic(101).threadId, 'NEW');
  assert.deepEqual(f.codex.calls.find(call => call.method === 'turn/start').params.input, [{ type: 'text', text: 'Проверь сертификаты' }]);
  const line = lineOf(f, 101);
  assert.deepEqual(line.options.reply_markup.inline_keyboard.flat().map(button => button.text), ['сменить проект']);
  assert.deepEqual(f.state.topic(101).firstMessages.map(m => m.message_id), [90, 91]);
});

test('a topic created by the user starts in workspace at once; only an implicit name is renamed', async t => {
  const f = await fixture(t);
  await f.gateway.receive(created(100, 300, true));
  assert.equal(methods(f, 'sendText').length, 0, 'no project question');
  await f.gateway.receive(topicMessage(101, 300, 'ОК'));
  await dispatchPending(f);
  assert.equal(f.codex.calls.find(call => call.method === 'thread/start').params.cwd, PROJECT.path);
  assert.equal(f.state.topic(300).threadId, 'NEW');
  assert.ok(lineOf(f, 300));
  assert.deepEqual(methods(f, 'editForumTopic').map(item => item.params.name ?? `icon ${item.params.icon_custom_emoji_id}`), ['icon 5348227245599105972', 'ОК · Workspace']);

  const g = await fixture(t);
  await g.gateway.receive(created(110, 310, false));
  await g.gateway.receive(topicMessage(112, 310, 'Задача в теме с явным именем'));
  await g.gateway.receive(topicMessage(113, 320, 'Тема без служебного сообщения'));
  await dispatchPending(g);
  assert.equal(g.state.topic(310).threadId, 'NEW');
  assert.equal(g.state.topic(320).projectKey, PROJECT.key);
  assert.equal(methods(g, 'editForumTopic').some(item => item.params.name), false);
});

test('switching the project before the first turn only changes the project of the topic', async t => {
  const f = await fixture(t);
  f.gateway.projects.push({ key: 'second', label: 'Second', path: '/tmp/second', favorite: true });
  f.state.saveTopic({ id: 300, projectKey: PROJECT.key, autoProject: true, userCreated: true, implicit: true });
  await f.gateway.showProjectLine(300);
  const line = lineOf(f, 300);
  await f.gateway.receive(press(f, 130, line.options.reply_markup.inline_keyboard[0][0], 300, line.id));
  const list = methods(f, 'editText').at(-1);
  assert.equal(list.messageId, line.id);
  const second = list.options.reply_markup.inline_keyboard.flat().find(button => button.text === 'Second');
  await f.gateway.receive(press(f, 131, second, 300, line.id));
  assert.equal(f.state.topic(300).projectKey, 'second');
  const edited = methods(f, 'editText').at(-1);
  assert.equal(edited.text, '📁 Second');
  assert.deepEqual(edited.options.reply_markup.inline_keyboard.flat().map(button => button.text), ['сменить проект']);
  assert.equal(f.codex.calls.some(call => ['thread/archive', 'turn/interrupt'].includes(call.method)), false);
  await f.gateway.receive(topicMessage(132, 300, 'Задача'));
  await dispatchPending(f);
  assert.equal(f.codex.calls.find(call => call.method === 'thread/start').params.cwd, '/tmp/second');
});

test('switching during a turn stops it, archives the old chat and resends the first request to a new chat in the same topic', async t => {
  const f = await fixture(t);
  f.gateway.projects.push({ key: 'second', label: 'Second', path: '/tmp/second', favorite: true });
  await f.gateway.receive(created(140, 300, true));
  await f.gateway.receive(topicMessage(141, 300, 'Первая задача'));
  await dispatchPending(f);
  f.codex.turns.set('NEW', [{ id: 'turn-NEW', status: 'inProgress', startedAt: Date.now() / 1000, items: [] }]);
  const line = lineOf(f, 300);
  const button = line.options.reply_markup.inline_keyboard[0][0];
  await f.gateway.receive(press(f, 142, button, 300, line.id));
  const second = methods(f, 'editText').at(-1).options.reply_markup.inline_keyboard.flat().find(b => b.text === 'Second');
  await f.gateway.receive(press(f, 143, second, 300, line.id));
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'turn/interrupt').map(call => call.params), [{ threadId: 'NEW', turnId: 'turn-NEW' }]);
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'thread/archive').map(call => call.params.threadId), ['NEW']);
  assert.equal(methods(f, 'editText').find(item => item.messageId === line.id && item.text === '📁 Second').options.reply_markup, undefined);
  await dispatchPending(f);
  const starts = f.codex.calls.filter(call => call.method === 'thread/start');
  assert.deepEqual(starts.map(call => call.params.cwd), [PROJECT.path, '/tmp/second']);
  assert.equal(f.state.topic(300).threadId, 'NEW-2');
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'turn/start').map(call => [call.params.threadId, call.params.input[0].text]), [['NEW', 'Первая задача'], ['NEW-2', 'Первая задача']]);
  assert.equal(methods(f, 'editForumTopic').at(-1).params.name, 'Первая задача · Second');
  assert.ok(methods(f, 'editForumTopic').some(item => item.params.icon_custom_emoji_id && item.params.icon_custom_emoji_id !== '5348227245599105972'));
  assert.deepEqual(liveStops(f).length, 1, 'only the new chat keeps a live Stop');
  assert.equal(f.state.threadForMessage(141), 'NEW-2');

  await f.gateway.receive(press(f, 144, button, 300, line.id));
  await f.gateway.receive(press(f, 145, second, 300, line.id));
  assert.deepEqual(methods(f, 'answerCallbackQuery').slice(-2).map(item => item.params.text), ['Кнопка устарела', 'Кнопка устарела']);
  assert.equal(f.codex.calls.filter(call => call.method === 'thread/archive').length, 1);
  assert.equal(f.codex.calls.filter(call => call.method === 'thread/start').length, 2);
});

test('after the first answer, the next request settles the project and removes the switch button', async t => {
  const f = await fixture(t);
  await f.gateway.receive(created(150, 300, true));
  await f.gateway.receive(topicMessage(151, 300, 'Первая'));
  await dispatchPending(f);
  await f.gateway.finish('NEW', { id: 'turn-NEW', status: 'completed', durationMs: 1000, items: [] });
  assert.equal(f.state.topic(300).firstDone, true);
  const line = lineOf(f, 300);
  await f.gateway.receive(topicMessage(152, 300, 'Вторая'));
  await dispatchPending(f);
  const settled = methods(f, 'editText').find(item => item.messageId === line.id);
  assert.equal(settled.text, '📁 Workspace');
  assert.equal(settled.options?.reply_markup, undefined);
  assert.deepEqual(f.state.topic(300).firstMessages.map(m => m.message_id), [151]);
});

test('a topic deleted by the user is unbound and recreated for the next message of its chat', async t => {
  const f = await fixture(t);
  const sendText = f.gateway.api.sendText;
  f.gateway.api.sendText = async (chatId, text, options) => {
    if (options?.message_thread_id === 10) throw new TelegramApiError('sendMessage', 400, 'Bad Request: message thread not found');
    return sendText(chatId, text, options);
  };
  await f.gateway.say('Ответ для A', {}, 'A');
  assert.equal(f.state.topic(10), null);
  assert.equal(f.state.topicForThread('A').id, 101);
  assert.deepEqual(methods(f, 'createForumTopic').map(item => item.params.name), ['Chat A · Workspace']);
  assert.equal(methods(f, 'sendText').at(-1).options.message_thread_id, 101);
  assert.equal(f.state.threadForMessage(methods(f, 'sendText').length + 1000), undefined);
});

test('menu buttons edit their own message and a stale button only answers the callback', async t => {
  const f = await fixture(t);
  f.codex.connected = true;
  f.codex.listed = [{ id: 'A', name: 'Chat A', cwd: PROJECT.path, updatedAt: Date.now() / 1000 - 120, status: { type: 'idle' } }];
  await f.gateway.receive(callback(120, f.gateway.button('Чаты', 'chats', {}).callback_data));
  await f.gateway.receive(callback(121, f.gateway.button('Проекты', 'projects', {}).callback_data));
  assert.equal(methods(f, 'sendText').length, 0);
  assert.deepEqual(methods(f, 'editText').map(item => item.messageId), [55, 55]);
  assert.match(methods(f, 'editText')[0].options.reply_markup.inline_keyboard[0][0].text, /Workspace · Chat A · 2м/);
  await f.gateway.receive(callback(122, 'a:unknown-action'));
  assert.deepEqual(methods(f, 'answerCallbackQuery').at(-1).params, { callback_query_id: 'query-122', text: 'Кнопка устарела' });
  assert.equal(methods(f, 'sendText').length, 0);
});

test('idle subscriptions are released after 30 minutes and renewed lazily by the next message', async t => {
  const f = await fixture(t);
  f.codex.connected = true;
  await f.gateway.subscribe('A');
  await f.gateway.subscribe('B');
  const old = Date.now() - IDLE_UNSUBSCRIBE_MS - 1000;
  f.state.saveChat({ id: 'A', lastActivity: old });
  f.state.saveChat({ id: 'B', lastActivity: old });
  f.state.queueTurn('B', { messageId: 1, input: [{ type: 'text', text: 'later' }], preview: 'later' });
  await f.gateway.unsubscribeIdle();
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['A']);
  assert.equal(f.gateway.subscribed.has('A'), false);
  assert.equal(f.gateway.subscribed.has('B'), true);
  assert.equal(f.state.chat('A').watching, false);
  f.codex.calls.length = 0;
  f.codex.connected = false;
  await f.gateway.receive(topicMessage(140, 10, 'Продолжим'));
  await dispatchPending(f);
  assert.deepEqual(f.codex.calls.map(call => call.method).slice(0, 2), ['thread/resume', 'thread/turns/list']);
  assert.equal(f.state.chat('A').watching, true);
});

test('startup resubscribes only chats with unfinished work', async t => {
  const f = await fixture(t);
  f.codex.connect = async () => { f.codex.connected = true; };
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'model/list' ? { data: f.gateway.models } : request(method, params);
  f.gateway.api.request = async (method, params) => { f.sent.push({ method, params }); return method === 'getMe' ? { id: 987654321, has_topics_enabled: true } : true; };
  f.state.saveChat({ id: 'B', status: 'active', turnId: 'running-B', startedAt: Date.now() });
  f.codex.turns.set('B', [{ id: 'running-B', status: 'inProgress', startedAt: Date.now() / 1000 }]);
  await f.gateway.start();
  assert.deepEqual(f.codex.calls.filter(call => call.method === 'thread/resume').map(call => call.params.threadId), ['B']);
  assert.equal(f.state.chat('A').watching, false);
  assert.equal(methods(f, 'sendText').filter(item => /Codex на связи/.test(item.text)).length, 1);
  await f.gateway.close();
});

test('startup without Threaded Mode explains how to switch it on in the BotFather mini app', async t => {
  const f = await fixture(t);
  f.codex.connect = async () => { f.codex.connected = true; };
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'model/list' ? { data: f.gateway.models } : request(method, params);
  f.gateway.api.request = async (method, params) => { f.sent.push({ method, params }); return method === 'getMe' ? { id: 987654321, has_topics_enabled: false } : true; };
  await f.gateway.start();
  const help = methods(f, 'sendText').find(item => /Threaded Mode/.test(item.text));
  assert.match(help.text, /Open.*My bots.*Bot Settings.*Threads Settings/);
  assert.equal(methods(f, 'sendText').some(item => /Codex на связи/.test(item.text)), false);
  await f.gateway.close();
});

test('another bot token is refused at startup', async t => {
  const f = await fixture(t);
  f.gateway.botId = 555;
  f.codex.connect = async () => { f.codex.connected = true; };
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'model/list' ? { data: f.gateway.models } : request(method, params);
  f.gateway.api.request = async (method, params) => method === 'getMe' ? { id: 987654321, has_topics_enabled: true } : true;
  await assert.rejects(f.gateway.start(), /another bot/);
});

test('an archived chat is unarchived when its topic is used again', async t => {
  const f = await fixture(t);
  const request = f.codex.request.bind(f.codex);
  let archived = true;
  f.codex.request = async (method, params) => {
    if (method === 'thread/resume' && archived) { f.codex.calls.push({ method, params }); throw new Error(`session ${params.threadId} is archived. Run codex unarchive first.`); }
    if (method === 'thread/unarchive') archived = false;
    return request(method, params);
  };
  f.codex.connected = true;
  await f.gateway.subscribe('A');
  assert.deepEqual(f.codex.calls.map(call => call.method), ['thread/resume', 'thread/unarchive', 'thread/resume']);
  assert.equal(f.gateway.subscribed.has('A'), true);
});

test('lobby /model sets defaults while topic /model changes only its chat', async t => {
  const f = await fixture(t);
  f.codex.connected = true;
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'model/list' ? { data: f.gateway.models } : request(method, params);
  await f.gateway.receive(topicMessage(150, 10, '/model'));
  assert.match(methods(f, 'sendText').at(-1).text, /Модель чата: model-old · high/);
  await f.gateway.receive(callback(151, f.gateway.button('high', 'effort', { id: 'A', model: 'model-new', effort: 'high' }).callback_data));
  assert.equal(f.state.get('defaultModel'), null);
  await f.gateway.receive(message(152, '/model'));
  assert.match(methods(f, 'sendText').at(-1).text, /По умолчанию для новых чатов: model-new · medium/);
  await f.gateway.receive(callback(153, f.gateway.button('ultra', 'effort', { model: 'model-new', effort: 'ultra' }).callback_data));
  assert.equal(f.state.get('defaultEffort'), 'ultra');
  assert.equal(f.state.chat('B').model, 'model-old');
});

test('the status card is compact, has one danger stop button and collapses to one line', async t => {
  const f = await fixture(t);
  f.gateway.rateLimits = { primary: { usedPercent: 34, windowDurationMins: 300 }, secondary: { usedPercent: 20, windowDurationMins: 10080 } };
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'turn-A', ownedTurnId: 'turn-A', startedAt: Date.now() - 222000, model: 'gpt-6-astra', effort: 'xhigh', usage: { last: { inputTokens: 380000 }, modelContextWindow: 1000000, total: { totalTokens: 9000000 } } });
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'turn-A', item: { type: 'commandExecution', id: 'c1', command: "/bin/bash -lc 'npm test'", commandActions: [{ type: 'unknown', command: 'npm test' }] } });
  await f.gateway.refreshStatus('A');
  const card = methods(f, 'sendText').at(-1);
  assert.equal(card.options.message_thread_id, 10);
  assert.match(card.text, /^<pre>▶ 3:4\d · gpt-6-astra · xhigh\nконтекст 38% · 380k\/1M\nBash: npm test · 0:0\d\nлимит 5ч 34% · 7д 20%<\/pre>$/);
  assert.deepEqual(card.options.reply_markup.inline_keyboard.map(row => row.map(button => [button.text, button.style])), [[['■ Стоп', 'danger']]]);
  await f.gateway.onEvent('turn/completed', { threadId: 'A', turn: { id: 'turn-A', status: 'completed', durationMs: 408000, items: [] } });
  const collapsed = methods(f, 'editText').at(-1);
  assert.equal(collapsed.text, '<code>✓ 6:48 · gpt-6-astra · xhigh · ctx 38% · 5ч 34% · 7д 20%</code>');
  assert.equal(collapsed.options.reply_markup, undefined);
});

test('a voice progress message becomes a collapsed, escaped transcript quote', async t => {
  const f = await fixture(t);
  await f.gateway.settleProgress({ message_id: 77 }, { transcript: 'Проверь <script> и unit-test-secret-value', warnings: [] });
  const [edit] = methods(f, 'editText');
  assert.equal(edit.messageId, 77);
  assert.equal(edit.options.html, true);
  assert.equal(edit.text, '🎙 <blockquote expandable>Проверь &lt;script&gt; и [секрет скрыт]</blockquote>');
  await f.gateway.settleProgress({ message_id: 78 }, { warnings: [] });
  assert.deepEqual(methods(f, 'deleteMessage').map(item => item.params.message_id), [78]);
});

test('opening a chat from the list creates its topic once, points the lobby menu there and posts the last answer', async t => {
  const f = await fixture(t);
  f.codex.connected = true;
  f.codex.listed = [{ id: 'C', name: 'Отчёт', cwd: PROJECT.path, updatedAt: Date.now() / 1000, status: { type: 'notLoaded' }, model: 'model-old', reasoningEffort: 'high' }];
  f.codex.turns.set('C', [{ id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'a1', phase: 'final_answer', text: 'Итог:\n- пункт' }] }]);
  await f.gateway.receive(message(160, '/chats'));
  const menu = methods(f, 'sendText').at(-1);
  const open = menu.options.reply_markup.inline_keyboard[0][0].callback_data;
  await f.gateway.receive(callback(161, open, { message: { message_id: 999, chat: { id: OWNER, type: 'private' } } }));
  await f.gateway.receive(callback(162, open, { message: { message_id: 999, chat: { id: OWNER, type: 'private' } } }));
  assert.deepEqual(methods(f, 'createForumTopic').map(item => item.params.name), ['Отчёт · Workspace']);
  assert.equal(methods(f, 'editText').at(-1).messageId, 999);
  assert.equal(methods(f, 'editText').at(-1).text, '→ «Отчёт · Workspace»');
  const cards = methods(f, 'sendText').filter(item => item.options?.message_thread_id === 101);
  assert.equal(cards.length, 2);
  assert.match(cards[0].text, /^\*\*Отчёт\*\*\n`Workspace · model-old · high`\n\nИтог:\n- пункт$/);
  assert.equal(f.codex.calls.some(call => call.method === 'thread/resume'), false, 'an idle chat is not loaded just to be viewed');
});

// Message IDs whose card still shows a live Stop button, replayed from the fake Telegram log.
function liveStops(f) {
  const live = new Set();
  f.sent.forEach((item, index) => {
    const stop = item.options?.reply_markup?.inline_keyboard?.flat().some(button => button.text === '■ Стоп');
    if (item.method === 'sendText' && stop) live.add(1001 + index);
    if (item.method === 'editText') { if (stop) live.add(item.messageId); else live.delete(item.messageId); }
  });
  return [...live];
}
const cards = f => methods(f, 'sendText').filter(item => /^<pre>|^<code>/.test(item.text));

test('a steer during a turn, from Telegram or the desktop, keeps editing the same single card', async t => {
  const f = await fixture(t);
  f.codex.turns.set('A', [{ id: 'turn-A', status: 'inProgress', startedAt: Date.now() / 1000, items: [] }]);
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'turn-A', startedAt: Date.now(), watching: true });
  f.gateway.subscribed.add('A');
  await f.gateway.refreshStatus('A');
  await f.gateway.receive(topicMessage(170, 10, 'Уточнение из Telegram'));
  await dispatchPending(f);
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'turn-A', item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'Уточнение с компьютера' }] } });
  await f.gateway.refreshStatuses();
  assert.equal(f.codex.calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(cards(f).length, 1);
  assert.ok(methods(f, 'editText').length >= 2);
  assert.deepEqual(liveStops(f), [f.sent.indexOf(cards(f)[0]) + 1001]);
});

test('a new desktop turn collapses the previous open card first and is marked when it starts by itself', async t => {
  const f = await fixture(t);
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'old', startedAt: Date.now() - 60000, watching: true });
  await f.gateway.refreshStatus('A');
  await f.gateway.onEvent('turn/started', { threadId: 'A', turn: { id: 'new', status: 'inProgress', startedAt: Date.now() / 1000, items: [] } });
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'new', item: { type: 'reasoning', id: 'r' } });
  await f.gateway.refreshStatus('A');
  const [oldCard, newCard] = cards(f);
  assert.match(newCard.text, /^<pre>▶ ⤷ 0:0\d · model-old · high\nпродолжение\nдумаю · 0:0\d<\/pre>$/);
  const collapse = methods(f, 'editText').find(item => item.messageId === f.sent.indexOf(oldCard) + 1001);
  assert.equal(collapse.text, '<code>▪ ход завершён</code>');
  assert.deepEqual(liveStops(f), [f.sent.indexOf(newCard) + 1001]);
  await f.gateway.onEvent('turn/completed', { threadId: 'A', turn: { id: 'new', status: 'completed', durationMs: 3000, items: [] } });
  assert.equal(methods(f, 'editText').at(-1).text, '<code>⤷ ✓ 0:03 · model-old · high</code>');
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'desk', startedAt: Date.now() });
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'desk', item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'с компьютера' }] } });
  await f.gateway.finish('A', { id: 'desk', status: 'completed', durationMs: 2000, items: [] });
  assert.equal(methods(f, 'sendText').at(-1).text, '<code>💻 ✓ 0:02 · model-old · high</code>');
  assert.equal(collapse.options.reply_markup, undefined);
  assert.deepEqual(liveStops(f), []);
});

test('an own turn is never marked as self-started, even when turn/started precedes the turn/start reply', async t => {
  const f = await fixture(t);
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => {
    if (method === 'turn/start') await f.gateway.onEvent('turn/started', { threadId: params.threadId, turn: { id: 'own', status: 'inProgress', startedAt: Date.now() / 1000, items: [] } });
    return method === 'turn/start' ? { turn: { id: 'own' } } : request(method, params);
  };
  await f.gateway.startInput('A', [{ type: 'text', text: 'hi' }], 5);
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'own', item: { type: 'reasoning', id: 'r' } });
  assert.equal(f.state.chat('A').trigger, null);
  await f.gateway.refreshStatus('A');
  assert.doesNotMatch(cards(f)[0].text, /⤷/);
});

test('a bot restart mid-turn resumes the same card; missed turns never leave a stale Stop', async t => {
  const f = await fixture(t);
  f.codex.turns.set('A', [{ id: 'T', status: 'inProgress', startedAt: Date.now() / 1000, items: [] }]);
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'T', startedAt: Date.now(), watchSince: Date.now() - 1000 });
  await f.gateway.refreshStatus('A');
  const restarted = new Gateway({ api: f.gateway.api, codex: f.codex, state: f.state, ownerId: OWNER, root: f.dir, dataDir: f.dir, projects: [PROJECT] });
  restarted.log = () => {};
  await restarted.recoverChat('A');
  await restarted.refreshStatus('A');
  assert.equal(cards(f).length, 1, 'the running turn keeps its card after a restart');
  f.codex.turns.set('A', [{ id: 'U', status: 'completed', startedAt: Date.now() / 1000, items: [] }]);
  await restarted.recoverChat('A');
  assert.deepEqual(liveStops(f), []);
  assert.equal(f.state.chat('A').card.collapsed, true);
});

test('a card shown before the turn id is known is adopted instead of duplicated', async t => {
  const f = await fixture(t);
  f.state.saveChat({ id: 'A', status: 'active', turnId: null, startedAt: Date.now() });
  await f.gateway.refreshStatus('A');
  f.state.saveChat({ id: 'A', turnId: 'known', ownedTurnId: 'known' });
  await f.gateway.refreshStatus('A');
  await f.gateway.finish('A', { id: 'known', status: 'completed', durationMs: 5000, items: [] });
  assert.equal(cards(f).length, 1);
  assert.equal(methods(f, 'editText').at(-1).text, '<code>✓ 0:05 · model-old · high</code>');
  assert.deepEqual(liveStops(f), []);
});

test('agents still running at turn end become background work until their threads stop', async t => {
  const f = await fixture(t);
  f.gateway.subscribed.add('A');
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'T', ownedTurnId: 'T', startedAt: Date.now() - 10000, watching: true });
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'T', item: { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/explorer' } });
  await f.gateway.onEvent('item/started', { threadId: 'A', turnId: 'T', item: { type: 'subAgentActivity', id: 's2', kind: 'completed', agentThreadId: 'child-2', agentPath: '/root/review' } });
  assert.match(f.gateway.statusText(f.state.chat('A')), /агенты 1\/2: explorer 0:0\d · review ✓/);
  f.codex.childStatus = { 'child-1': 'active' };
  await f.gateway.onEvent('turn/completed', { threadId: 'A', turn: { id: 'T', status: 'completed', durationMs: 10000, items: [] } });
  assert.equal(methods(f, 'sendText').at(-1).text, '<code>✓ 0:10 · model-old · high · фон 1</code>');
  assert.equal(f.gateway.hasWork(f.state.chat('A')), true, 'background work keeps the subscription');
  f.codex.terminals = [{ itemId: 'cmd', processId: 'p1', command: "/bin/bash -lc 'npm run dev'" }];
  await f.gateway.refreshStatuses();
  assert.equal(methods(f, 'editText').at(-1).text, '<code>✓ 0:10 · model-old · high · фон 2</code>');
  f.state.saveChat({ id: 'A', status: 'active', turnId: 'N', startedAt: Date.now() });
  assert.match(f.gateway.statusText(f.state.chat('A')), /фон: агент «explorer» 0:\d\d · bash: npm run dev 0:00/);
  f.state.saveChat({ id: 'A', status: 'idle', turnId: null });
  f.codex.childStatus = {};
  f.codex.terminals = [];
  await f.gateway.refreshStatuses();
  assert.equal(methods(f, 'editText').at(-1).text, '<code>✓ 0:10 · model-old · high</code>');
  assert.equal(f.gateway.hasWork(f.state.chat('A')), false);
});

test('topics get the project icon; a rejected icon never blocks the topic', async t => {
  const f = await fixture(t);
  await f.gateway.newChat(PROJECT.key);
  assert.equal(methods(f, 'createForumTopic')[0].params.icon_custom_emoji_id, '5348227245599105972');
  const request = f.gateway.api.request;
  f.gateway.api.request = async (method, params) => {
    if (method === 'createForumTopic' && params.icon_custom_emoji_id) { f.sent.push({ method, params }); throw new TelegramApiError(method, 400, 'Bad Request: invalid custom emoji identifier'); }
    return request(method, params);
  };
  const topic = await f.gateway.newChat(PROJECT.key);
  assert.equal(topic.icon, null);
  assert.equal(methods(f, 'createForumTopic').at(-1).params.icon_custom_emoji_id, undefined);
});

test('a failed lobby topic keeps polling alive and the redelivered message opens its chat', async t => {
  const f = await fixture(t);
  const request = f.gateway.api.request;
  let fail = true;
  f.gateway.api.request = async (method, params) => {
    if (method === 'createForumTopic' && fail) { f.sent.push({ method, params }); throw new TelegramApiError(method, 0, 'request timed out'); }
    return request(method, params);
  };
  const update = message(180, 'Задача из общего чата');
  await f.gateway.receive(update);
  assert.deepEqual(f.state.held('lobby'), [180]);
  assert.match(methods(f, 'sendText').at(-1).text, /Не удалось открыть тему/);
  fail = false;
  await f.gateway.receive(update);
  assert.deepEqual(f.state.held('lobby'), []);
  assert.deepEqual(f.state.pending().map(row => [row.id, row.thread_id]), [[180, 'topic:101']]);
  await f.gateway.receive(update);
  assert.equal(methods(f, 'createForumTopic').length, 2, 'one failed and one successful attempt; a released message is not reopened');
});

test('buttons of the old menu only answer that they are stale', async t => {
  const f = await fixture(t);
  for (const [index, type] of ['home', 'models', 'context', 'files', 'compact', 'history'].entries()) await f.gateway.receive(callback(190 + index, f.gateway.button(type, type, { id: 'A' }).callback_data));
  assert.deepEqual(methods(f, 'answerCallbackQuery').map(item => item.params.text), Array(6).fill('Кнопка устарела'));
  assert.equal(f.sent.length, 6);
  assert.equal(f.codex.calls.length, 0);
});

test('folders of existing Codex chats join the project list once; missing folders and subagents are skipped', async t => {
  const f = await fixture(t);
  const site = join(f.dir, 'site');
  await mkdir(site);
  f.codex.listed = [{ id: 'X', cwd: site }, { id: 'Y', cwd: site }, { id: 'Z', cwd: join(f.dir, 'gone') }, { id: 'S', cwd: f.dir, parentThreadId: 'X' }, { id: 'W', cwd: PROJECT.path }];
  await f.gateway.discoverProjects();
  assert.deepEqual(f.gateway.projects.map(p => [p.label, p.favorite]), [['Workspace', true], ['site', false]]);
});

test('with the cloud Bot API a file over 50 MB is not uploaded; the answer names where it lies', async t => {
  const f = await fixture(t);
  const big = join(f.dir, 'video.mov');
  await writeFile(big, '');
  await (await import('node:fs/promises')).truncate(big, 51 * 1024 * 1024);
  await f.gateway.sendArtifacts('A', `[video](${big})`, 'big-1');
  await f.gateway.sendArtifacts('A', `[video](${big})`, 'big-1');
  assert.equal(methods(f, 'sendDocument').length, 0);
  const notes = methods(f, 'sendText').filter(item => /больше 50 МБ/.test(item.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /video\.mov/);
});
