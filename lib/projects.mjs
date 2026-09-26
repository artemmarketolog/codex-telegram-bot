import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Projects are folders on this machine. `projects.json` lists favourites ([{ "label", "path" }]);
// folders of existing Codex chats are added at startup under «Все проекты» (see Gateway.discoverProjects).
export function readProjects(configPath, { home = homedir(), defaultPath = process.env.DEFAULT_PROJECT } = {}) {
  let seeds = [];
  if (configPath && existsSync(configPath)) {
    seeds = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!Array.isArray(seeds)) throw new Error(`${configPath}: ожидается массив [{ "label": "...", "path": "/абсолютный/путь" }].`);
  }
  const projects = new Map();
  const add = (path, label, favorite) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    const clean = resolve(path);
    if (!projects.has(clean) && existsSync(clean)) projects.set(clean, makeProject(clean, label, favorite, home));
  };
  for (const seed of seeds) add(seed?.path, seed?.label, true);
  if (defaultPath) add(defaultPath, null, true);
  if (!projects.size) add(home, null, true);
  return [...projects.values()];
}

export function makeProject(path, label, favorite = false, home = homedir()) {
  const name = label || folderLabel(path, home);
  return { label: name, short: name, path, favorite, key: createHash('sha256').update(path).digest('hex').slice(0, 12) };
}

export function folderLabel(cwd, home = homedir()) {
  if (cwd === home) return 'home';
  return basename(cwd) || cwd;
}

// A title for a topic name: at most ~45 characters, cut at a word boundary.
export function briefTitle(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 45) return clean || 'Новый чат';
  const head = clean.slice(0, 44);
  const space = head.lastIndexOf(' ');
  return `${(space >= 20 ? head.slice(0, space) : head).replace(/[\s,.;:!?—-]+$/, '')}…`;
}

export function shortTitle(thread) {
  return (thread.name || thread.title || thread.preview || 'Новый чат').replace(/\s+/g, ' ').slice(0, 65);
}

// Window fullness is the latest main-branch input over the model window, not cumulative spend.
export function contextFill(usage) {
  const input = usage?.last?.inputTokens;
  const window = usage?.modelContextWindow;
  if (!input || !window) return null;
  return { input, window, percent: Math.min(100, Math.round(input / window * 100)) };
}

// Topic icon per project: a meaningful emoji by keyword, otherwise a stable pick from a neutral set.
const ICON_RULES = [
  [/workspace/, '💼'], [/infra|server|vps|deploy/, '⚡️'], [/ads|meta|marketing|seo/, '📈'],
  [/telegram|bot|agent/, '🤖'], [/school|course|lesson/, '🎓'], [/clinic|health/, '🩺'],
  [/food|cafe|restaurant/, '🍽'], [/game/, '🎮'], [/task|planner|todo/, '📝'], [/home/, '🏠'],
  [/crm|finance|invoice|money/, '💰'], [/whisper|voice|audio/, '🎙'],
  [/research/, '🔮'], [/design|carousel|brand/, '🎨'], [/video|reels|creative/, '🎬'],
];
const ICON_FALLBACK = ['💡', '📁', '🔎', '📚', '💎', '🧠', '🔭', '🧪', '📰', '🗣', '✍️', '🔥'];

// Pass the project label and/or its path; the home directory prefix is ignored.
export function topicIcon(project = '') {
  const key = String(project).toLowerCase().replaceAll(`${homedir().toLowerCase()}/`, '');
  for (const [pattern, emoji] of ICON_RULES) if (pattern.test(key)) return emoji;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ICON_FALLBACK[hash % ICON_FALLBACK.length];
}

// custom_emoji_id of the project's icon, from the getForumTopicIconStickers list in assets/.
const iconIds = new Map(JSON.parse(readFileSync(new URL('../assets/topic-icons.json', import.meta.url), 'utf8')).map(icon => [icon.emoji, icon.id]));
export function topicIconId(path) { return iconIds.get(topicIcon(path)) ?? null; }
