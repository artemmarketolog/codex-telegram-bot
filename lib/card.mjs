import { contextFill } from './projects.mjs';

// Status card of one turn. Pure, so every state is testable.

export const clock = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};
export const tokens = n => n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const cut = (value, length) => {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : chars.join('');
};

// Why a turn started without a message: Codex injects a finished subagent as <subagent_notification>.
// Returns null for a user message, a label for a self-started turn, undefined when still unknown.
export function triggerOf(item) {
  if (!item || item.type === 'contextCompaction') return undefined;
  if (item.type !== 'userMessage') return 'продолжение';
  const text = (item.content ?? []).map(part => part.text ?? '').join(' ').trimStart();
  return text.startsWith('<subagent_notification') ? 'после фоновой задачи' : null;
}

const agentMark = (agent, now) => agent.status === 'running' ? clock(now - (agent.startedAt ?? now)) : agent.status === 'completed' ? '✓' : '✗';

export function backgroundLine(chat, now = Date.now()) {
  const items = Object.values(chat.background ?? {});
  if (!items.length) return '';
  const shown = items.slice(-3).map(b => `${b.kind === 'agent' ? `агент «${cut(b.name, 18)}»` : `bash: ${cut(b.name, 20)}`} ${clock(now - (b.startedAt ?? now))}`);
  return `фон: ${shown.join(' · ')}${items.length > 3 ? ` · +${items.length - 3}` : ''}`;
}

// Live card lines: time/model, why it started, context, current action with its age, agents,
// background work, waits, queue, account limits.
export function cardLines(chat, { now = Date.now(), limits = null, queued = 0, waiting = false } = {}) {
  const lines = [`▶ ${chat.trigger ? '⤷ ' : ''}${clock(now - (chat.startedAt ?? now))} · ${chat.model || '—'} · ${chat.effort || '—'}`];
  if (chat.trigger) lines.push(chat.trigger);
  const fill = contextFill(chat.usage);
  if (fill) lines.push(`контекст ${fill.percent}% · ${tokens(fill.input)}/${tokens(fill.window)}`);
  lines.push(`${chat.action || 'думаю'} · ${clock(now - (chat.actionAt ?? chat.startedAt ?? now))}`);
  const agents = Object.values(chat.agents ?? {});
  if (agents.length) lines.push(`агенты ${agents.filter(a => a.status === 'running').length}/${agents.length}: ${agents.slice(-3).map(a => `${cut(a.name || 'агент', 14)} ${agentMark(a, now)}`).join(' · ')}`);
  const background = backgroundLine(chat, now);
  if (background) lines.push(background);
  if (waiting) lines.push('❓ жду ответа');
  if (queued) lines.push(`очередь ${queued}${chat.queuePaused ? ' · пауза' : ''}`);
  if (limits) lines.push(`лимит ${limits}`);
  return lines;
}

// One line once the turn is over: `💻` a turn started on the computer, `⤷` one Codex started by itself,
// `· фон N` while background work still runs.
export function finalLine(chat, { limits = null } = {}) {
  const turn = chat.lastTurn ?? {};
  const running = Object.keys(chat.background ?? {}).length;
  const background = running ? ` · фон ${running}` : '';
  const prefix = `${turn.origin === 'desktop' ? '💻 ' : ''}${turn.trigger ? '⤷ ' : ''}`;
  const time = clock(turn.durationMs ?? 0);
  if (!turn.status) return `▪ ход завершён${background}`;
  if (turn.status === 'interrupted') return `${prefix}■ остановлено · ${time}${background}`;
  if (turn.status === 'failed') return `${prefix}✗ ${cut(turn.error || 'ошибка выполнения', 120)}`;
  const fill = contextFill(chat.usage);
  return `${prefix}${[`✓ ${time}`, chat.model, chat.effort, fill ? `ctx ${fill.percent}%` : null, limits].filter(Boolean).join(' · ')}${background}`;
}
