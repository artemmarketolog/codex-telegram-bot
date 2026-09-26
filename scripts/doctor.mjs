// Checks everything the bot needs and says in plain words what to fix. Never prints secret values.
// Safe to run while the bot is running: it does not read Telegram updates.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail });
const warn = (name, detail) => results.push({ level: 'warn', name, detail });
const fail = (name, detail) => results.push({ level: 'fail', name, detail });

async function run(command, args, timeout = 30_000) {
  const { stdout, stderr } = await execute(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

// 1. Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok('Node.js', process.versions.node);
else fail('Node.js', `нужна версия 22.13 или новее, сейчас ${process.versions.node}`);
if (existsSync(resolve(root, 'node_modules/ws'))) ok('Зависимости', 'npm install выполнен');
else fail('Зависимости', 'выполни `npm install` в папке бота');

// 2. .env
const env = process.env;
if (!existsSync(resolve(root, '.env'))) warn('.env', 'файла нет: скопируй `.env.example` в `.env` и заполни');
const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) ok('TELEGRAM_BOT_TOKEN', 'формат верный');
else fail('TELEGRAM_BOT_TOKEN', 'не задан или неверный формат (берётся у @BotFather, вид `123456789:AA...`)');
const ownerId = Number(env.TELEGRAM_OWNER_ID);
if (Number.isSafeInteger(ownerId) && ownerId > 0) ok('TELEGRAM_OWNER_ID', 'число задано');
else fail('TELEGRAM_OWNER_ID', 'нужен твой числовой Telegram ID (например, из @userinfobot)');

// 3. ffmpeg
try { await run('ffmpeg', ['-version']); ok('ffmpeg', 'установлен'); }
catch { fail('ffmpeg', 'не найден: нужен для голосовых (Ubuntu: `sudo apt install -y ffmpeg`, macOS: `brew install ffmpeg`)'); }

// 4. Codex CLI, login and daemon
const codexBin = env.CODEX_BIN || 'codex';
let codexReady = false;
try {
  ok('Codex CLI', (await run(codexBin, ['--version'])).split('\n')[0]);
  try {
    const status = await run(codexBin, ['login', 'status']);
    if (/logged in/i.test(status) && !/not logged in/i.test(status)) { ok('Вход в Codex', status.split('\n')[0].replace(/ - .*$/, '')); codexReady = true; }
    else fail('Вход в Codex', 'выполни `codex login` (на сервере без браузера: `codex login --device-auth`)');
  } catch { fail('Вход в Codex', 'выполни `codex login` (на сервере без браузера: `codex login --device-auth`)'); }
} catch { fail('Codex CLI', 'не найден: `npm install -g @openai/codex` (или укажи путь в CODEX_BIN)'); }

if (codexReady) {
  try {
    const { ensureDaemon } = await import('./ensure-codex-daemon.mjs');
    const daemon = await ensureDaemon({ statusOnly: !process.argv.includes('--start-daemon') });
    if (daemon.status === 'running') ok('Codex daemon', `работает${daemon.version ? `, версия ${daemon.version}` : ''}${daemon.action === 'started' ? ' (только что запущен)' : ''}`);
    else fail('Codex daemon', 'не запущен: `codex app-server daemon start` или `npm run doctor -- --start-daemon`');
  } catch (error) { fail('Codex daemon', `не удалось проверить: ${error.message}`); }
  try {
    const { CodexClient, defaultSocketPath } = await import('../lib/codex.mjs');
    const codex = new CodexClient({ socketPath: env.CODEX_SOCKET || defaultSocketPath(), clientName: 'codex_telegram_doctor' });
    await codex.connect();
    const models = await codex.request('model/list', { limit: 100 });
    await codex.close();
    ok('Связь бота с Codex', `моделей доступно: ${models.data.length}`);
  } catch (error) { fail('Связь бота с Codex', `сокет daemon недоступен (${error.message}). Запусти daemon и повтори.`); }
}

// 5. Telegram: identity, Threaded Mode, owner chat
if (token && Number.isSafeInteger(ownerId) && ownerId > 0) {
  const { BotApi, apiOptionsFromEnv } = await import('../lib/telegram.mjs');
  const options = apiOptionsFromEnv();
  try {
    const api = new BotApi({ token, ...options, minChatIntervalMs: 0 });
    const me = await api.request('getMe');
    ok('Бот в Telegram', `@${me.username}${options.local ? ' (свой Local Bot API)' : ''}`);
    if (options.local) ok('Большие файлы', `свой Local Bot API ${options.apiBase}: файлы до 2000 МБ в обе стороны`);
    else warn('Большие файлы', 'облачный Bot API: бот получает файлы до 20 МБ и отправляет до 50 МБ. Для больших — `bash scripts/install-local-bot-api.sh` (docs/LOCAL-BOT-API.md)');
    if (me.has_topics_enabled) ok('Threaded Mode', 'темы в личном чате включены');
    else fail('Threaded Mode', 'выключен. @BotFather → кнопка Open (мини-приложение) → My bots → бот → Bot Settings → Threads Settings → включи Threaded Mode. Командами в чате BotFather это не делается');
    if (me.has_topics_enabled && me.allows_users_to_create_topics === false) warn('Создание тем', 'пользователю запрещено создавать темы: включи это там же, в Threads Settings');
    try {
      await api.request('sendChatAction', { chat_id: ownerId, action: 'typing' });
      ok('Чат владельца', 'бот может писать владельцу');
    } catch (error) {
      fail('Чат владельца', /chat not found|bot was blocked|user not found/i.test(error.message)
        ? 'бот не может написать тебе: открой бота в Telegram и нажми Start, проверь TELEGRAM_OWNER_ID'
        : `Telegram ответил ошибкой: ${error.message}`);
    }
  } catch (error) {
    fail('Бот в Telegram', error.code === 401 ? (options.local ? 'свой Local Bot API не принял токен: проверь TELEGRAM_BOT_TOKEN и сервис telegram-bot-api' : 'Telegram отклонил токен: возьми актуальный у @BotFather') : `нет связи с ${options.local ? `Local Bot API ${options.apiBase} (запущен ли сервис telegram-bot-api?)` : 'Telegram'}: ${error.message}`);
  }
}

// 6. Voice: OpenAI (recommended) or local whisper.cpp (free)
if (env.OPENAI_API_KEY) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    if (response.ok) ok('Голосовые: OpenAI', 'ключ принят (баланс проверь на platform.openai.com → Billing)');
    else fail('Голосовые: OpenAI', response.status === 401 ? 'ключ OpenAI неверный или отозван' : `OpenAI ответил ${response.status}`);
  } catch { warn('Голосовые: OpenAI', 'не удалось связаться с api.openai.com'); }
} else if (env.LOCAL_STT_MODEL) {
  const cli = env.LOCAL_STT_CLI || (/parakeet/i.test(env.LOCAL_STT_MODEL) ? 'parakeet-cli' : 'whisper-cli');
  try { await access(env.LOCAL_STT_MODEL, constants.R_OK); ok('Локальная модель речи', env.LOCAL_STT_MODEL); }
  catch { fail('Локальная модель речи', `файл не найден: ${env.LOCAL_STT_MODEL}`); }
  try { await run(cli, ['--help'], 15_000); ok('Голосовые: локально', cli); }
  catch { fail('Голосовые: локально', `${cli} не найден: \`bash scripts/install-local-stt.sh\` или путь в LOCAL_STT_CLI`); }
} else warn('Голосовые', 'не настроены: добавь OPENAI_API_KEY (рекомендуется) или локальную модель (docs/VOICE.md). Текст и файлы работают и без этого');

// 7. Projects
try {
  const { readProjects } = await import('../lib/projects.mjs');
  const projects = readProjects(resolve(root, env.PROJECTS_FILE || 'projects.json'));
  ok('Проекты', projects.map(p => `${p.label} (${p.path})`).join(', '));
} catch (error) { fail('Проекты', error.message); }

const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
for (const item of results) console.log(`${icon[item.level]} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
const failed = results.filter(item => item.level === 'fail').length;
console.log(failed ? `\nНужно исправить: ${failed}.` : '\nВсё готово. Запусти бота: `npm start` (или установи автозапуск: `bash scripts/install-service.sh`).');
process.exitCode = failed ? 1 : 0;
