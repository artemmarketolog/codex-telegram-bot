import { setDefaultResultOrder } from 'node:dns';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// node:sqlite without a flag needs Node 22.13+; check before importing modules that use it.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Нужен Node.js 22.13 или новее, сейчас ${process.versions.node}.`);
  process.exit(1);
}
const { State } = await import('./lib/state.mjs');
const { BotApi, apiOptionsFromEnv } = await import('./lib/telegram.mjs');
const { CodexClient, defaultSocketPath } = await import('./lib/codex.mjs');
const { readProjects } = await import('./lib/projects.mjs');
const { Gateway } = await import('./lib/gateway.mjs');

setDefaultResultOrder('ipv4first');
process.umask(0o077);
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.CODEX_TELEGRAM_DATA || join(homedir(), '.codex-telegram'));
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ownerId = Number(process.env.TELEGRAM_OWNER_ID);
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token ?? '')) throw new Error('TELEGRAM_BOT_TOKEN не задан или выглядит неверно (формат 123456:ABC...). Проверь .env.');
if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('TELEGRAM_OWNER_ID должен быть твоим числовым Telegram ID. Проверь .env.');
await mkdir(join(dataDir, 'data'), { recursive: true, mode: 0o700 });
await mkdir(join(dataDir, 'files'), { recursive: true, mode: 0o700 });
const state = new State(join(dataDir, 'data/state.sqlite'));
const api = new BotApi({ token, ...apiOptionsFromEnv() });
const codex = new CodexClient({ socketPath: process.env.CODEX_SOCKET || defaultSocketPath() });
const projects = readProjects(resolve(root, process.env.PROJECTS_FILE || 'projects.json'));
const defaultProject = process.env.DEFAULT_PROJECT ? resolve(process.env.DEFAULT_PROJECT) : null;
const botId = Number(token.split(':')[0]);
const gateway = new Gateway({ api, codex, state, ownerId, botId, root, dataDir, projects, defaultProject, secrets: [token, process.env.OPENAI_API_KEY, process.env.TELEGRAM_API_HASH] });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await gateway.close();
  state.close();
}
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('unhandledRejection', error => { gateway.log('unhandled_rejection', error); void shutdown().finally(() => process.exit(1)); });
try {
  await gateway.start();
  await writeFile(join(dataDir, 'data/health.json'), JSON.stringify({ startedAt: new Date().toISOString(), botId, models: gateway.models.length, projects: projects.length, apiLocal: api.local }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'ready', models: gateway.models.length, projects: projects.length }));
  await api.poll(update => gateway.receive(update), {
    offset: state.get('telegramOffset', 0),
    onOffset: offset => state.set('telegramOffset', offset),
    onError: error => gateway.log('poll_error', error),
  });
} catch (error) {
  gateway.log('startup_error', error);
  if (/ENOENT|ECONNREFUSED/.test(error?.message ?? '')) gateway.log('hint', 'Codex daemon не запущен: выполни `codex app-server daemon start` (или `npm run doctor`).');
  if (error?.code === 401) gateway.log('hint', 'Telegram отклонил токен: проверь TELEGRAM_BOT_TOKEN.');
  if (error?.code === 409) gateway.log('hint', 'Этого бота уже опрашивает другой процесс: останови вторую копию.');
  await shutdown();
  process.exitCode = 1;
}
