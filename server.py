#!/usr/bin/env python3
"""
Rinascita - server dell'app di monitoraggio della trasformazione fisica.

Serve la webapp e conserva i dati in un file JSON sul server.
Nessuna dipendenza esterna: solo la libreria standard di Python 3.

  Uso locale:      python server.py
  Come servizio:   vedi deploy/install.sh (systemd)

Configurazione tramite variabili d'ambiente:
  RINASCITA_HOST      indirizzo di ascolto        (default 127.0.0.1)
  RINASCITA_PORT      porta                       (default 8765)
  RINASCITA_DATA      cartella dei dati           (default: cartella dell'app)
  RINASCITA_BACKUP    copie giornaliere da tenere (default 30, 0 = disattiva)
  RINASCITA_BROWSER   1 per aprire il browser     (default: solo se host locale)
"""

import json
import os
import shutil
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.environ.get("RINASCITA_DATA") or APP_DIR)
DATI = os.path.join(DATA_DIR, "dati.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")

HOST = os.environ.get("RINASCITA_HOST", "127.0.0.1")
PORT = int(os.environ.get("RINASCITA_PORT", "8765"))
DA_TENERE = int(os.environ.get("RINASCITA_BACKUP", "30"))

# file statici serviti: tutto il resto e' 404
STATICI = {"/", "/index.html", "/xls.js", "/favicon.ico"}


def log(msg):
    print("%s  %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def leggi():
    if not os.path.exists(DATI):
        return None
    try:
        with open(DATI, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log("! dati.json illeggibile: %s" % e)
        return None


def scrivi(dati):
    """Scrittura atomica: prima su file temporaneo, poi rename."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DATI + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dati, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATI)


def backup_giornaliero():
    """Una copia al giorno di dati.json, tenendo le ultime RINASCITA_BACKUP."""
    if DA_TENERE <= 0 or not os.path.exists(DATI):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, "dati-%s.json" % datetime.now().strftime("%Y-%m-%d"))
    if not os.path.exists(dest):
        shutil.copy2(DATI, dest)
    copie = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("dati-"))
    for vecchia in copie[:-DA_TENERE]:
        os.remove(os.path.join(BACKUP_DIR, vecchia))


class Handler(SimpleHTTPRequestHandler):
    server_version = "Rinascita"
    sys_version = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP_DIR, **kw)

    # ---------- risposte ----------

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- rotte ----------

    def do_GET(self):
        if self.path == "/api/ping":
            return self._json({"ok": True, "file": DATI})
        if self.path == "/api/salute":
            d = leggi() or {}
            return self._json({"ok": True, "rilevazioni": len(d.get("mis", [])),
                               "file": DATI, "esiste": os.path.exists(DATI)})
        if self.path == "/api/dati":
            dati = leggi()
            return self._json({"ok": True, "dati": dati, "esiste": dati is not None})
        if self.path.split("?")[0] not in STATICI:
            return self.send_error(404, "Not found")
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/dati":
            return self._json({"ok": False, "errore": "endpoint sconosciuto"}, 404)
        try:
            lung = int(self.headers.get("Content-Length", 0))
            if lung <= 0 or lung > 20_000_000:
                raise ValueError("dimensione non valida")
            dati = json.loads(self.rfile.read(lung).decode("utf-8"))
            if not isinstance(dati, dict) or not isinstance(dati.get("mis"), list):
                raise ValueError("struttura non valida")
            backup_giornaliero()
            scrivi(dati)
            log("salvato: %d rilevazioni" % len(dati["mis"]))
            return self._json({"ok": True,
                               "salvatoIl": datetime.now().isoformat(timespec="seconds")})
        except Exception as e:
            log("! errore salvataggio: %s" % e)
            return self._json({"ok": False, "errore": str(e)}, 400)

    def end_headers(self):
        if self.path in ("/", "/index.html"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass  # stampiamo solo cio' che conta


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        log("Impossibile ascoltare su %s:%d - %s" % (HOST, PORT, e))
        log("Forse il server e' gia' avviato altrove.")
        return 1

    locale = HOST in ("127.0.0.1", "localhost", "::1")
    mostra = "127.0.0.1" if locale else (HOST if HOST != "0.0.0.0" else "<ip-del-server>")
    url = "http://%s:%d/" % (mostra, PORT)

    print()
    log("Rinascita in ascolto su %s:%d" % (HOST, PORT))
    log("App ....... %s" % url)
    log("Dati ...... %s" % DATI)
    log("Backup .... %s (ultimi %d giorni)" % (BACKUP_DIR, DA_TENERE) if DA_TENERE else "Backup .... disattivati")
    print()

    apri = os.environ.get("RINASCITA_BROWSER")
    if apri == "1" or (apri is None and locale):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("Chiuso. I dati restano in %s" % DATI)
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
