# Animazioni dei granchi

Ogni sessione aperta di Claude Code compare nella barra in alto come un granchio in pixel art.
Le animazioni sono **dati scritti a mano** in `lib/sprites.js`: per modificarle non serve toccare il codice.

## Come vengono lette

1. `lib/sprites.js` esporta un solo oggetto, `ANIMATIONS`: nome animazione → definizione.
2. `lib/crabs.js` lo importa e, al caricamento dell'estensione, lo **compila** una volta sola
   (`compileAnimations()`): ogni frame diventa tre liste di pixel `[colonna, riga]`
   (corpo, corpo scuro, occhi). Niente lettura di file a runtime.
3. Ad ogni tick (8 al secondo) `CrabFlock` sceglie per ogni granchio animazione e frame;
   `lib/indicator.js` disegna ogni pixel come un quadrato di `PIXEL` px (default 2),
   e ridisegna solo quando un granchio cambia frame o posizione.

Se i dati sono sbagliati (carattere sconosciuto, `idle` mancante, animazione senza frame)
(o un array `every` di lunghezza diversa dai frame)
la compilazione lancia un errore che dice animazione, frame e riga: l'estensione non parte,
quindi verifica sempre con il test (vedi sotto) prima di installare.

## Formato di un frame

Un frame è un array di stringhe, **una stringa per riga**, dall'alto verso il basso.
Ogni carattere è un pixel:

| Carattere | Significato |
|---|---|
| `B` | corpo, colore della sessione (tonalità di arancio, fissa per sessione) |
| `b` | corpo scuro: colore della sessione × `DARK_FACTOR` (0.7, in `lib/crabs.js`) |
| `E` | occhi, neri (`EYE_COLOR` in `lib/crabs.js`) |
| `.` o spazio | trasparente |

Qualsiasi altro carattere è un errore. Le maiuscole contano (`B` ≠ `b`).

### Griglia

- La griglia è **grande quanto il frame più grande** fra tutte le animazioni
  (larghezza = riga più lunga, altezza = frame con più righe). Oggi è 15×11:
  il granchio in piedi occupa le righe 2–10, le righe 0–1 sono spazio per salti e chele alzate,
  e la riga 10 è il "terreno" (le zampe appoggiate finiscono lì).
- I frame più piccoli vengono **allineati in basso e centrati** orizzontalmente.
- Le righe di uno stesso frame possono avere lunghezze diverse, ma conviene tenerle uguali e
  usare `.` per riempire: si vede meglio la forma.
- Un salto si disegna spostando il granchio verso l'alto dentro la griglia
  (vedi `dance` e `hop`); un granchio accucciato si sposta in basso con le zampe divaricate
  (vedi `idle` e `dig`).
- Più è grande la griglia, più è alto il granchio nella barra (`altezza × PIXEL` px) e più
  spazio orizzontale occupa: con griglie molto larghe ne entrano meno in `panel-max-width`.

## Campi di un'animazione

```js
nome: {
    frames: [[ /* frame 1 */ ], [ /* frame 2 */ ]],  // obbligatorio, almeno 1
    every: 1,          // tick per frame (8 tick = 1 s). 2 = ogni frame dura 1/4 s.
                       // Oppure un numero per frame: [14, 2] = 14 tick il primo, 2 il secondo
    weight: 1,         // probabilità relativa di essere scelta (anche decimale); 0 = mai
    move: false,       // true = il granchio si sposta di lato (1 px per tick) mentre la esegue
    flip: false,       // true = frame disegnati verso destra, specchiati quando va a sinistra
    seconds: [2, 5],   // durata (secondi, min/max casuale) di ogni esecuzione
},
```

Tutti i campi tranne `frames` sono facoltativi; i valori sopra sono i default.
I frame girano in loop finché dura l'animazione, poi il granchio ne sceglie un'altra
(può ripetere la stessa). Un `every` per frame serve per pose lunghe e scatti brevi,
per esempio occhi aperti a lungo e un battito di palpebre di 2 tick (vedi `pause`),
senza dover ripetere frame identici.

Con `flip: true` disegna il granchio rivolto a destra (occhi spostati a destra, zampe che
avanzano verso destra): quando cammina verso sinistra il frame viene specchiato. Il verso è
l'ultima direzione di marcia, quindi vale anche per animazioni senza `move` (vedi `wave`).

## Animazioni speciali e casuali

- **`idle` è obbligatoria**: è il granchio di una sessione che non sta lavorando
  (disegnato semitrasparente). Non viene mai scelta a caso, e `weight`, `move`, `seconds` sono ignorati.
  Con **un solo frame** è statica e non consuma nulla; con più frame il timer a 8 fps resta
  acceso anche quando nessuna sessione lavora (ma ridisegna solo al cambio frame).
- **Tutte le altre** sono comportamenti casuali dei granchi di sessioni al lavoro, estratti in
  base a `weight`. Il nome è libero (lettere, numeri, `_`).

Animazioni attuali:

| Nome | Cosa fa | Note |
|---|---|---|
| `idle` | accucciato, occhi chiusi, respira (2 frame da 1,5 s) | sessione ferma |
| `pause` | fermo: sbatte le palpebre, guarda a sinistra e a destra | `every` per frame |
| `walk` | cammina di lato, zampe a coppie alterne, chele che dondolano | peso 3, `move`, `flip` |
| `dance` | saltella alzando una chela alla volta | |
| `claws` | alza le chele e le apre/chiude | |
| `wave` | saluta con una chela | `flip`, peso 0.7 |
| `hop` | si accuccia, salta, atterra | peso 0.7 |
| `dig` | accucciato, spala con le chele a turno | peso 0.7 |

## Operazioni

**Modificare** un'animazione: cambia i caratteri dei suoi frame o i suoi campi.

**Aggiungere** un'animazione: aggiungi una nuova chiave in `ANIMATIONS`, per esempio

```js
stretch: {
    every: [6, 4],
    seconds: [1, 3],
    frames: [[
        '...............',
        '...............',
        '.b..BBBBBBB..b.',
        'b..BBBBBBBBB..b',
        'B..BBEBBBEBB..B',
        '.B.BBEBBBEBB.B.',
        '..BBBBBBBBBBB..',
        '...BBBBBBBBB...',
        '...bbbbbbbbb...',
        '....b.b.b.b....',
        '....b.b.b.b....',
    ], [
        '...............',
        '...............',
        '....BBBBBBB....',
        '...BBBBBBBBB...',
        '...BBEBBBEBB...',
        '...BBEBBBEBB...',
        'bBBBBBBBBBBBBBb',
        '...BBBBBBBBB...',
        '...bbbbbbbbb...',
        '....b.b.b.b....',
        '....b.b.b.b....',
    ]],
},
```

Entra subito fra i comportamenti casuali. Per renderla rara usa un `weight` basso (es. `0.3`).

**Eliminare** un'animazione: togli la sua chiave. Non si può eliminare `idle`. Per disattivarla
senza cancellarla metti `weight: 0`. Se restano solo `idle`, anche i granchi al lavoro
mostrano `idle`.

**Cambiare dimensione**: basta disegnare frame più grandi (o più piccoli); la griglia si adatta,
e con lei lo spazio per granchio nella barra (`CRAB_SLOT`, `CRAB_MIN_STEP` in `lib/crabs.js`).
Ricordati di aggiornare il test `griglia 15x11` in `tests/test-sessions.js`.

## Verificare e applicare

```bash
gjs -m tests/test-sessions.js      # compila gli sprite: errori di formato -> FAIL
dev/nested.sh start                # shell GNOME isolata con l'estensione
dev/nested.sh shot crabs 1000 0 280 32   # screenshot della barra in .dev/crabs.png
dev/nested.sh stop
./install.sh                       # poi, su Wayland, esci e rientra nella sessione
```

Il test controlla che ogni frame stia nella griglia, abbia occhi e corpo, che `idle` esista
e che gli array `every` abbiano un valore per frame.
Nella shell nested i granchi compaiono solo se hai sessioni di Claude Code aperte.
