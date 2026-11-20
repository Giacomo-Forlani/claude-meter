// Build tool: converts the PNG spritesheets in clawd-animation/ into lib/sprites.js.
// Run from any cwd:  gjs -m tools/build-animations.js
// Sync I/O is fine here (not shell code).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

const PALETTE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const toolsDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const rootDir = GLib.path_get_dirname(toolsDir);
const animDir = GLib.build_filenamev([rootDir, 'clawd-animation']);
const outPath = GLib.build_filenamev([rootDir, 'lib', 'sprites.js']);

class BuildError extends Error {}

function fail(msg) {
    throw new BuildError(msg);
}

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        fail(`cannot read ${path}`);
    return new TextDecoder().decode(bytes);
}

// Load a PNG and return {width, height, pixel(x, y) -> [r, g, b, a]}.
function loadSheet(path) {
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const width = pb.get_width();
    const height = pb.get_height();
    const stride = pb.get_rowstride();
    const channels = pb.get_n_channels();
    const hasAlpha = pb.get_has_alpha();
    const data = pb.get_pixels();
    return {
        width, height,
        pixel(x, y) {
            const i = y * stride + x * channels;
            return [data[i], data[i + 1], data[i + 2], hasAlpha ? data[i + 3] : 255];
        },
    };
}

function build() {
    const manifest = JSON.parse(readText(GLib.build_filenamev([animDir, 'animations.json'])));
    const fps = manifest.fps;
    if (!Number.isInteger(fps) || fps <= 0)
        fail('"fps" must be a positive integer');
    const anims = manifest.animations ?? {};
    const names = Object.keys(anims);
    if (names.length === 0)
        fail('no animations in manifest');

    // Validate and slice sheets into frames of raw RGBA pixels.
    let height = null, frameWidth = null;
    const raw = {};   // name -> frames[] -> rows[] -> pixels[] ([r,g,b,a])
    for (const name of names) {
        const a = anims[name];
        const path = GLib.build_filenamev([animDir, a.file ?? '']);
        if (!a.file || !GLib.file_test(path, GLib.FileTest.EXISTS))
            fail(`${name}: file "${a.file}" not found`);
        if (a.loop !== true && a.loop !== false)
            fail(`${name}: "loop" must be a boolean`);
        if (a.seconds !== undefined) {
            if (a.loop === false)
                fail(`${name}: loop:false animations must not have "seconds"`);
            if (typeof a.seconds !== 'number' || !(a.seconds > 0))
                fail(`${name}: "seconds" must be > 0`);
        }
        const sheet = loadSheet(path);
        const fw = a.frameWidth ?? sheet.height;
        if (!Number.isInteger(fw) || fw <= 0)
            fail(`${name}: invalid frameWidth`);
        if (sheet.width % fw !== 0)
            fail(`${name}: sheet width ${sheet.width} is not a multiple of frameWidth ${fw}`);
        if (height === null) {
            height = sheet.height;
            frameWidth = fw;
        } else if (sheet.height !== height || fw !== frameWidth) {
            fail(`${name}: size ${fw}x${sheet.height} differs from ${frameWidth}x${height}`);
        }
        const frames = [];
        for (let f = 0; f < sheet.width / fw; f++) {
            const rows = [];
            for (let y = 0; y < height; y++) {
                const row = [];
                for (let x = 0; x < fw; x++)
                    row.push(sheet.pixel(f * fw + x, y));
                rows.push(row);
            }
            frames.push(rows);
        }
        raw[name] = frames;
    }

    const states = manifest.states ?? {};
    for (const [state, target] of Object.entries(states)) {
        for (const n of Array.isArray(target) ? target : [target]) {
            if (!anims[n])
                fail(`state "${state}" refers to unknown animation "${n}"`);
        }
    }

    // One bounding box of non-empty pixels over every frame of every animation.
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (const name of names) {
        for (const rows of raw[name]) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < frameWidth; x++) {
                    if (rows[y][x][3] === 0)
                        continue;
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                }
            }
        }
    }
    if (maxX < 0)
        fail('all frames are fully transparent');
    const gridW = maxX - minX + 1;
    const gridH = maxY - minY + 1;

    // Global palette in order of first appearance (manifest order).
    const palette = new Map();   // "r,g,b,a" -> {char, rgba}
    const out = {};
    for (const name of names) {
        out[name] = raw[name].map(rows => {
            const lines = [];
            for (let y = minY; y <= maxY; y++) {
                let line = '';
                for (let x = minX; x <= maxX; x++) {
                    const p = rows[y][x];
                    if (p[3] === 0) {
                        line += '.';
                        continue;
                    }
                    const key = p.join(',');
                    let entry = palette.get(key);
                    if (!entry) {
                        if (palette.size >= PALETTE_CHARS.length)
                            fail(`more than ${PALETTE_CHARS.length} colors`);
                        entry = {char: PALETTE_CHARS[palette.size], rgba: p};
                        palette.set(key, entry);
                    }
                    line += entry.char;
                }
                lines.push(line);
            }
            return lines;
        });
    }

    // Emit the module.
    const q = s => `'${s}'`;
    const js = [];
    js.push('// GENERATED by tools/build-animations.js from clawd-animation/ — do not edit by hand.');
    js.push('// Edit the spritesheets / clawd-animation/animations.json and run: gjs -m tools/build-animations.js');
    js.push(`export const FPS = ${fps};`);
    js.push(`export const GRID_W = ${gridW};   // after crop`);
    js.push(`export const GRID_H = ${gridH};`);
    js.push('// char -> [r, g, b, a] (0..255)');
    js.push('export const PALETTE = {');
    for (const {char, rgba} of palette.values())
        js.push(`    ${q(char)}: [${rgba.join(', ')}],`);
    js.push('};');
    const stateStr = Object.entries(states).map(([k, v]) =>
        `${k}: ${Array.isArray(v) ? `[${v.map(q).join(', ')}]` : q(v)}`).join(', ');
    js.push(`export const STATES = {${stateStr}};`);
    js.push('export const ANIMATIONS = {');
    for (const name of names) {
        const a = anims[name];
        js.push(`    ${name}: {`);
        js.push(`        loop: ${a.loop},`);
        js.push(`        seconds: ${a.seconds ?? null},`);
        js.push('        frames: [');
        for (const frame of out[name]) {
            js.push('            [');
            for (const line of frame)
                js.push(`                ${q(line)},`);
            js.push('            ],');
        }
        js.push('        ],');
        js.push('    },');
    }
    js.push('};');
    js.push('');

    Gio.File.new_for_path(outPath).replace_contents(
        new TextEncoder().encode(js.join('\n')), null, false,
        Gio.FileCreateFlags.NONE, null);

    print(`sprites.js: grid ${gridW}x${gridH}, crop box x ${minX}..${maxX}, y ${minY}..${maxY} ` +
        `(of ${frameWidth}x${height}), ${palette.size} colors, ${fps} fps`);
    for (const name of names)
        print(`  ${name}: ${out[name].length} frames`);
}

try {
    build();
} catch (e) {
    printerr(`build-animations: ${e instanceof BuildError ? e.message : e}`);
    System.exit(1);
}
