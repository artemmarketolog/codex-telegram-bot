# 🛠 Если что-то не работает

Сначала всегда:

```bash
cd ~/codex-telegram-bot
npm run doctor
```

Doctor проверяет Node.js, `.env`, ffmpeg, Codex, daemon, связь с Telegram, Threaded Mode, чат владельца, голосовые и проекты. Каждая ❌ пишет, что сделать. Потом смотри лог:

- Linux: `journalctl --user -u codex-telegram -n 50 --no-pager`
- macOS: `tail -n 50 ~/Library/Logs/codex-telegram/bot.log`

## Бот молчит

| Признак | Причина и решение |
| --- | --- |
| `❌ Чат владельца` | Ты не нажал **Start** в своём боте, или `TELEGRAM_OWNER_ID` не твой. ID смотри в [@userinfobot](https://t.me/userinfobot). |
| В логе `401` / `Unauthorized` | Неверный или перевыпущенный токен. Возьми актуальный в @BotFather и обнови `.env`. |
| В логе `409` / `Conflict` | Этого бота опрашивает второй процесс: запущен и сервис, и `npm start`, или бот работает на другой машине. Оставь один. |
| Сервис не `active` | `systemctl --user status codex-telegram` покажет ошибку запуска. После правки `.env` — `systemctl --user restart codex-telegram`. |
| Бот отвечает только тебе | Так и задумано: остальных он игнорирует. |

## «Включи темы для бота» / `the chat is not a forum`

Не включён Threaded Mode. Он включается **только в мини-приложении BotFather**: [@BotFather](https://t.me/BotFather) → кнопка **Open** → **My bots** → бот → **Bot Settings** → **Threads Settings** → **Threaded Mode**. Командами в чате BotFather этого не сделать. После включения перезапуск не нужен, просто напиши боту снова.

## Codex

| Признак | Что делать |
| --- | --- |
| `❌ Codex daemon` / в логе `ENOENT ... app-server-control.sock` | Daemon не запущен: `npm run doctor -- --start-daemon` или `codex app-server daemon start`. Автозапуск (`bash scripts/install-service.sh`) проверяет его каждые 30 секунд. |
| `❌ Вход в Codex` | `codex login` (на сервере `codex login --device-auth`, предварительно включи device code authorization в ChatGPT → Settings → Security). |
| Ответы стали падать с ошибкой авторизации | Вход устарел: `codex login` заново, затем `systemctl --user restart codex-telegram`. |
| После обновления Codex (`npm install -g @openai/codex`) бот ведёт себя странно | Daemon остался старой версии. Перезапусти его, когда никаких задач не идёт: `codex app-server daemon restart`, затем перезапусти бота. |
| Карточка пишет «Ход ждёт инструмент приложения Codex на компьютере» | Ход начат в приложении и ждёт инструмент, которого нет на сервере. `/stop`, затем напиши «продолжи». |

## Голосовые

| Сообщение под голосовым | Что делать |
| --- | --- |
| «Расшифровка голосовых не настроена» | Добавь `OPENAI_API_KEY` или поставь локальную модель ([VOICE.md](VOICE.md)). |
| «Сервис распознавания отклонил ключ OpenAI» | Ключ неверный или удалён: создай новый на [platform.openai.com/api-keys](https://platform.openai.com/api-keys). |
| «Сервис распознавания вернул ошибку 429» | Закончился баланс API или превышен лимит: пополни [Billing](https://platform.openai.com/settings/organization/billing/overview). |
| «Не удалось запустить ffmpeg» | Поставь ffmpeg: `sudo apt-get install -y ffmpeg` или `brew install ffmpeg`, перезапусти бота. |
| «Локальная модель речи не найдена» | Неверный `LOCAL_STT_CLI` в `.env`: запусти `bash scripts/install-local-stt.sh` ещё раз. |

## Файлы

| Признак | Причина |
| --- | --- |
| «Файл больше 20 МБ…» | Облачный Bot API не отдаёт ботам файлы больше 20 МБ. Поставь свой [Local Bot API](LOCAL-BOT-API.md): `bash scripts/install-local-bot-api.sh`. |
| После установки Local Bot API бот замолчал | Кто-то обратился с токеном к `api.telegram.org` (даже `getMe`), и бот вернулся в облако. Останови бота, один раз выполни облачный `logOut` ([LOCAL-BOT-API.md](LOCAL-BOT-API.md#️-главное-правило-после-переезда)) и запусти снова. Проверь, что сервис `telegram-bot-api` работает: `systemctl --user status telegram-bot-api`. |
| «Файл … больше 50 МБ — облачный Telegram Bot API не отправит его» | Лимит отправки для ботов в облаке 50 МБ. Файл остался на машине по указанному пути. |
| Codex сделал файл, а он не пришёл | Бот отправляет файлы, на которые Codex дал ссылку с **абсолютным путём** в финальном ответе. Попроси: «пришли файл ссылкой». Файлы с секретами (`.env`, ключи, `auth.json`) бот не отправляет намеренно. |

## Полная переустановка без потери чатов

Чаты Codex хранятся в `~/.codex`, их переустановка бота не трогает.

```bash
bash scripts/install-service.sh --uninstall
cd ~ && rm -rf ~/codex-telegram-bot          # .env удалится: сохрани токен заранее
git clone https://github.com/artemmarketolog/codex-telegram-bot.git ~/codex-telegram-bot
```

Дальше по [INSTALL.md](../INSTALL.md). База бота (`~/.codex-telegram`) хранит привязку тем к чатам; если удалить и её, старые темы в Telegram перестанут быть связаны с чатами, но сами чаты откроются через `/chats`.

## Обновление бота

```bash
cd ~/codex-telegram-bot
git pull
npm install
npm test
systemctl --user restart codex-telegram      # macOS: launchctl kickstart -k gui/$(id -u)/local.codex-telegram
```
