import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SessionStore} from './lib/sessionStore.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// Replace the home directory prefix with '~' (only on a path boundary).
function tildify(path) {
    const home = GLib.get_home_dir();
    if (path === home)
        return '~';
    if (path.startsWith(`${home}/`))
        return `~${path.slice(home.length)}`;
    return path;
}

function formatDate(date) {
    if (!date || Number.isNaN(date.getTime()))
        return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Group sessions (already sorted, most recent first) by project directory,
// keeping the order of first appearance = most recent session of each project.
function groupByProject(sessions) {
    const groups = new Map();
    for (const session of sessions) {
        if (!groups.has(session.projectDir))
            groups.set(session.projectDir, []);
        groups.get(session.projectDir).push(session);
    }
    return [...groups.values()];
}

// The "Conversazioni" page: list of conversations grouped by project, with
// move-to-trash support. `store` is a SessionStore (or a compatible fake).
class SessionsPage {
    constructor(window, store) {
        this._window = window;
        this._store = store;
        this._generation = 0;
        this._cancellable = null;
        this._closed = false;
        this._projectGroups = [];
        this._rows = new Map(); // session -> {row, group, projectSessions}
        this._statusWidget = null;

        this.page = new Adw.PreferencesPage({
            title: 'Conversazioni',
            icon_name: 'user-trash-symbolic',
        });

        // Always-visible first group: hosts the reload button and the
        // loading / empty / error states.
        this._headGroup = new Adw.PreferencesGroup({
            title: 'Conversazioni',
            description: 'Le conversazioni eliminate vengono spostate nel cestino.',
        });
        const reload = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Ricarica elenco',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reload.connect('clicked', () => this.reload());
        this._headGroup.set_header_suffix(reload);
        this.page.add(this._headGroup);
    }

    // Cancel pending work; call when the window closes.
    close() {
        this._closed = true;
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _setStatus(widget) {
        if (this._statusWidget)
            this._headGroup.remove(this._statusWidget);
        this._statusWidget = widget;
        if (widget)
            this._headGroup.add(widget);
    }

    _clearProjects() {
        for (const group of this._projectGroups)
            this.page.remove(group);
        this._projectGroups = [];
        this._rows.clear();
    }

    _showLoading() {
        const props = {width_request: 32, height_request: 32, halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 24};
        this._setStatus(Adw.Spinner
            ? new Adw.Spinner(props)
            : new Gtk.Spinner({...props, spinning: true}));
    }

    _showEmpty() {
        this._setStatus(new Adw.StatusPage({
            icon_name: 'user-trash-symbolic',
            title: 'Nessuna conversazione',
        }));
    }

    _showError() {
        const status = new Adw.StatusPage({
            icon_name: 'dialog-error-symbolic',
            title: 'Impossibile leggere le conversazioni',
        });
        const retry = new Gtk.Button({
            label: 'Riprova',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill', 'suggested-action'],
        });
        retry.connect('clicked', () => this.reload());
        status.set_child(retry);
        this._setStatus(status);
    }

    async reload() {
        if (this._closed)
            return;
        // A newer reload supersedes any older one.
        const generation = ++this._generation;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._clearProjects();
        this._showLoading();

        let sessions;
        try {
            sessions = await this._store.list(cancellable);
        } catch (e) {
            if (generation !== this._generation)
                return;
            console.debug(`claude-meter: sessions list failed: ${e.message}`);
            this._showError();
            return;
        }
        if (generation !== this._generation)
            return;

        this._populate(sessions);
    }

    _populate(sessions) {
        this._clearProjects();
        if (sessions.length === 0) {
            this._showEmpty();
            return;
        }
        this._setStatus(null);

        for (const projectSessions of groupByProject(sessions)) {
            const projectPath = projectSessions.find(s => s.projectPath)?.projectPath ?? null;
            const group = new Adw.PreferencesGroup({
                // Group titles are Pango markup: escape the path.
                title: GLib.markup_escape_text(projectPath ? tildify(projectPath) : '—', -1),
            });
            this.page.add(group);
            this._projectGroups.push(group);
            for (const session of projectSessions)
                this._addRow(group, session, projectSessions);
        }
    }

    _addRow(group, session, projectSessions) {
        // Titles are arbitrary user text: never parse them as markup. Disable
        // markup before setting the text (construct-property order is not guaranteed).
        const row = new Adw.ActionRow({subtitle_lines: 1});
        row.use_markup = false;
        row.title = session.title ?? 'Senza titolo';
        row.subtitle = `Ultima apertura ${formatDate(session.lastUsedAt)} · ` +
            `Creata ${formatDate(session.createdAt)}`;

        const button = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        if (session.active) {
            row.add_suffix(new Gtk.Label({
                label: 'In corso',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            }));
            button.sensitive = false;
            button.tooltip_text = 'Una conversazione in corso non può essere eliminata';
        } else {
            button.tooltip_text = 'Sposta nel cestino';
            button.connect('clicked', () => this._onTrash(session, button));
        }
        row.add_suffix(button);
        group.add(row);
        this._rows.set(session, {row, group, projectSessions});
    }

    _toast(title) {
        if (!this._closed)
            this._window.add_toast(new Adw.Toast({title}));
    }

    async _onTrash(session, button) {
        button.sensitive = false;
        try {
            await this._confirmAndTrash(session);
        } finally {
            if (this._rows.has(session) && !this._closed)
                button.sensitive = true;
        }
    }

    async _confirmAndTrash(session) {
        let targets;
        try {
            targets = await this._store.getDeletionTargets(session, this._cancellable);
        } catch (e) {
            if (this._closed)
                return;
            console.debug(`claude-meter: deletion targets failed: ${e.message}`);
            this._toast("Impossibile preparare l'eliminazione");
            return;
        }
        if (this._closed)
            return;

        // heading/body are plain text unless *_use_markup is set: no escaping.
        const dialog = new Adw.AlertDialog({
            heading: `Eliminare «${session.title ?? 'Senza titolo'}»?`,
            body: 'Verranno spostati nel cestino:',
        });
        dialog.set_extra_child(this._buildTargetsList(targets));
        dialog.add_response('cancel', 'Annulla');
        dialog.add_response('delete', 'Elimina');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        const response = await dialog.choose(this._window, null);
        if (response !== 'delete' || this._closed)
            return;

        await this._trash(session);
    }

    _buildTargetsList(targets) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});

        const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        for (const target of targets) {
            list.append(new Gtk.Label({
                label: tildify(target.path),
                xalign: 0,
                wrap: true,
                wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
                width_chars: 40,
                max_width_chars: 60,
                css_classes: ['monospace', 'caption', 'dim-label'],
            }));
        }
        box.append(new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: 200,
        }));

        if (targets.some(t => t.kind === 'project-dir')) {
            box.append(new Gtk.Label({
                label: "È l'ultima conversazione del progetto: verrà eliminata anche " +
                    'la cartella con la memoria di Claude (memory/)',
                xalign: 0,
                wrap: true,
                max_width_chars: 50,
                css_classes: ['warning'],
            }));
        }
        return box;
    }

    async _trash(session) {
        let result;
        try {
            // Not cancellable: a reload must not interrupt a half-done trash.
            result = await this._store.trash(session, null);
        } catch (e) {
            if (this._closed)
                return;
            if (e.code === 'active') {
                this._toast('La conversazione è in corso: non può essere eliminata');
                this.reload();
            } else {
                console.debug(`claude-meter: trash failed: ${e.message}`);
                this._toast('Eliminazione non riuscita');
            }
            return;
        }
        if (this._closed)
            return;

        const failed = result.failed.length;
        if (failed === 0) {
            this._removeRow(session);
            this._toast('Spostata nel cestino');
        } else if (result.trashed.length === 0) {
            this._toast('Eliminazione non riuscita');
        } else {
            this._toast(failed === 1 ? '1 elemento non eliminato' : `${failed} elementi non eliminati`);
            this.reload();
        }
    }

    _removeRow(session) {
        const entry = this._rows.get(session);
        if (!entry)
            return;
        this._rows.delete(session);
        entry.group.remove(entry.row);
        entry.projectSessions.splice(entry.projectSessions.indexOf(session), 1);
        if (entry.projectSessions.length === 0) {
            this.page.remove(entry.group);
            this._projectGroups.splice(this._projectGroups.indexOf(entry.group), 1);
        }
        if (this._rows.size === 0)
            this._showEmpty();
    }
}

export default class ClaudeMeterPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Claude Meter',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const refreshGroup = new Adw.PreferencesGroup({title: 'Aggiornamento'});
        page.add(refreshGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Tempo tra lettura dei file locali',
            subtitle: 'Secondi (30-3600)',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_uint('refresh-interval'),
            }),
            digits: 0,
        });
        refreshGroup.add(refreshRow);
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const planRow = new Adw.SpinRow({
            title: 'Tempo tra lettura dei dati online',
            subtitle: 'Secondi (60-3600). Valori bassi possono causare blocchi temporanei.',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
                value: settings.get_uint('plan-refresh-interval'),
            }),
            digits: 0,
        });
        refreshGroup.add(planRow);
        settings.bind('plan-refresh-interval', planRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const lookGroup = new Adw.PreferencesGroup({title: 'Aspetto'});
        page.add(lookGroup);

        const modes = ['accent', 'traffic'];
        const colorRow = new Adw.ComboRow({
            title: 'Colore delle barre',
            // Explicit line break: a narrower subtitle leaves room for the dropdown.
            subtitle: "Accento di sistema, oppure\nverde/giallo/rosso secondo le soglie",
            subtitle_lines: 2,
            model: Gtk.StringList.new(["Colore d'accento", 'Semaforo (verde/giallo/rosso)']),
        });
        lookGroup.add(colorRow);
        const syncColorRow = () => {
            const index = modes.indexOf(settings.get_string('bar-color-mode'));
            colorRow.selected = index < 0 ? 0 : index;
        };
        syncColorRow();
        colorRow.connect('notify::selected', () => {
            const mode = modes[colorRow.selected] ?? 'accent';
            if (settings.get_string('bar-color-mode') !== mode)
                settings.set_string('bar-color-mode', mode);
        });
        const colorChangedId = settings.connect('changed::bar-color-mode', syncColorRow);
        window.connect('close-request', () => {
            settings.disconnect(colorChangedId);
            return false;
        });

        const thresholdGroup = new Adw.PreferencesGroup({
            title: 'Soglie colori (solo con semaforo)',
            description: "Percentuale di utilizzo oltre la quale l'indicatore cambia colore.",
        });
        page.add(thresholdGroup);

        const warnRow = new Adw.SpinRow({
            title: 'Soglia di avviso (giallo)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('warn-threshold'),
            }),
            digits: 0,
        });
        const criticalRow = new Adw.SpinRow({
            title: 'Soglia critica (rosso)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('critical-threshold'),
            }),
            digits: 0,
        });
        thresholdGroup.add(warnRow);
        thresholdGroup.add(criticalRow);

        settings.bind('warn-threshold', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('critical-threshold', criticalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Le soglie servono solo in modalità semaforo.
        const syncThresholds = () => {
            thresholdGroup.sensitive = settings.get_string('bar-color-mode') === 'traffic';
        };
        syncThresholds();
        const thresholdChangedId = settings.connect('changed::bar-color-mode', syncThresholds);
        window.connect('close-request', () => {
            settings.disconnect(thresholdChangedId);
            return false;
        });

        // Avviso < critica, con aggiustamento gentile quando l'utente li incrocia.
        let adjusting = false;
        const keepOrder = () => {
            if (adjusting)
                return;

            const warn = warnRow.value;
            const critical = criticalRow.value;
            if (warn < critical)
                return;

            adjusting = true;
            criticalRow.value = Math.min(warn + 1, 100);
            adjusting = false;
        };
        warnRow.connect('notify::value', keepOrder);
        criticalRow.connect('notify::value', keepOrder);

        const sessionsPage = new SessionsPage(window, new SessionStore());
        window.add(sessionsPage.page);
        sessionsPage.reload();

        // Honour the requested start page, then reset the key. Resetting from
        // inside the handler is safe: the re-emitted change reads 'general'.
        const consumeStartPage = () => {
            if (settings.get_string('prefs-start-page') !== 'sessions')
                return false;
            settings.set_string('prefs-start-page', 'general');
            return true;
        };
        if (consumeStartPage())
            window.set_visible_page(sessionsPage.page);
        const startPageId = settings.connect('changed::prefs-start-page', () => {
            if (!consumeStartPage())
                return;
            window.set_visible_page(sessionsPage.page);
            sessionsPage.reload();
        });
        window.connect('close-request', () => {
            settings.disconnect(startPageId);
            sessionsPage.close();
            return false;
        });

        // Do not start with the first spin button focused (and its text selected):
        // GTK assigns the initial focus when the window is shown; undo it once.
        const focusId = window.connect('notify::focus-widget', () => {
            if (!window.get_focus())
                return;
            window.disconnect(focusId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                for (const row of [refreshRow, planRow])
                    row.set_position(-1); // clears the select-on-focus selection
                window.set_focus(null);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
