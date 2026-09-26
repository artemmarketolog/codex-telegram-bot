#!/usr/bin/env bash
# Autostart for the bot and the Codex daemon.
#   Linux: systemd user services (survive logout and reboot via linger).
#   macOS: launchd agents (run while you are logged in and the Mac is awake).
# Usage: bash scripts/install-service.sh [--uninstall]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
CODEX="${CODEX_BIN:-$(command -v codex || true)}"
NAME="codex-telegram"

if [[ "${1:-}" != "--uninstall" ]]; then
  [[ -n "$NODE" ]] || { echo "Не найден node. Установи Node.js 22.13+." >&2; exit 1; }
  [[ -n "$CODEX" ]] || { echo "Не найден codex. Установи: npm install -g @openai/codex" >&2; exit 1; }
  [[ -f "$ROOT/.env" ]] || { echo "Нет $ROOT/.env — сначала заполни его (cp .env.example .env)." >&2; exit 1; }
  chmod 600 "$ROOT/.env"
fi
# Services do not read your shell profile: keep the PATH of this shell so the daemon's
# commands find the same node, codex, git and other tools as in the terminal.
SERVICE_PATH="$(dirname "$NODE"):$(dirname "$CODEX"):${PATH}"

case "$(uname -s)" in
Linux)
  UNIT_DIR="$HOME/.config/systemd/user"
  # Linger starts the user's service manager at boot and keeps it without an open SSH session.
  if [[ "${1:-}" != "--uninstall" && "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != "yes" ]]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || sudo loginctl enable-linger "$(id -un)" \
      || echo "⚠️  Выполни вручную: sudo loginctl enable-linger $(id -un) — иначе бот остановится после выхода из SSH."
    sleep 2
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl --user disable --now "$NAME.service" codex-daemon-ensure.timer 2>/dev/null || true
    rm -f "$UNIT_DIR/$NAME.service" "$UNIT_DIR/codex-daemon-ensure.service" "$UNIT_DIR/codex-daemon-ensure.timer"
    systemctl --user daemon-reload
    echo "Автозапуск удалён. Codex daemon продолжает работать; остановить: codex app-server daemon stop"
    exit 0
  fi
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/codex-daemon-ensure.service" <<EOF
[Unit]
Description=Start the Codex app-server daemon if it is not running

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment="PATH=$SERVICE_PATH"
Environment="CODEX_BIN=$CODEX"
ExecStart="$NODE" "$ROOT/scripts/ensure-codex-daemon.mjs"
TimeoutStartSec=100
# The daemon started here must keep running after this check ends.
KillMode=process
LogLevelMax=notice
EOF
  cat > "$UNIT_DIR/codex-daemon-ensure.timer" <<EOF
[Unit]
Description=Keep the Codex app-server daemon available

[Timer]
OnBootSec=15s
OnUnitInactiveSec=30s
AccuracySec=5s
Unit=codex-daemon-ensure.service

[Install]
WantedBy=timers.target
EOF
  cat > "$UNIT_DIR/$NAME.service" <<EOF
[Unit]
Description=Codex Telegram bot
Wants=network-online.target codex-daemon-ensure.service codex-daemon-ensure.timer telegram-bot-api.service
After=network-online.target codex-daemon-ensure.service telegram-bot-api.service

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment="PATH=$SERVICE_PATH"
Environment=NODE_NO_WARNINGS=1
ExecStart="$NODE" "--env-file=$ROOT/.env" "$ROOT/app.mjs"
Restart=always
RestartSec=10
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now codex-daemon-ensure.timer
  systemctl --user start codex-daemon-ensure.service
  systemctl --user enable "$NAME.service"
  systemctl --user restart "$NAME.service"
  sleep 5
  systemctl --user --no-pager --lines=0 status "$NAME.service" || true
  echo
  echo "Готово. Логи: journalctl --user -u $NAME -f"
  ;;
Darwin)
  AGENTS="$HOME/Library/LaunchAgents"
  LOGS="$HOME/Library/Logs/$NAME"
  BOT_PLIST="$AGENTS/local.$NAME.plist"
  DAEMON_PLIST="$AGENTS/local.codex-daemon-ensure.plist"
  if [[ "${1:-}" == "--uninstall" ]]; then
    launchctl bootout "gui/$(id -u)" "$BOT_PLIST" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)" "$DAEMON_PLIST" 2>/dev/null || true
    rm -f "$BOT_PLIST" "$DAEMON_PLIST"
    echo "Автозапуск удалён."
    exit 0
  fi
  mkdir -p "$AGENTS" "$LOGS"
  cat > "$DAEMON_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.codex-daemon-ensure</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/scripts/ensure-codex-daemon.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$SERVICE_PATH</string><key>CODEX_BIN</key><string>$CODEX</string></dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>30</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardErrorPath</key><string>$LOGS/daemon-ensure.log</string>
</dict></plist>
EOF
  cat > "$BOT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.$NAME</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--env-file=$ROOT/.env</string><string>$ROOT/app.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$SERVICE_PATH</string><key>NODE_NO_WARNINGS</key><string>1</string></dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/bot.log</string>
  <key>StandardErrorPath</key><string>$LOGS/bot.log</string>
</dict></plist>
EOF
  for plist in "$DAEMON_PLIST" "$BOT_PLIST"; do
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  done
  echo "Готово. Логи: tail -f $LOGS/bot.log"
  echo "Mac должен быть включён и не спать, пока нужен бот (Системные настройки → Аккумулятор/Энергосбережение)."
  ;;
*)
  echo "Поддерживаются Linux и macOS. На Windows ставь бота в WSL2 (Ubuntu) или на VPS." >&2
  exit 1
  ;;
esac
