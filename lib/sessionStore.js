// Session Store — lists Claude Code conversations and moves them to the trash.
//
// Reads ~/.claude/projects/<project>/<sessionId>.jsonl (streaming, async),
// works out which conversations are live, and computes/trashes every file that
// belongs to a conversation. Pure module: only Gio and GLib, runs under `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'trash_async', 'trash_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const CHUNK_SIZE = 256 * 1024;
const NEWLINE = 0x0a;
const BATCH_SIZE = 64;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const TITLE_MAX = 80;

const decoder = new TextDecoder('utf-8');

function isNotFound(e) {
    try {
        return e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
    } catch {
        return false;
    }
}

function concatBytes(a, b) {
    if (a.length === 0)
        return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeText(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length === 0)
        return null;
    return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function userMessageText(rec) {
    if (rec.type !== 'user' || rec.isMeta || rec.isSidechain)
        return null;
    const content = rec.message?.content;
    if (typeof content === 'string')
        return normalizeText(content);
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block && block.type === 'text' && typeof block.text === 'string')
                return normalizeText(block.text);
        }
    }
    return null;
}

function dateFromInfo(info) {
    const dt = info.get_modification_date_time();
    if (!dt)
        return null;
    return new Date(dt.to_unix() * 1000 + Math.floor(dt.get_microsecond() / 1000));
}

export class SessionStore {
    /**
     * @param {string} claudeDir the ~/.claude directory
     * @param {string} procDir   injectable /proc (tests)
     */
    constructor(claudeDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude']),
        procDir = '/proc') {
        this.claudeDir = GLib.canonicalize_filename(claudeDir, null);
        this.projectsDir = GLib.build_filenamev([this.claudeDir, 'projects']);
        this.procDir = procDir;
    }

    // ------------------------------------------------------------ public

    async list(cancellable = null) {
        const live = await this._liveSessionIds(cancellable);
        const sessions = [];
        const projects = await this._listDir(this.projectsDir, cancellable);
        for (const {name, type} of projects) {
            if (type !== Gio.FileType.DIRECTORY)
                continue;
            const projectDir = GLib.build_filenamev([this.projectsDir, name]);
            const entries = await this._listDir(projectDir, cancellable);
            for (const entry of entries) {
                if (entry.type === Gio.FileType.DIRECTORY || !entry.name.endsWith('.jsonl'))
                    continue;
                const sessionId = entry.name.slice(0, -'.jsonl'.length);
                if (sessionId.length === 0)
                    continue;
                const file = GLib.build_filenamev([projectDir, entry.name]);
                try {
                    const meta = await this._readMeta(file, cancellable);
                    const lastUsedAt = entry.mtime;
                    const recent = lastUsedAt !== null &&
                        Date.now() - lastUsedAt.getTime() < ACTIVE_WINDOW_MS;
                    sessions.push({
                        sessionId,
                        title: meta.title,
                        projectPath: meta.projectPath,
                        projectDir,
                        file,
                        createdAt: meta.createdAt,
                        lastUsedAt,
                        active: live.has(sessionId) || recent,
                    });
                } catch (e) {
                    if (cancellable?.is_cancelled())
                        throw e;
                    console.debug(`claude-meter: skipping unreadable session: ${e.message}`);
                }
            }
        }
        sessions.sort((a, b) => {
            const ta = a.lastUsedAt ? a.lastUsedAt.getTime() : null;
            const tb = b.lastUsedAt ? b.lastUsedAt.getTime() : null;
            if (ta === tb)
                return 0;
            if (ta === null)
                return 1;
            if (tb === null)
                return -1;
            return tb - ta;
        });
        console.debug(`claude-meter: listed ${sessions.length} sessions`);
        return sessions;
    }

    async getDeletionTargets(session, cancellable = null) {
        const {sessionId, file, projectDir} = this._validate(session);
        const convDir = GLib.build_filenamev([projectDir, sessionId]);
        const targets = [];

        let wholeProject = false;
        if (await this._exists(projectDir, cancellable)) {
            const entries = await this._listDir(projectDir, cancellable);
            wholeProject = entries
                .filter(e => e.name !== `${sessionId}.jsonl` && e.name !== sessionId)
                .every(e => e.name === 'memory' && e.type === Gio.FileType.DIRECTORY);
        }

        if (wholeProject) {
            targets.push({path: projectDir, kind: 'project-dir'});
        } else {
            if (await this._exists(file, cancellable))
                targets.push({path: file, kind: 'conversation'});
            if (await this._exists(convDir, cancellable))
                targets.push({path: convDir, kind: 'session-dir'});
        }

        for (const kind of ['file-history', 'session-env']) {
            const p = GLib.build_filenamev([this.claudeDir, kind, sessionId]);
            if (await this._exists(p, cancellable))
                targets.push({path: p, kind});
        }

        const todosDir = GLib.build_filenamev([this.claudeDir, 'todos']);
        const todos = await this._listDir(todosDir, cancellable);
        todos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of todos) {
            if (e.name.startsWith(sessionId))
                targets.push({path: GLib.build_filenamev([todosDir, e.name]), kind: 'todos'});
        }
        return targets;
    }

    async trash(session, cancellable = null) {
        const {sessionId, file} = this._validate(session);
        if (await this._isActive(sessionId, file, cancellable)) {
            const err = new Error('session is active');
            err.code = 'active';
            throw err;
        }
        const targets = await this.getDeletionTargets(session, cancellable);
        const trashed = [];
        const failed = [];
        for (const t of targets) {
            try {
                await this._trashPath(t.path, cancellable);
                trashed.push(t.path);
            } catch (e) {
                failed.push({path: t.path, message: e.message});
            }
        }
        console.debug(`claude-meter: trashed ${trashed.length}, failed ${failed.length}`);
        return {trashed, failed};
    }

    // Overridable in tests.
    async _trashPath(path, cancellable) {
        await Gio.File.new_for_path(path).trash_async(GLib.PRIORITY_DEFAULT, cancellable);
    }

    // ----------------------------------------------------------- helpers

    _validate(session) {
        const bad = () => new Error('invalid session');
        if (!session || typeof session !== 'object')
            throw bad();
        const {sessionId, file, projectDir} = session;
        if (typeof sessionId !== 'string' || sessionId.length === 0 ||
            sessionId.includes('/') || sessionId.includes('\0') ||
            sessionId === '.' || sessionId === '..')
            throw bad();
        if (typeof file !== 'string' || typeof projectDir !== 'string' ||
            !GLib.path_is_absolute(file) || !GLib.path_is_absolute(projectDir))
            throw bad();
        const f = GLib.canonicalize_filename(file, null);
        const p = GLib.canonicalize_filename(projectDir, null);
        if (GLib.path_get_dirname(p) !== this.projectsDir ||
            GLib.path_get_dirname(f) !== p ||
            GLib.path_get_basename(f) !== `${sessionId}.jsonl`)
            throw bad();
        return {sessionId, file: f, projectDir: p};
    }

    async _exists(path, cancellable) {
        try {
            await Gio.File.new_for_path(path).query_info_async('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
            return true;
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            if (!isNotFound(e))
                console.debug(`claude-meter: stat failed: ${e.message}`);
            return false;
        }
    }

    // -> [{name, type, mtime: Date|null}]; missing/unreadable dir -> [].
    async _listDir(path, cancellable) {
        const out = [];
        let enumerator;
        try {
            enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
                'standard::name,standard::type,time::modified,time::modified-usec',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            if (!isNotFound(e))
                console.debug(`claude-meter: cannot list directory: ${e.message}`);
            return out;
        }
        try {
            while (true) {
                const infos = await enumerator.next_files_async(BATCH_SIZE,
                    GLib.PRIORITY_DEFAULT, cancellable);
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    out.push({
                        name: info.get_name(),
                        type: info.get_file_type(),
                        mtime: dateFromInfo(info),
                    });
                }
            }
        } finally {
            try {
                await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // ignore
            }
        }
        return out;
    }

    // Set of sessionIds listed in sessions/<pid>.json whose <procDir>/<pid> exists.
    async _liveSessionIds(cancellable) {
        const live = new Set();
        const dir = GLib.build_filenamev([this.claudeDir, 'sessions']);
        const entries = await this._listDir(dir, cancellable);
        for (const e of entries) {
            if (!e.name.endsWith('.json') || e.type === Gio.FileType.DIRECTORY)
                continue;
            try {
                const [bytes] = await Gio.File.new_for_path(GLib.build_filenamev([dir, e.name]))
                    .load_contents_async(cancellable);
                const obj = JSON.parse(decoder.decode(bytes));
                const pid = Number(obj?.pid);
                const sid = str(obj?.sessionId);
                if (sid === null || !Number.isInteger(pid) || pid <= 0)
                    continue;
                if (await this._exists(GLib.build_filenamev([this.procDir, String(pid)]), cancellable))
                    live.add(sid);
            } catch (err) {
                if (cancellable?.is_cancelled())
                    throw err;
                console.debug(`claude-meter: ignoring registry entry: ${err.message}`);
            }
        }
        return live;
    }

    async _isActive(sessionId, file, cancellable) {
        if ((await this._liveSessionIds(cancellable)).has(sessionId))
            return true;
        try {
            const info = await Gio.File.new_for_path(file).query_info_async(
                'time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable);
            const d = dateFromInfo(info);
            return d !== null && Date.now() - d.getTime() < ACTIVE_WINDOW_MS;
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            return false;
        }
    }

    // Stream a JSONL file; returns {title, projectPath, createdAt}.
    async _readMeta(file, cancellable) {
        let lastTitle = null;
        let projectPath = null;
        let createdAt = null;
        let firstUser = null;

        const handle = line => {
            const isTitle = line.includes('"custom-title"') || line.includes('"ai-title"');
            if (!isTitle && projectPath !== null && createdAt !== null && firstUser !== null)
                return;
            let rec;
            try {
                rec = JSON.parse(line);
            } catch {
                return;
            }
            if (!rec || typeof rec !== 'object')
                return;
            if (projectPath === null)
                projectPath = str(rec.cwd);
            if (createdAt === null && typeof rec.timestamp === 'string') {
                const ms = Date.parse(rec.timestamp);
                if (!Number.isNaN(ms))
                    createdAt = new Date(ms);
            }
            if (rec.type === 'custom-title') {
                const t = str(rec.customTitle);
                if (t !== null)
                    lastTitle = t;
            } else if (rec.type === 'ai-title') {
                const t = str(rec.aiTitle);
                if (t !== null)
                    lastTitle = t;
            } else if (firstUser === null) {
                firstUser = userMessageText(rec);
            }
        };

        const stream = await Gio.File.new_for_path(file).read_async(GLib.PRIORITY_DEFAULT, cancellable);
        try {
            let pending = new Uint8Array(0);
            while (true) {
                const chunk = (await stream.read_bytes_async(CHUNK_SIZE,
                    GLib.PRIORITY_DEFAULT, cancellable)).toArray();
                if (chunk.length === 0)
                    break;
                const data = concatBytes(pending, chunk);
                let start = 0;
                let idx;
                while ((idx = data.indexOf(NEWLINE, start)) !== -1) {
                    if (idx > start)
                        handle(decoder.decode(data.subarray(start, idx)));
                    start = idx + 1;
                }
                pending = data.slice(start);
            }
            if (pending.length > 0)
                handle(decoder.decode(pending));
        } finally {
            try {
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // ignore
            }
        }
        return {title: lastTitle ?? firstUser, projectPath, createdAt};
    }
}
