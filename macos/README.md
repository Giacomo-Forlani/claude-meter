# Claude Meter per macOS

App per la barra dei menu, compatibile con macOS 13 Ventura e successivi su Apple Silicon e Intel. Il menu mostra le percentuali delle finestre di cinque ore e sette giorni quando Claude Code le comunica, l’orario di reset e la data dell’ultimo aggiornamento. I token di input e output di oggi e il grafico degli ultimi sette giorni provengono dai registri locali.

## Installazione

1. Scarica `Claude-Meter-macOS.zip`, apri lo ZIP, trascina **Claude Meter.app** in **Applicazioni** e avviala. [Release](https://github.com/Giacomo-Forlani/claude-meter/releases/latest)
2. Il pacchetto usa una firma ad hoc e viene distribuito senza notarizzazione Apple. Se macOS blocca l’avvio e hai verificato la provenienza del download, apri **Impostazioni di Sistema → Privacy e sicurezza → Apri comunque** dopo il primo tentativo di apertura.
3. Clicca sull’indicatore nella barra dei menu e scegli **Collega Claude Code**. Il pulsante aggiunge il comando della riga di stato al file utente `~/.claude/settings.json`. Per una riga di stato già personalizzata, segui le istruzioni più sotto.
4. Avvia una nuova sessione di Claude Code autenticata con un abbonamento che espone i limiti e invia un messaggio. Le prime percentuali arrivano dopo una risposta. L’app controlla i dati ricevuti ogni dieci secondi. I token locali si aggiornano ogni minuto anche senza collegare la riga di stato.

Claude Code fornisce i limiti durante le sessioni attive. Una finestra scaduta appare come «—» fino al prossimo aggiornamento. L’app salva solo le percentuali, gli orari di reset e la data di lettura in `~/Library/Application Support/Claude Meter/usage.json`. Il conteggio locale esclude i token della cache, conta ogni richiesta una volta e include i registri delle sotto-sessioni. [Dati della riga di stato di Claude Code](https://code.claude.com/docs/en/statusline#available-data)

## Riga di stato personalizzata

Se hai già uno script Bash o Zsh per la riga di stato, aggiungi questa riga subito dopo lo shebang, prima che lo script legga lo standard input. Claude Meter riceverà una copia dei dati e lo script continuerà a produrre l’output che usi già.

```bash
exec < <(/usr/bin/tee >("/Applications/Claude Meter.app/Contents/MacOS/ClaudeMeter" --capture-only))
```

Per configurare manualmente la riga di stato standard, inserisci questa proprietà nel tuo oggetto JSON delle impostazioni utente. Il percorso presuppone che tu abbia spostato l’app in Applicazioni.

```json
{
  "statusLine": {
    "type": "command",
    "command": "'/Applications/Claude Meter.app/Contents/MacOS/ClaudeMeter' --capture"
  }
}
```

Per un profilo personalizzato, avvia l’eseguibile dell’app con la stessa variabile `CLAUDE_CONFIG_DIR` usata da Claude Code. Per disinstallare, rimuovi la proprietà `statusLine` aggiunta dall’app o la riga aggiunta al tuo script, scegli **Esci** e sposta l’app nel Cestino.

## Compilazione

Su un Mac con gli strumenti da riga di comando di Xcode e un SDK macOS 13 o successivo, esegui `bash macos/build.sh` dalla radice del repository. Il pacchetto universale e il relativo SHA-256 vengono scritti in `dist/macos/`. La verifica automatica compila ed esegue i test dei dati, controlla le architetture e la firma del pacchetto estratto e avvia l’app sul runner macOS.
