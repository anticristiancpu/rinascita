# Rinascita

Dashboard per seguire una trasformazione fisica: peso, composizione corporea,
fasi del programma e traguardi. Una pagina sola, nessuna dipendenza, i dati
restano su un server tuo.

Nasce da un foglio di calcolo e legge direttamente gli export `.xls` delle
bilance impedenziometriche (testata con INSMART Health).

---

## Cosa fa

**Dashboard** — peso attuale, chili persi, BMI, distanza dall'obiettivo, fase
in corso, grafico del peso con la traiettoria prevista e media mobile, grafico
della composizione corporea con 14 metriche selezionabili, statistiche
(media settimanale, ritmo giornaliero, data stimata di arrivo, anticipo o
ritardo sulla traiettoria).

**Registro** — storico completo con la variazione di ogni metrica rispetto
alla rilevazione precedente, dettaglio giorno per giorno, inserimento manuale
e riepilogo settimanale.

**Fasi** — le tappe del programma con date, obiettivo di peso e avanzamento.

**Traguardi** — costruiti automaticamente dal peso di partenza: i `-5 kg`,
`-10 kg`…, le soglie BMI (obesità, sovrappeso, normopeso) calcolate
sull'altezza, e le soglie tonde (sotto i 100, sotto i 90…).

**Import dalla bilancia** — carichi l'export `.xls` e scegli quali singole
pesate importare. Il parser BIFF8 è scritto in JavaScript puro: nessuna
libreria, funziona anche offline.

---

## Metriche lette dalla bilancia

Peso, BMI, grasso corporeo, massa grassa, massa muscolare, acqua corporea,
grasso viscerale, grasso sottocutaneo, muscolo scheletrico, proteine,
massa magra, massa ossea, metabolismo basale, rapporto muscolare,
età del corpo, tipo di corpo.

---

## Installazione su Proxmox (container LXC)

### 1. Crea il container — sul nodo Proxmox

Prima guarda cosa hai a disposizione: il nome dello storage cambia da
installazione a installazione (`local-lvm` con LVM-thin, `local-zfs` su ZFS,
`local` se usi una directory).

```bash
# storage che possono ospitare il disco di un container
pvesm status --content rootdir

# template gia' scaricati
pveam list local | grep debian
```

Se il template Debian 12 non c'e':

```bash
pveam update
pveam available --section system | grep debian-12
pveam download local debian-12-standard_12.12-1_amd64.tar.zst
```

Poi crea il container, sostituendo `STORAGE` e il nome del template con i tuoi:

```bash
STORAGE=local-lvm

pct create 120 local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname rinascita \
  --cores 1 --memory 512 --swap 512 \
  --rootfs ${STORAGE}:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --onboot 1

pct start 120
```

Sostituisci `120` con un ID libero. Se preferisci lasciar scegliere il primo
storage adatto: `STORAGE=$(pvesm status --content rootdir | awk 'NR==2{print $1}')`.

### 2. Installa l'app — dentro il container

```bash
pct enter 120

apt-get update && apt-get install -y git
git clone https://github.com/anticristiancpu/rinascita /opt/rinascita-src
bash /opt/rinascita-src/deploy/install.sh
```

Lo script installa Python 3 se manca, crea l'utente di sistema `rinascita`,
copia l'app in `/opt/rinascita`, prepara `/var/lib/rinascita` per i dati e
avvia il servizio systemd.

Alla fine ti stampa l'indirizzo, del tipo `http://192.168.1.42:8765`.

### 3. Aggiornamenti

```bash
cd /opt/rinascita-src && git pull && bash deploy/install.sh
```

Rieseguire l'installer è sicuro: aggiorna i file e riavvia il servizio,
**non tocca mai i dati**.

---

## Dove finiscono i dati

| Cosa | Dove |
|---|---|
| Rilevazioni e parametri | `/var/lib/rinascita/dati.json` |
| Copie giornaliere | `/var/lib/rinascita/backup/` (ultime 30) |

Ogni modifica viene scritta subito, in modo atomico (file temporaneo + rename),
così un'interruzione non può corrompere lo storico. Prima della prima scrittura
di ogni giornata viene messa da parte una copia.

Il browser tiene comunque una copia locale come rete di sicurezza, ma **il file
sul server è la fonte di verità**: all'avvio l'app legge da lì.

### Backup

`dati.json` è un JSON leggibile: copialo e sei a posto.

```bash
# dal tuo PC
scp root@192.168.1.42:/var/lib/rinascita/dati.json ~/rinascita-backup.json
```

Dall'app, in Impostazioni, ci sono anche **Esporta JSON** e **Esporta CSV**.

---

## Comandi utili

```bash
systemctl status rinascita     # stato
journalctl -u rinascita -f     # log in tempo reale
systemctl restart rinascita    # riavvio
```

---

## Configurazione

Si imposta tutto da variabili d'ambiente, nel file
`/etc/systemd/system/rinascita.service`:

| Variabile | Default | A cosa serve |
|---|---|---|
| `RINASCITA_HOST` | `127.0.0.1` | Indirizzo di ascolto (`0.0.0.0` per la LAN) |
| `RINASCITA_PORT` | `8765` | Porta |
| `RINASCITA_DATA` | cartella dell'app | Dove tenere `dati.json` e i backup |
| `RINASCITA_BACKUP` | `30` | Copie giornaliere da conservare (`0` disattiva) |
| `RINASCITA_BROWSER` | automatico | `1` apre il browser all'avvio, `0` mai |

Dopo una modifica: `systemctl daemon-reload && systemctl restart rinascita`.

---

## Uso in locale, senza server

Su Windows, doppio clic su `Avvia.bat`. Su Linux o macOS:

```bash
python3 server.py
```

Ascolta solo su `127.0.0.1` e apre il browser da solo. I dati finiscono in
`dati.json` accanto all'app.

Aprendo `index.html` con un doppio clic l'app funziona lo stesso, ma i dati
restano nel browser e non vengono scritti su file: l'indicatore in alto a
destra te lo dice.

---

## Sicurezza

**L'app non ha autenticazione.** Chiunque raggiunga la porta può leggere e
modificare i dati. Va bene su una LAN domestica; non esporla su Internet così
com'è. Se ti serve, mettici davanti un reverse proxy con autenticazione
(Caddy, nginx, Authelia) o raggiungila via VPN o Tailscale.

Il servizio systemd gira come utente non privilegiato, con `ProtectSystem=strict`,
e può scrivere soltanto nella cartella dei dati.

---

## Struttura

```
index.html            l'applicazione (HTML, CSS e JS in un file solo)
xls.js                lettore .xls BIFF8/OLE2 in JavaScript puro
server.py             server e persistenza (solo libreria standard)
Avvia.bat             avvio con doppio clic su Windows
deploy/install.sh     installazione come servizio systemd
deploy/rinascita.service
```

Nessun build, nessun `npm install`, nessun database.
