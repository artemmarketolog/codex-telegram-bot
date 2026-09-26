# Codex Telegram Bot — notes for AI agents

- **Installing for a user?** Follow the «Для ИИ-агента» section of [INSTALL.md](INSTALL.md) step by step and verify each step with a command. Finish only when `npm run doctor` shows no ❌ and the user got an answer in Telegram.
- Never print, echo or commit secret values (`.env`, bot token, OpenAI key, `~/.codex/auth.json`).
- Threaded Mode can be switched on only in the BotFather mini app (Open → My bots → bot → Bot Settings → Threads Settings); there is no command for it. Ask the user to do it.
- Run exactly one bot process per token (a service or `npm start`, not both): Telegram answers 409 otherwise.
- The bot talks to `codex app-server daemon` over `~/.codex/app-server-control/app-server-control.sock`. Do not edit Codex's own files in `~/.codex`.

## Development

- Node.js 22.13+, ESM, no build step, one dependency (`ws`). Tests: `npm test` (node:test with fake Codex and Telegram; real `ffmpeg` is required).
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Keep the concurrency rules in `lib/gateway.mjs`: one worker per topic, one event chain per thread, `withTurnLock` for input/queue/stop, `cardLocks` for card edits. After touching them run `LOAD_SEEDS=80 npm test`.
- User-facing text is Russian.
