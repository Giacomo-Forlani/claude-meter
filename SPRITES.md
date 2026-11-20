# Animazioni dei granchi (Clawd)

Ogni sessione aperta di Claude Code compare nella barra in alto come un Clawd in pixel art,
in una posizione fissa: la sessione più vecchia a sinistra, le nuove si aggiungono a destra,
poi gli anelli di utilizzo. Le animazioni nascono da **spritesheet PNG** in `clawd-animation/`
e vengono convertite in dati JS da uno script: a runtime non si legge nessuna immagine.
`clawd-animation/` è **solo per lo sviluppo** ed è in `.gitignore`: chi installa l'estensione usa
il `lib/sprites.js` già generato e versionato. Dopo aver cambiato gli sheet, rigenera e committa `lib/sprites.js`.

## Flusso

```
clawd-animation/*.png  +  clawd-animation/animations.json
        │  gjs -m tools/build-animations.js   (solo lo sviluppatore, a mano)
        ▼
lib/sprites.js   (GENERATO e versionato, non modificare a mano)
        │  compilato una volta al caricamento da lib/crabs.js
        ▼
lib/indicator.js disegna ogni pixel come un quadrato di PIXEL px (2) con cairo
```

`clawd-animation/generate.py` (Python + PIL) è il sorgente da cui sono nati gli sheet attuali:
si può usare per rigenerarli, oppure si possono disegnare gli PNG con qualsiasi editor.

## Spritesheet

- Una striscia orizzontale per animazione, frame affiancati da sinistra a destra.
- Frame **quadrati**: la larghezza del frame è l'altezza dello sheet (oggi 16×16).
  Per frame non quadrati aggiungi `frameWidth` all'animazione nel manifest.
- Tutti gli sheet devono avere la stessa altezza e la stessa larghezza di frame.
- Pixel con alpha 0 = trasparenti. Gli altri colori vengono usati così come sono
  (anche semitrasparenti), senza ricolorazione per sessione.
- Lo script ritaglia le righe/colonne vuote **in tutti i frame di tutte le animazioni**
  (oggi resta 16×15 → 32×30 px nella barra) e costruisce una palette unica (max 62 colori).

## Manifest `clawd-animation/animations.json`

```json
{
  "fps": 8,
  "animations": {
    "idle":       {"file": "idle.png",       "loop": true},
    "laptop_out": {"file": "laptop_out.png", "loop": false},
    "work_A":     {"file": "work_A.png",     "loop": true},
    "work_B":     {"file": "work_B.png",     "loop": true},
    "success":    {"file": "success.png",    "loop": true, "seconds": 2}
  },
  "states": {"sleep": "idle", "start": "laptop_out", "work": ["work_A", "work_B"], "done": "success"}
}
```

| Campo | Significato |
|---|---|
| `fps` | frame al secondo di tutte le animazioni |
| `file` | PNG dentro `clawd-animation/` |
| `loop` | `true` = gira in loop; `false` = eseguita una volta sola (tutti i frame) |
| `seconds` | solo con `loop: true`: dopo quanti secondi l'animazione finisce (usato per `done`) |
| `frameWidth` | facoltativo, larghezza di un frame (default: altezza dello sheet) |

`states` collega le animazioni agli stati della sessione:

| Stato | Quando |
|---|---|
| `sleep` | sessione aperta ma ferma (loop) |
| `start` | passaggio ferma → al lavoro: eseguita una volta, poi `work` |
| `work` | sessione al lavoro (loop). Lista: ogni sessione ne sceglie una a caso alla creazione e la tiene |
| `done` | passaggio al lavoro → ferma: per `seconds`, poi `sleep` |

Senza sessioni aperte (o con i granchi su off), con la preferenza "Senza sessioni aperte" =
"Granchio che dorme" (`panel-empty` = `crab`), resta un granchio in `sleep` accanto ai cerchi:
alla prima sessione aperta diventa il suo granchio (se è già al lavoro fa `start` e poi `work`),
e quando si chiude l'ultima il granchio rimasto torna a fare da segnaposto (`done` e poi `sleep`
se stava lavorando).

Le transizioni (`start`, `done`) arrivano sempre alla fine; alla fine si guarda lo stato attuale
(es. se la sessione è già tornata ferma durante `start`, segue `done`). Un granchio di una sessione
appena comparsa (o all'avvio dell'estensione) parte direttamente da `sleep` o `work`.

## Operazioni

- **Modificare** un'animazione: modifica il PNG (o `generate.py` e rilancialo), poi rigenera.
- **Aggiungere** un'animazione di lavoro: nuovo PNG, nuova voce in `animations`, aggiungi il nome
  a `states.work`.
- **Sostituire** un'animazione di stato: cambia il nome in `states`.
- **Cambiare dimensione**: sheet più grandi/piccoli; griglia e spazio per granchio nella barra si
  adattano. Aggiorna il test della griglia in `tests/test-crabs.js` e verifica che la barra non si
  allarghi (la griglia ritagliata × `PIXEL` deve stare nell'altezza del pannello).

## Verificare e applicare

```bash
gjs -m tools/build-animations.js   # rigenera lib/sprites.js (errori di formato -> exit 1)
gjs -m tests/test-crabs.js         # compila gli sprite e prova la macchina a stati
dev/nested.sh start                # shell GNOME isolata con l'estensione
dev/nested.sh shot crabs 1000 0 280 32   # screenshot della barra in .dev/crabs.png
dev/nested.sh stop
./install.sh                       # poi, su Wayland, esci e rientra nella sessione
```
