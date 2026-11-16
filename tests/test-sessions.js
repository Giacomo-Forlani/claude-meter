// Tests for lib/sessionStore.js — run with: gjs -m tests/test-sessions.js
//
// All fixtures live in temp dirs (GLib.dir_make_tmp). trash_async is never
// called: SessionStore._trashPath is replaced by a fake. The final smoke test
// only READS the real ~/.claude via list() and prints counts, never content.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SessionStore} from '../lib/sessionStore.js';

const tmpDirs = [];
let passCount = 0;
let failCount = 0;

// ------------------------------------------------------------------ helpers

function makeTmpDir() {
    const dir = GLib.dir_make_tmp('claude-meter-sessions-XXXXXX');
    tmpDirs.push(dir);
    return dir;
}

function join(...parts) {
    return GLib.build_filenamev(parts);
}

function writeFile(path, content = '') {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, content);
}

function mkdir(path) {
    GLib.mkdir_with_parents(path, 0o755);
}

function setMtime(path, ms) {
    Gio.File.new_for_path(path).set_attribute_uint64('time::modified',
        Math.floor(ms / 1000), Gio.FileQueryInfoFlags.NONE, null);
}

const OLD = Date.now() - 24 * 3600 * 1000;

function removeTree(path) {
    const dir = Gio.File.new_for_path(path);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return;
    }
    while (true) {
        const info = enumerator.next_file(null);
        if (!info)
            break;
        const child = join(path, info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            removeTree(child);
        else
            Gio.File.new_for_path(child).delete(null);
    }
    enumerator.close(null);
    dir.delete(null);
}

function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertJson(actual, expected, msg) {
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

async function assertRejects(promiseFn, check, msg) {
    try {
        await promiseFn();
    } catch (e) {
        if (check && !check(e))
            throw new Error(`${msg}: wrong error ${e.message}`);
        return;
    }
    throw new Error(`${msg}: expected rejection`);
}

const L = o => `${JSON.stringify(o)}\n`;

// Fixture: a claudeDir + fake proc dir.
function makeEnv() {
    const root = makeTmpDir();
    const claude = join(root, 'claude');
    const proc = join(root, 'proc');
    mkdir(join(claude, 'projects'));
    mkdir(proc);
    return {claude, proc, store: new SessionStore(claude, proc)};
}

// Writes projects/<project>/<id>.jsonl (old mtime unless given), returns path.
function addConv(env, project, id, lines, mtime = OLD) {
    const file = join(env.claude, 'projects', project, `${id}.jsonl`);
    writeFile(file, lines.join(''));
    setMtime(file, mtime);
    return file;
}

function sessionFor(env, project, id) {
    const projectDir = join(env.claude, 'projects', project);
    return {sessionId: id, title: null, projectPath: null, projectDir,
        file: join(projectDir, `${id}.jsonl`), createdAt: null, lastUsedAt: null, active: false};
}

async function listOne(env, id) {
    return (await env.store.list()).find(s => s.sessionId === id);
}

// -------------------------------------------------------------------- cases

const cases = [];
function test(name, fn) {
    cases.push({name, fn});
}

test('title from ai-title', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's1', [L({type: 'ai-title', aiTitle: 'AI name', sessionId: 's1'})]);
    assertEqual((await listOne(env, 's1')).title, 'AI name', 'title');
});

test('title from custom-title', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's1', [L({type: 'custom-title', customTitle: 'Mine', sessionId: 's1'})]);
    assertEqual((await listOne(env, 's1')).title, 'Mine', 'title');
});

test('last title wins (custom then ai, and ai then custom)', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [
        L({type: 'custom-title', customTitle: 'first'}),
        L({type: 'ai-title', aiTitle: 'second'}),
    ]);
    addConv(env, 'p', 'b', [
        L({type: 'ai-title', aiTitle: 'first'}),
        L({type: 'custom-title', customTitle: 'second'}),
        L({type: 'ai-title', aiTitle: ''}),
    ]);
    assertEqual((await listOne(env, 'a')).title, 'second', 'a');
    assertEqual((await listOne(env, 'b')).title, 'second', 'b (empty ignored)');
});

test('title beats user message even when user message comes later', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', message: {content: 'hello'}}),
        L({type: 'ai-title', aiTitle: 'T'}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'T', 'title');
});

test('fallback to first user message: string content', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', isMeta: true, message: {content: 'meta noise'}}),
        L({type: 'user', isSidechain: true, message: {content: 'side noise'}}),
        L({type: 'user', message: {content: '  Ciao\n\n  mondo  '}}),
        L({type: 'user', message: {content: 'later'}}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'Ciao mondo', 'title');
});

test('fallback to first user message: array content, tool results skipped', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', message: {content: [{type: 'tool_result', content: 'x'}]}}),
        L({type: 'user', message: {content: [{type: 'image'}, {type: 'text', text: 'from array'}]}}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'from array', 'title');
});

test('fallback truncates to ~80 chars with ellipsis', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'user', message: {content: 'x'.repeat(200)}})]);
    const t = (await listOne(env, 's')).title;
    assertEqual(t, `${'x'.repeat(80)}…`, 'title');
});

test('no title at all -> null', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'assistant', message: {content: 'hi'}}),
        L({type: 'user', isMeta: true, message: {content: 'meta'}}),
    ]);
    assertEqual((await listOne(env, 's')).title, null, 'title');
});

test('cwd and createdAt present', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'queue-operation'}),
        L({type: 'user', cwd: '/home/x/proj', timestamp: '2026-01-02T03:04:05.000Z', message: {content: 'a'}}),
        L({type: 'user', cwd: '/other', timestamp: '2027-01-01T00:00:00.000Z', message: {content: 'b'}}),
    ]);
    const s = await listOne(env, 's');
    assertEqual(s.projectPath, '/home/x/proj', 'cwd');
    assertEqual(s.createdAt.toISOString(), '2026-01-02T03:04:05.000Z', 'createdAt');
    assert(s.lastUsedAt instanceof Date, 'lastUsedAt is Date');
});

test('cwd and createdAt missing -> null', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x', timestamp: 'not a date'})]);
    const s = await listOne(env, 's');
    assertEqual(s.projectPath, null, 'cwd');
    assertEqual(s.createdAt, null, 'createdAt');
});

test('corrupt JSON lines skipped, valid ones still used', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        '{not json\n',
        '\n',
        L({type: 'ai-title', aiTitle: 'Survivor'}),
        '{"type":"ai-title","aiTitle":"trunc',
    ]);
    assertEqual((await listOne(env, 's')).title, 'Survivor', 'title');
});

test('very long lines and chunk boundaries are handled', async () => {
    const env = makeEnv();
    const big = L({type: 'assistant', blob: 'z'.repeat(600 * 1024)});
    addConv(env, 'p', 's', [
        L({type: 'user', cwd: '/c', message: {content: 'start'}}),
        big, big,
        L({type: 'ai-title', aiTitle: 'after big'}),
    ]);
    const s = await listOne(env, 's');
    assertEqual(s.title, 'after big', 'title');
    assertEqual(s.projectPath, '/c', 'cwd');
});

test('subagent files and memory are not conversations', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'ai-title', aiTitle: 'T'})]);
    writeFile(join(env.claude, 'projects', 'p', 's', 'subagents', 'agent-1.jsonl'), L({type: 'user'}));
    writeFile(join(env.claude, 'projects', 'p', 'memory', 'MEMORY.md'), 'x');
    writeFile(join(env.claude, 'projects', 'p', 'notes.txt'), 'x');
    const list = await env.store.list();
    assertEqual(list.length, 1, 'count');
    assertEqual(list[0].sessionId, 's', 'id');
    assertEqual(list[0].projectDir, join(env.claude, 'projects', 'p'), 'projectDir');
    assertEqual(list[0].file, join(env.claude, 'projects', 'p', 's.jsonl'), 'file');
});

test('missing projects/ and sessions/ -> empty list, no throw', async () => {
    const root = makeTmpDir();
    const store = new SessionStore(join(root, 'nothing'), join(root, 'proc'));
    assertJson(await store.list(), [], 'list');
});

test('ordering: most recently used first', async () => {
    const env = makeEnv();
    addConv(env, 'p1', 'old', [L({type: 'x'})], OLD);
    addConv(env, 'p2', 'older', [L({type: 'x'})], OLD - 5 * 3600 * 1000);
    addConv(env, 'p1', 'mid', [L({type: 'x'})], OLD - 3600 * 1000);
    assertJson((await env.store.list()).map(s => s.sessionId), ['old', 'mid', 'older'], 'order');
});

test('active: registry with live pid', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'live', [L({type: 'x'})]);
    addConv(env, 'p', 'dead', [L({type: 'x'})]);
    addConv(env, 'p', 'idle', [L({type: 'x'})]);
    mkdir(join(env.proc, '4242'));
    writeFile(join(env.claude, 'sessions', '4242.json'), JSON.stringify({pid: 4242, sessionId: 'live'}));
    writeFile(join(env.claude, 'sessions', '4343.json'), JSON.stringify({pid: 4343, sessionId: 'dead'}));
    const by = Object.fromEntries((await env.store.list()).map(s => [s.sessionId, s.active]));
    assertEqual(by.live, true, 'live');
    assertEqual(by.dead, false, 'dead pid');
    assertEqual(by.idle, false, 'idle');
});

test('active: .key / garbage / malformed registry files ignored', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'g', [L({type: 'x'})]);
    mkdir(join(env.proc, '1'));
    writeFile(join(env.claude, 'sessions', '1.abc.key'), JSON.stringify({pid: 1, sessionId: 'g'}));
    writeFile(join(env.claude, 'sessions', '1.json'), 'garbage{');
    writeFile(join(env.claude, 'sessions', '2.json'), JSON.stringify({pid: 1}));
    writeFile(join(env.claude, 'sessions', '3.json'), JSON.stringify({sessionId: 'g'}));
    assertEqual((await listOne(env, 'g')).active, false, 'active');
});

test('active: 5-minute mtime fallback', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'fresh', [L({type: 'x'})], Date.now() - 60 * 1000);
    addConv(env, 'p', 'stale', [L({type: 'x'})], Date.now() - 10 * 60 * 1000);
    const by = Object.fromEntries((await env.store.list()).map(s => [s.sessionId, s.active]));
    assertEqual(by.fresh, true, 'fresh');
    assertEqual(by.stale, false, 'stale');
});

test('targets: only existing ones, fixed order, todos prefix match', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 's'));
    mkdir(join(env.claude, 'file-history', 's'));
    // session-env intentionally missing
    writeFile(join(env.claude, 'todos', 's-agent-s.json'), '[]');
    writeFile(join(env.claude, 'todos', 's.json'), '[]');
    writeFile(join(env.claude, 'todos', 'other-agent-other.json'), '[]');
    writeFile(join(env.claude, 'file-history', 'other', 'x'), 'x');
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    const p = join(env.claude, 'projects', 'p');
    assertJson(t, [
        {path: join(p, 's.jsonl'), kind: 'conversation'},
        {path: join(p, 's'), kind: 'session-dir'},
        {path: join(env.claude, 'file-history', 's'), kind: 'file-history'},
        {path: join(env.claude, 'todos', 's-agent-s.json'), kind: 'todos'},
        {path: join(env.claude, 'todos', 's.json'), kind: 'todos'},
    ], 'targets');
});

test('targets: session-env included; nonexistent conversation not listed', async () => {
    const env = makeEnv();
    mkdir(join(env.claude, 'projects', 'p', 'keep'));
    mkdir(join(env.claude, 'session-env', 's'));
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [{path: join(env.claude, 'session-env', 's'), kind: 'session-env'}], 'targets');
});

test('targets: project dir when it would be left empty', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 's', 'subagents', 'a.jsonl'), '');
    mkdir(join(env.claude, 'session-env', 's'));
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [
        {path: join(env.claude, 'projects', 'p'), kind: 'project-dir'},
        {path: join(env.claude, 'session-env', 's'), kind: 'session-env'},
    ], 'targets');
});

test('targets: project dir when only memory/ would remain', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 'memory', 'MEMORY.md'), 'x');
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [{path: join(env.claude, 'projects', 'p'), kind: 'project-dir'}], 'targets');
});

test('targets: project dir excluded when other conversations or files remain', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    let t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'other conversation');

    const env2 = makeEnv();
    addConv(env2, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env2.claude, 'projects', 'p', 'stray.txt'), 'x');
    t = await env2.store.getDeletionTargets(sessionFor(env2, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'stray file');

    const env3 = makeEnv();
    addConv(env3, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env3.claude, 'projects', 'p', 'memory'), 'a file named memory');
    t = await env3.store.getDeletionTargets(sessionFor(env3, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'memory is a file');
});

test('invalid session objects rejected', async () => {
    const env = makeEnv();
    const good = sessionFor(env, 'p', 's');
    const outside = makeTmpDir();
    const bads = [
        null,
        {},
        {...good, sessionId: ''},
        {...good, sessionId: '..'},
        {...good, sessionId: '.'},
        {...good, sessionId: 'a/b'},
        {...good, sessionId: 5},
        {...good, file: join(outside, 's.jsonl')},
        {...good, projectDir: outside},
        {...good, projectDir: env.claude},
        {...good, projectDir: join(env.claude, 'projects')},
        {...good, projectDir: join(env.claude, 'projects', 'p', '..', '..', 'x')},
        {...good, file: join(env.claude, 'projects', 'p', 'other.jsonl')},
        {...good, file: join(env.claude, 'projects', 'p', '..', 'p2', 's.jsonl')},
        {...good, file: 'relative/s.jsonl'},
    ];
    for (let i = 0; i < bads.length; i++) {
        await assertRejects(() => env.store.getDeletionTargets(bads[i]), null, `targets bad #${i}`);
        await assertRejects(() => env.store.trash(bads[i]), null, `trash bad #${i}`);
    }
});

test('trash refuses an active conversation (registry) and trashes nothing', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    mkdir(join(env.proc, '77'));
    writeFile(join(env.claude, 'sessions', '77.json'), JSON.stringify({pid: 77, sessionId: 's'}));
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    await assertRejects(() => env.store.trash(sessionFor(env, 'p', 's')),
        e => e.code === 'active', 'trash active');
    assertEqual(calls.length, 0, 'no trash calls');
});

test('trash refuses a recently modified conversation (mtime fallback)', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})], Date.now() - 1000);
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    await assertRejects(() => env.store.trash(sessionFor(env, 'p', 's')),
        e => e.code === 'active', 'trash recent');
    assertEqual(calls.length, 0, 'no trash calls');
});

test('trash: success path trashes all targets in order', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'file-history', 's'));
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    const res = await env.store.trash(sessionFor(env, 'p', 's'));
    assertJson(res.trashed, calls, 'trashed == calls');
    assertEqual(res.trashed.length, 2, 'two targets');
    assertEqual(res.failed.length, 0, 'no failures');
});

test('trash: partial failure reported, continues after error', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 's'));
    mkdir(join(env.claude, 'file-history', 's'));
    writeFile(join(env.claude, 'todos', 's-agent-s.json'), '[]');
    const calls = [];
    const bad = join(env.claude, 'projects', 'p', 's');
    env.store._trashPath = async p => {
        calls.push(p);
        if (p === bad)
            throw new Error('boom');
    };
    const res = await env.store.trash(sessionFor(env, 'p', 's'));
    assertEqual(calls.length, 4, 'all four attempted');
    assertEqual(res.trashed.length, 3, 'three trashed');
    assertEqual(res.failed.length, 1, 'one failed');
    assertEqual(res.failed[0].path, bad, 'failed path');
    assertEqual(res.failed[0].message, 'boom', 'failed message');
});

// -------------------------------------------------------------------- smoke

async function smokeTest() {
    const store = new SessionStore();
    const list = await store.list();
    const active = list.filter(s => s.active).length;
    const noTitle = list.filter(s => s.title === null).length;
    const noPath = list.filter(s => s.projectPath === null).length;
    print(`SMOKE sessions=${list.length} active=${active} nullTitle=${noTitle} nullProjectPath=${noPath}`);
}

// -------------------------------------------------------------------- entry

let exitCode = 0;
const loop = new GLib.MainLoop(null, false);

(async () => {
    for (const {name, fn} of cases) {
        try {
            await fn();
            print(`PASS ${name}`);
            passCount += 1;
        } catch (e) {
            print(`FAIL ${name}: ${e.message}`);
            failCount += 1;
        }
    }
    try {
        await smokeTest();
    } catch (e) {
        print(`FAIL smoke: ${e.message}`);
        failCount += 1;
    }
    for (const dir of tmpDirs) {
        try {
            removeTree(dir);
        } catch {
            // Best-effort cleanup.
        }
    }
    print(`SUMMARY pass=${passCount} fail=${failCount}`);
    exitCode = failCount === 0 ? 0 : 1;
    loop.quit();
})();

loop.run();
System.exit(exitCode);
