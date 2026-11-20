import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SessionMonitor, parseProcStart, parseSession} from '../lib/sessionMonitor.js';

let total = 0;
let failures = 0;

function check(name, condition, detail = null) {
    total++;
    if (condition) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}${detail === null ? '' : ` — ${detail}`}`);
    }
}

function write(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function statLine(pid, start, comm = 'claude') {
    // field 3..21 placeholders, field 22 = start
    const middle = Array.from({length: 19}, (_, i) => (i === 0 ? 'S' : '0')).join(' ');
    return `${pid} (${comm}) ${middle} ${start} 0 0\n`;
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const children = file.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = children.next_file(null)) !== null) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                removeTree(child.get_path());
            else
                child.delete(null);
        }
        children.close(null);
        file.delete(null);
    } catch (e) {
        print(`nota: pulizia fallita: ${e.message}`);
    }
}

function testParsers() {
    check('procStart semplice', parseProcStart(statLine(42, '12345')) === '12345');
    check('procStart con comm con spazi e parentesi',
        parseProcStart(statLine(42, '999', 'a (b) c')) === '999');
    check('procStart non valido', parseProcStart('garbage') === null);

    check('sessione bg ignorata', parseSession({kind: 'bg', pid: 1, status: 'busy'}) === null);
    check('pid non valido ignorato', parseSession({kind: 'interactive', pid: 'x'}) === null);
    const s = parseSession({kind: 'interactive', pid: 7, sessionId: 'abc', status: 'busy',
        startedAt: 10, procStart: '55'});
    check('sessione interattiva', s && s.id === 'abc' && s.busy === true && s.procStart === '55');
    check('idle non busy', parseSession({kind: 'interactive', pid: 7, status: 'idle'}).busy === false);
}

async function testScan(tmp) {
    const sessions = GLib.build_filenamev([tmp, 'sessions']);
    const proc = GLib.build_filenamev([tmp, 'proc']);

    const missing = new SessionMonitor(GLib.build_filenamev([tmp, 'nope']), proc);
    const empty = await missing.scan();
    check('directory assente -> []', Array.isArray(empty) && empty.length === 0);

    const entry = (pid, extra) => JSON.stringify({pid, sessionId: `s${pid}`, kind: 'interactive',
        status: 'idle', startedAt: pid, procStart: String(pid * 10), ...extra});
    write(`${sessions}/1.json`, entry(1, {status: 'busy'}));
    write(`${sessions}/2.json`, entry(2));
    write(`${sessions}/3.json`, entry(3, {kind: 'bg'}));
    write(`${sessions}/4.json`, entry(4));             // dead: no /proc entry
    write(`${sessions}/5.json`, entry(5));             // pid reused: other start time
    write(`${sessions}/notes.txt`, 'x');
    write(`${proc}/1/stat`, statLine(1, '10'));
    write(`${proc}/2/stat`, statLine(2, '20'));
    write(`${proc}/3/stat`, statLine(3, '30'));
    write(`${proc}/5/stat`, statLine(5, '999'));

    const monitor = new SessionMonitor(sessions, proc);
    let list = await monitor.scan();
    check('solo interattive vive', list.map(s => s.id).join(',') === 's1,s2',
        JSON.stringify(list));
    check('stato busy', list[0].busy === true && list[1].busy === false);

    // File caught mid-write keeps the previous value.
    write(`${sessions}/2.json`, '{"pid": 2, "sess');
    list = await monitor.scan();
    check('file parziale mantiene valore precedente', list.map(s => s.id).join(',') === 's1,s2');

    // Removed file disappears.
    Gio.File.new_for_path(`${sessions}/1.json`).delete(null);
    list = await monitor.scan();
    check('file rimosso -> sessione sparita', list.map(s => s.id).join(',') === 's2');
}

async function main() {
    const tmp = GLib.dir_make_tmp('claude-meter-sessions-XXXXXX');
    try {
        testParsers();
        await testScan(tmp);
    } catch (e) {
        failures++;
        print(`FAIL eccezione: ${e.message}\n${e.stack}`);
    } finally {
        removeTree(tmp);
    }
    print(`${total - failures}/${total} test passati`);
}

const loop = new GLib.MainLoop(null, false);
main().finally(() => loop.quit());
loop.run();
System.exit(failures > 0 ? 1 : 0);
