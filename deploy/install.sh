#!/usr/bin/env bash
#
# Installa (o aggiorna) Rinascita come servizio systemd.
# Pensato per un container LXC Debian/Ubuntu su Proxmox, ma funziona
# su qualunque sistema con systemd e Python 3.
#
#   sudo ./deploy/install.sh
#
# Rieseguibile quante volte vuoi: aggiorna i file e riavvia il servizio,
# senza mai toccare i dati.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rinascita}"
DATA_DIR="${DATA_DIR:-/var/lib/rinascita}"
SVC_USER="${SVC_USER:-rinascita}"
PORT="${PORT:-8765}"
HOST="${HOST:-0.0.0.0}"

SORGENTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rosso()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()   { printf '  %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  rosso "Serve root: riprova con  sudo $0"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  rosso "systemd non trovato: questo script serve per sistemi con systemd."
  exit 1
fi

echo
verde "Rinascita - installazione"
info "sorgente ....... $SORGENTE"
info "applicazione ... $APP_DIR"
info "dati ........... $DATA_DIR"
info "servizio ....... $SVC_USER, porta $PORT"
echo

# --- Python 3 ---------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  info "Installo python3..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq python3
  else
    rosso "python3 non trovato e non so installarlo su questo sistema."
    exit 1
  fi
fi
info "python3 $(python3 -c 'import platform;print(platform.python_version())')"

# --- utente di servizio -----------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  info "creato utente di sistema $SVC_USER"
fi

# --- file dell'applicazione -------------------------------------------------
install -d -m 755 "$APP_DIR"
for f in index.html xls.js server.py; do
  if [[ ! -f "$SORGENTE/$f" ]]; then
    rosso "File mancante nella sorgente: $f"
    exit 1
  fi
  install -m 644 "$SORGENTE/$f" "$APP_DIR/$f"
done
chmod 644 "$APP_DIR/server.py"
info "file copiati in $APP_DIR"

# --- cartella dati (mai sovrascritta) ---------------------------------------
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
if [[ -f "$DATA_DIR/dati.json" ]]; then
  n=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf-8')).get('mis',[])))" "$DATA_DIR/dati.json" 2>/dev/null || echo "?")
  info "dati esistenti conservati ($n rilevazioni)"
else
  info "nessun dato presente: verra' creato al primo salvataggio"
fi

# --- servizio ---------------------------------------------------------------
sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
    -e "s#^ExecStart=.*#ExecStart=/usr/bin/python3 -u $APP_DIR/server.py#" \
    -e "s#^User=.*#User=$SVC_USER#" \
    -e "s#^Group=.*#Group=$SVC_USER#" \
    -e "s#^Environment=RINASCITA_HOST=.*#Environment=RINASCITA_HOST=$HOST#" \
    -e "s#^Environment=RINASCITA_PORT=.*#Environment=RINASCITA_PORT=$PORT#" \
    -e "s#^Environment=RINASCITA_DATA=.*#Environment=RINASCITA_DATA=$DATA_DIR#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=$DATA_DIR#" \
    "$SORGENTE/deploy/rinascita.service" > /etc/systemd/system/rinascita.service

systemctl daemon-reload
systemctl enable --quiet rinascita
systemctl restart rinascita
sleep 1

echo
if systemctl is-active --quiet rinascita; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  verde "Fatto. Rinascita e' attiva."
  echo
  info "App ......... http://${IP:-<ip-del-container>}:$PORT"
  info "Dati ........ $DATA_DIR/dati.json"
  info "Backup ...... $DATA_DIR/backup/"
  echo
  info "stato:   systemctl status rinascita"
  info "log:     journalctl -u rinascita -f"
  info "riavvio: systemctl restart rinascita"
  echo
else
  rosso "Il servizio non e' partito. Guarda il log:"
  info "journalctl -u rinascita -n 40 --no-pager"
  exit 1
fi
