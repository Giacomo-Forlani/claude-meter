# Claude Meter — GNOME Shell extension

Monitors Claude usage from the GNOME top bar. Full spec: `plan.md` (Italian).

## Stack
- GNOME Shell 50 (Fedora 44, Wayland), GJS 1.88, **ES modules only** (`import ... from 'gi://Gio'`, `resource:///org/gnome/shell/...`). No `imports.*` legacy syntax.
- UUID: `claude-meter@grillofra`. GSettings schema id: `org.gnome.shell.extensions.claude-meter`.
- No external dependencies. No GTK in shell-side code (only `prefs.js` may use Gtk4/Adw).
- UI strings in **Italian**, hardcoded (no gettext in v1).

## Hard rules
- Never block the shell: all file and network I/O must be async (`Gio._promisify` + `*_async` methods, Soup 3 `send_and_read_async`). No `GLib.file_get_contents`, no sync `load_contents`, no `spawn_sync`.
- Never log tokens, credentials, prompts or message content. `console.debug` of counts/errors only.
- Never invent numbers: if data is missing, return/show `null` and let the UI show "—".
- Cache tokens (`cache_creation_input_tokens`, `cache_read_input_tokens`) are NOT input tokens.
- Each module only touches its own files (see "File ownership").

## File ownership
| File | Owner |
|---|---|
| `metadata.json`, `extension.js`, `icons/`, `AGENTS.md` | orchestrator |
| `lib/indicator.js`, `lib/format.js`, `styles/*.css` | UI |
| `lib/tokenParser.js`, `tests/test-parser.js` | Token Parser |
| `lib/usageManager.js`, `tests/test-usage.js` | Usage Manager |
| `lib/dataManager.js`, `schemas/org.gnome.shell.extensions.claude-meter.gschema.xml`, `prefs.js`, `tests/test-data.js`, `lib/sessionStore.js`, `tests/test-sessions.js` | Data/Settings |

## Interface contracts (do not change signatures)

### lib/tokenParser.js
```js
export class TokenParser {
    constructor(projectsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']))
    // state = { files: { [absPath]: { offset: number, size: number } }, seen: { [key]: 'YYYY-MM-DD' } }
    // state is owned/persisted by DataManager; scan() mutates it in place.
    async scan(state, cancellable = null) // -> Promise<Record[]>, only NEW records since last scan
}
// Record = { key: string, timestamp: number /*ms epoch*/, sessionId: string|null,
//            input: number, output: number, cacheCreation: number, cacheRead: number }
```
Raw JSONL facts: one JSON object per line. Usage records have `message.usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; also top-level `timestamp` (ISO), `requestId`, `sessionId`, and `message.id`. The SAME (message.id, requestId) appears on several lines with identical usage → count once, key = `${message.id}:${requestId}`. Files live in `projects/<project>/*.jsonl` and `projects/<project>/<session>/subagents/*.jsonl` (scan recursively).

### lib/usageManager.js
```js
export class UsageError extends Error { constructor(code, message) } // .code
// codes: 'no-credentials' | 'expired' | 'unauthorized' | 'rate-limited' | 'network' | 'invalid-response'
export class UsageManager {
    constructor(credentialsPath = ~/.claude/.credentials.json)
    async fetch(cancellable = null) // -> Promise<PlanUsage>, throws UsageError
    destroy()
}
// PlanUsage = {
//   fiveHour: { percent: number, resetsAt: Date|null } | null,
//   sevenDay: { percent: number, resetsAt: Date|null } | null,
//   scoped:   [{ label: string, percent: number, resetsAt: Date|null }],  // e.g. per-model weekly limits
//   fetchedAt: Date }
```

### lib/dataManager.js
```js
export class DataManager {
    constructor(statePath = GLib.get_user_data_dir()/claude-meter/state.json)
    async load()                 // missing/corrupt file -> fresh empty state, never throws
    get parserState()            // -> { files, seen } object passed to TokenParser.scan
    addRecords(records)          // aggregate by LOCAL day 'YYYY-MM-DD' from record.timestamp
    prune(now = new Date())      // drop days and seen entries older than 30 days
    async save()                 // atomic write, file mode 0600, dir created if missing
    getToday()                   // -> { input, output, total }
    getHistory(days = 30)        // -> [{ date: 'YYYY-MM-DD', input, output, total }], newest first, zero-filled
    getPlan()                    // -> { usage: PlanUsage|null, backoffUntil: ms, rateLimitHits }  (persisted)
    setPlan({usage?, backoffUntil?, rateLimitHits?})  // usage null/absent = unchanged
}
```

### lib/sessionStore.js
```js
export class SessionStore {
    constructor(claudeDir = ~/.claude, procDir = '/proc')   // procDir is injectable for tests
    async list(cancellable = null)            // -> Promise<Session[]>, most recently used first
    async getDeletionTargets(session, cancellable = null) // -> Promise<Target[]>, only existing paths
    async trash(session, cancellable = null)  // -> Promise<{ trashed: string[], failed: [{path, message}] }>
                                              // throws Error with .code === 'active' (nothing trashed)
    async _trashPath(path, cancellable)       // the only call to Gio trash_async; tests override it
}
// Session = { sessionId: string, title: string|null, projectPath: string|null,
//             projectDir: string, file: string,
//             createdAt: Date|null, lastUsedAt: Date|null, active: boolean }
// Target  = { path: string, kind: 'conversation' | 'session-dir' | 'file-history'
//                               | 'session-env' | 'todos' | 'project-dir' }
```
Pure module (Gio/GLib only). A conversation is a first-level `projects/<project>/<sessionId>.jsonl`. Title = last `custom-title`/`ai-title` record, else first real user message (slash-command wrappers skipped), else `null`. Active = `sessionId` listed in `~/.claude/sessions/<pid>.json` with a live `/proc/<pid>`, or file modified in the last 5 minutes. Linked data: `projects/<project>/<sessionId>/`, `file-history/<sessionId>/`, `session-env/<sessionId>/`, `todos/<sessionId>*`. When the project directory would be left empty or with only `memory/`, the single `project-dir` target replaces `conversation` and `session-dir`. Deletion is always a move to the system trash; `history.jsonl`, `shell-snapshots/`, `paste-cache/`, `telemetry/`, `jobs/`, `daemon/` are never touched. Tests must never call the real `trash_async`.

### lib/indicator.js
```js
export const ClaudeMeterIndicator = GObject.registerClass({
    Signals: { 'refresh-requested': {} },
}, class ClaudeMeterIndicator extends PanelMenu.Button {
    _init(extension)    // extension: Extension instance (extension.path, extension.getSettings())
    setPlanUsage(usage /*PlanUsage|null*/, error /*string|null*/)   // keeps last value if usage null
    setTokens(today /*{input,output,total}|null*/, error /*string|null*/)
    setHistory(history /*getHistory() result*/)
    setPlanRetryAt(date /*Date|null*/)  // next plan attempt after a 429
    destroy()
});
// Emits 'refresh-requested' when the menu is opened (no manual refresh button).
// Menu = two PopupMenuSection "pages": main (plan + age) and details (tokens, 7-day chart, prefs);
// NavItem overrides activate() so switching page does not close the menu.
// Only the 5-hour and 7-day bars are drawn: PlanUsage.scoped stays in the data contract but is not shown.
// Main page item "Gestisci conversazioni": sets `prefs-start-page` to 'sessions', then opens the
// preferences (or raises the window if already open: openPreferences() fails in that case).
```

### Settings keys (gschema)
- `refresh-interval` (u, default 60, range 30..3600) seconds
- `warn-threshold` (i, default 70, 1..100) percent → yellow
- `critical-threshold` (i, default 90, 1..100) percent → red
- `plan-refresh-interval` (u, default 300, range 60..3600) seconds — Anthropic usage endpoint (rate-limited)
- `bar-color-mode` (s, 'accent' | 'traffic', default 'accent')
- `prefs-start-page` (s, 'general' | 'sessions', default 'general') — one-shot: page to show when the preferences open; `prefs.js` consumes it and resets it to 'general' (also while the window is already open)

## Verification
- Pure modules (parser, usage, data, sessions) can be run outside the shell: `gjs -m tests/test-<name>.js`.
- Shell-only modules (`lib/indicator.js`, `extension.js`) cannot be imported outside GNOME Shell: test them with `dev/nested.sh` (headless isolated shell: start / eval / shot / log / stop). `lib/format.js` must stay pure (no shell imports) so it can be tested with gjs.
- Tests must use temp dirs/fixtures (`GLib.dir_make_tmp`), never write into `~/.claude` or `~/.local/share/claude-meter`. Test files print `PASS`/`FAIL` lines and exit non-zero on failure.
- Schema: `glib-compile-schemas --strict --dry-run schemas/`.

## GNOME 50 gotchas (verified in nested shell)
- `St.BoxLayout` has no `spacing` property → use CSS `spacing: 8px`. Use `orientation: Clutter.Orientation.VERTICAL`, not `vertical: true`.
- CSS `opacity` on containers is unreliable → set `actor.opacity` from code.
- Theme variants: GNOME Shell loads `stylesheet-dark.css` / `stylesheet-light.css` and reloads on color-scheme change. They are generated by `build.sh` from `styles/` (never edit the generated files). System accent color in CSS: `-st-accent-color`.
- Custom CSS properties can be read from code with `themeNode.lookup_color('-name', false)` (used by the chart `St.DrawingArea`).
- Soup 3: use `message.status_code`, NOT `get_status()` — it throws for codes missing from the `Soup.Status` enum (e.g. 429).
- The usage endpoint returns 429 when polled too often: plan polling is separate (5 min default, 3 min staleness on menu open) with exponential back-off honouring `Retry-After`.
