#!/usr/bin/env bash
# Установка сервера «Зошита» (сервіс пушів доручень) на Ubuntu.
# Запуск: curl -fsSL https://pax-core.github.io/zoshyt/setup.sh | bash
# Скрипт можна запускати повторно — він продовжить з того місця, де зупинився.
set -e
SRC="https://pax-core.github.io/zoshyt/push"
BASE=/opt/zoshyt

[ "$(id -u)" = 0 ] || { echo "Запустіть від root (sudo -i)"; exit 1; }
mkdir -p $BASE
echo "▶ Зошит: налаштування сервера"

# 1 ГБ swap для малого дроплета
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  swap 1 ГБ — додано"
fi

# Node.js 20 і git
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "  встановлюю Node.js 20…"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl git gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v)"

# Ключ Firebase (сервісний акаунт)
if [ ! -s $BASE/sa.json ]; then
  echo
  echo "════════ КРОК 2 з 2 ════════"
  echo "Вставте ВЕСЬ вміст JSON-ключа Firebase (Project settings → Service accounts → Generate new private key),"
  echo "потім натисніть Enter і Ctrl+D:"
  cat > $BASE/sa.json < /dev/tty
fi
if ! node -e "const j=JSON.parse(require('fs').readFileSync('$BASE/sa.json','utf8')); if(j.project_id!=='zoshyt-4daeb') throw new Error('інший проєкт: '+j.project_id)" 2>/tmp/zoshyt-sa.err; then
  echo "  ✗ Ключ не підходить: $(cat /tmp/zoshyt-sa.err | tail -1). Запустіть команду ще раз і вставте правильний файл."
  rm -f $BASE/sa.json
  exit 1
fi
echo "  ключ Firebase — є"

# Код сервісу (публічний, без секретів)
mkdir -p $BASE/app/server/push
for f in index.js package.json; do curl -fsSL "$SRC/$f" -o "$BASE/app/server/push/$f"; done
id zoshyt >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin zoshyt
chown zoshyt $BASE/sa.json && chmod 600 $BASE/sa.json
mkdir -p $BASE/home && chown -R zoshyt $BASE/app $BASE/home
# залежності ставимо від імені сервісного користувача і без install-скриптів пакетів (не від root)
(cd $BASE/app/server/push && HOME=$BASE/home runuser -u zoshyt -- npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
echo "  код — оновлено"

cat > /etc/systemd/system/zoshyt-push.service <<'UNIT'
[Unit]
Description=Zoshyt — пуші доручень
After=network-online.target
Wants=network-online.target

[Service]
User=zoshyt
Environment=SA_PATH=/opt/zoshyt/sa.json
WorkingDirectory=/opt/zoshyt/app/server/push
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
MemoryMax=300M
# обмеження: сервіс не може змінювати систему чи отримати більше прав
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/opt/zoshyt/app/server/push
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT

cat > $BASE/update.sh <<'UPD'
#!/usr/bin/env bash
# Перевіряє оновлення коду на pax-core.github.io і перезапускає сервіс, якщо щось змінилось.
D=/opt/zoshyt/app/server/push
T=$(mktemp -d)
for f in index.js package.json; do curl -fsSL --proto '=https' "https://pax-core.github.io/zoshyt/push/$f" -o "$T/$f" || exit 0; done
node --check "$T/index.js" || exit 0
if ! cmp -s "$T/index.js" "$D/index.js" || ! cmp -s "$T/package.json" "$D/package.json"; then
  install -o zoshyt -m 644 "$T/index.js" "$T/package.json" "$D/"
  # не від root і без install-скриптів пакетів
  (cd "$D" && HOME=/opt/zoshyt/home runuser -u zoshyt -- npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
  systemctl restart zoshyt-push
  echo "оновлено"
fi
rm -rf "$T"
UPD
chmod +x $BASE/update.sh

cat > /etc/systemd/system/zoshyt-update.service <<'UNIT'
[Unit]
Description=Zoshyt — автооновлення з репозиторію
[Service]
Type=oneshot
ExecStart=/opt/zoshyt/update.sh
UNIT

cat > /etc/systemd/system/zoshyt-update.timer <<'UNIT'
[Unit]
Description=Zoshyt — перевірка оновлень кожні 5 хв
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable -q --now zoshyt-update.timer
systemctl enable -q zoshyt-push
systemctl restart zoshyt-push
sleep 6
echo
echo "════════ ГОТОВО ════════"
systemctl is-active zoshyt-push >/dev/null && echo "  ✓ сервіс пушів працює" || echo "  ✗ сервіс не запустився"
journalctl -u zoshyt-push -n 5 --no-pager -o cat
echo
echo "Журнал: journalctl -u zoshyt-push -f"
