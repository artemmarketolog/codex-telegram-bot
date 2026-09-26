import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLines, finalLine, triggerOf } from '../lib/card.mjs';

const NOW = 1_800_000_000_000;
const base = { model: 'gpt-6-astra', effort: 'xhigh', startedAt: NOW - 222_000, usage: { last: { inputTokens: 380000 }, modelContextWindow: 1000000 } };

test('live card lines: agents, background, waits, queue and limits in a fixed order', () => {
  const chat = { ...base, action: 'Bash: npm test', actionAt: NOW - 37_000, queuePaused: false,
    agents: { a: { name: 'explorer', status: 'running', startedAt: NOW - 70_000 }, b: { name: 'review', status: 'completed', startedAt: NOW - 90_000 } },
    background: { 'agent:c': { kind: 'agent', name: 'аудит', startedAt: NOW - 750_000 }, 'terminal:7': { kind: 'terminal', name: 'npm run build --workspaces', startedAt: NOW - 40_000 } } };
  assert.deepEqual(cardLines(chat, { now: NOW, limits: '5ч 34% · 7д 20%', queued: 2, waiting: true }), [
    '▶ 3:42 · gpt-6-astra · xhigh',
    'контекст 38% · 380k/1M',
    'Bash: npm test · 0:37',
    'агенты 1/2: explorer 1:10 · review ✓',
    'фон: агент «аудит» 12:30 · bash: npm run build --wor… 0:40',
    '❓ жду ответа',
    'очередь 2',
    'лимит 5ч 34% · 7д 20%',
  ]);
});

test('thinking for minutes shows its own ticking time, and a self-started turn is marked', () => {
  const thinking = cardLines({ ...base, usage: null, action: 'думаю', actionAt: NOW - 95_000 }, { now: NOW });
  assert.deepEqual(thinking, ['▶ 3:42 · gpt-6-astra · xhigh', 'думаю · 1:35']);
  const continued = cardLines({ ...base, usage: null, action: 'думаю', actionAt: NOW, trigger: 'после фоновой задачи' }, { now: NOW });
  assert.deepEqual(continued.slice(0, 2), ['▶ ⤷ 3:42 · gpt-6-astra · xhigh', 'после фоновой задачи']);
});

test('the collapsed line for every outcome, with live background work counted', () => {
  const done = { ...base, lastTurn: { id: 't', status: 'completed', durationMs: 408_000 } };
  assert.equal(finalLine(done, { limits: '7д 62%' }), '✓ 6:48 · gpt-6-astra · xhigh · ctx 38% · 7д 62%');
  assert.equal(finalLine({ ...done, background: { 'agent:x': { kind: 'agent' } } }), '✓ 6:48 · gpt-6-astra · xhigh · ctx 38% · фон 1');
  assert.equal(finalLine({ ...done, lastTurn: { ...done.lastTurn, trigger: 'продолжение' } }), '⤷ ✓ 6:48 · gpt-6-astra · xhigh · ctx 38%');
  assert.equal(finalLine({ ...done, lastTurn: { ...done.lastTurn, origin: 'desktop' } }), '💻 ✓ 6:48 · gpt-6-astra · xhigh · ctx 38%');
  assert.equal(finalLine({ ...done, lastTurn: { id: 't', status: 'interrupted', durationMs: 62_000, origin: 'desktop' } }), '💻 ■ остановлено · 1:02');
  assert.equal(finalLine({ ...done, lastTurn: { id: 't', status: 'interrupted', durationMs: 62_000 } }), '■ остановлено · 1:02');
  assert.equal(finalLine({ ...done, lastTurn: { id: 't', status: 'failed', error: 'usage limit reached' } }), '✗ usage limit reached');
  assert.equal(finalLine({}), '▪ ход завершён');
});

test('a turn is self-started unless it opens with a real user message', () => {
  const user = text => ({ type: 'userMessage', content: [{ type: 'text', text }] });
  assert.equal(triggerOf(user('Сделай отчёт')), null);
  assert.equal(triggerOf(user('<subagent_notification>{"agent":"x"}</subagent_notification>')), 'после фоновой задачи');
  assert.equal(triggerOf({ type: 'reasoning' }), 'продолжение');
  assert.equal(triggerOf({ type: 'contextCompaction' }), undefined);
});
