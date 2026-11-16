// Claude crabs: sprite compilation and behaviour model (no drawing here).
// Pure module: testable with plain gjs. Sprites are hand-editable data in
// sprites.js; the indicator paints the pixels of frames() on a St.DrawingArea.

import {ANIMATIONS} from './sprites.js';

export const PIXEL = 2;               // logical px per sprite pixel
export const FPS = 8;

// Tones of Claude orange drifting to red.
export const PALETTE = [
    '#d97757', '#e0835e', '#cc6b4a', '#d4603f',
    '#c75438', '#db6a4b', '#bf4a33', '#e28f6a',
];
export const EYE_COLOR = '#000000';
export const DARK_FACTOR = 0.7;       // 'b' pixels = body colour * this

const ROLES = {B: 'body', b: 'dark', E: 'eyes'};
const EMPTY = new Set(['.', ' ']);

/**
 * Compile hand-written animations into pixel lists on a common grid.
 * Throws on malformed data (unknown character, missing 'idle', empty frames).
 * @returns {{width, height, animations: Object<string, Animation>}}
 *   Animation = {frames, mirrored, every: number[], cycle, weight, move, seconds}
 *   each frame = {body, dark, eyes}: arrays of [col, row]; mirrored = frames
 *   flipped horizontally (only when the animation has flip: true, else null)
 */
export function compileAnimations(source) {
    if (!source.idle)
        throw new Error("sprites: manca l'animazione 'idle'");
    let width = 0;
    let height = 0;
    for (const [name, anim] of Object.entries(source)) {
        if (!Array.isArray(anim.frames) || anim.frames.length === 0)
            throw new Error(`sprites: '${name}' non ha frame`);
        for (const rows of anim.frames) {
            height = Math.max(height, rows.length);
            for (const row of rows)
                width = Math.max(width, row.length);
        }
    }

    const animations = {};
    for (const [name, anim] of Object.entries(source)) {
        const frames = anim.frames.map((rows, f) => {
            const frameW = Math.max(...rows.map(r => r.length));
            const dx = Math.floor((width - frameW) / 2);
            const dy = height - rows.length;
            const out = {body: [], dark: [], eyes: []};
            rows.forEach((row, r) => {
                [...row].forEach((ch, c) => {
                    if (EMPTY.has(ch))
                        return;
                    const role = ROLES[ch];
                    if (!role)
                        throw new Error(`sprites: '${name}' frame ${f} riga ${r}: carattere '${ch}' sconosciuto`);
                    out[role].push([c + dx, r + dy]);
                });
            });
            return out;
        });
        let every = anim.every ?? 1;
        if (Array.isArray(every)) {
            if (every.length !== frames.length)
                throw new Error(`sprites: '${name}' every ha ${every.length} valori ma ${frames.length} frame`);
        } else {
            every = frames.map(() => every);
        }
        every = every.map(n => Math.max(1, Math.round(n)));
        const mirror = list => list.map(([c, r]) => [width - 1 - c, r]);
        const [min, max] = anim.seconds ?? [2, 5];
        animations[name] = {
            frames,
            mirrored: anim.flip
                ? frames.map(f => ({body: mirror(f.body), dark: mirror(f.dark), eyes: mirror(f.eyes)}))
                : null,
            every,
            cycle: every.reduce((a, b) => a + b, 0),
            weight: Math.max(0, anim.weight ?? 1),
            move: Boolean(anim.move),
            seconds: [min, Math.max(min, max)],
        };
    }
    return {width, height, animations};
}

const COMPILED = compileAnimations(ANIMATIONS);
export const SPRITES = COMPILED.animations;
export const GRID_W = COMPILED.width;
export const GRID_H = COMPILED.height;
export const SPRITE_W = GRID_W * PIXEL;
export const SPRITE_H = GRID_H * PIXEL;
export const CRAB_SLOT = SPRITE_W + 2;                     // preferred width per crab in the panel
export const CRAB_MIN_STEP = Math.round(SPRITE_W * 0.65);  // min distance between crab homes when cramped

const BEHAVIOURS = Object.keys(SPRITES).filter(n => n !== 'idle' && SPRITES[n].weight > 0);
const IDLE_ANIMATED = SPRITES.idle.frames.length > 1;

/** Stable palette index for a session id. */
export function colorFor(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return PALETTE[(h >>> 0) % PALETTE.length];
}

/** '#rrggbb' scaled towards black by factor (0..1). */
export function darken(hex, factor = DARK_FACTOR) {
    const n = parseInt(hex.slice(1), 16);
    const ch = shift => Math.round((n >> shift & 255) * factor).toString(16).padStart(2, '0');
    return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function randInt(rand, min, max) {
    return min + Math.floor(rand() * (max - min + 1));
}

function pickBehaviour(rand) {
    if (BEHAVIOURS.length === 0)
        return 'idle';
    const total = BEHAVIOURS.reduce((sum, n) => sum + SPRITES[n].weight, 0);
    let r = rand() * total;
    for (const name of BEHAVIOURS) {
        r -= SPRITES[name].weight;
        if (r < 0)
            return name;
    }
    return BEHAVIOURS[BEHAVIOURS.length - 1];
}

/** Set of crabs living in an area of a given width. */
export class CrabFlock {
    constructor(rand = Math.random) {
        this._rand = rand;
        this._crabs = new Map(); // id -> crab
        this._width = 0;
    }

    /** Preferred area width for n crabs. */
    static preferredWidth(count) {
        return count > 0 ? Math.max(SPRITE_W, count * CRAB_SLOT) : 0;
    }

    /** How many crabs fit in a width without becoming an unreadable blob. */
    static capacity(width) {
        return width < SPRITE_W ? 0 : 1 + Math.floor((width - SPRITE_W) / CRAB_MIN_STEP);
    }

    get size() {
        return this._crabs.size;
    }

    /** True when some crab changes frame over time (an animation timer is needed). */
    get animating() {
        for (const crab of this._crabs.values()) {
            if (crab.busy || IDLE_ANIMATED)
                return true;
        }
        return false;
    }

    /**
     * @param {Array<{id: string, busy: boolean}>} sessions crabs to show, in order
     * @param {boolean} relayout spread resting crabs again (e.g. the area was resized)
     */
    sync(sessions, relayout = false) {
        const ids = new Set(sessions.map(s => s.id));
        let changed = relayout;
        for (const id of [...this._crabs.keys()]) {
            if (!ids.has(id)) {
                this._crabs.delete(id);
                changed = true;
            }
        }
        sessions.forEach((s, index) => {
            let crab = this._crabs.get(s.id);
            if (!crab) {
                const color = colorFor(s.id);
                crab = {
                    id: s.id,
                    color,
                    dark: darken(color),
                    x: 0,
                    home: index,
                    dir: this._rand() < 0.5 ? -1 : 1,
                    behaviour: 'idle',
                    left: 0,
                    tick: 0,      // frames lived while busy (0 = never moved)
                    animTick: 0,  // frames since the current animation started
                    busy: false,
                };
                this._crabs.set(s.id, crab);
                changed = true;
            }
            crab.home = index;
            const busy = Boolean(s.busy);
            if (busy !== crab.busy) {
                crab.behaviour = 'idle';
                crab.left = 0; // a busy crab picks a behaviour on the next step
                crab.animTick = 0;
            }
            crab.busy = busy;
        });
        // New layout: resting crabs move to their evenly spaced spot, walkers keep going.
        if (changed) {
            for (const crab of this._crabs.values()) {
                if (!crab.busy || crab.tick === 0)
                    this._placeAtHome(crab, this._crabs.size);
            }
        }
        this._clampAll();
    }

    setWidth(width) {
        this._width = Math.max(0, width);
    }

    /**
     * Advance one animation tick.
     * @returns {boolean} true if something visible changed (a repaint is needed)
     */
    step() {
        const maxX = this._maxX();
        let changed = false;
        for (const crab of this._crabs.values()) {
            const before = this._spriteOf(crab);
            const x0 = crab.x;
            this._stepCrab(crab, maxX);
            if (crab.x !== x0 || this._spriteOf(crab) !== before)
                changed = true;
        }
        return changed;
    }

    _stepCrab(crab, maxX) {
        crab.animTick++;
        if (!crab.busy)
            return;
        crab.tick++;
        if (crab.left <= 0) {
            crab.behaviour = pickBehaviour(this._rand);
            const [min, max] = SPRITES[crab.behaviour].seconds;
            crab.left = Math.max(1, randInt(this._rand, Math.round(min * FPS), Math.round(max * FPS)));
            crab.animTick = 0;
            if (SPRITES[crab.behaviour].move && this._rand() < 0.5)
                crab.dir = -crab.dir;
        }
        crab.left--;

        if (SPRITES[crab.behaviour].move && maxX > 0) {
            crab.x += crab.dir;
            if (crab.x <= 0 || crab.x >= maxX) {
                crab.x = Math.max(0, Math.min(maxX, crab.x));
                crab.dir = -crab.dir;
            }
        }
    }

    _animationOf(crab) {
        return crab.busy ? crab.behaviour : 'idle';
    }

    /** Current frame of a crab (same object while the frame does not change). */
    _spriteOf(crab) {
        const anim = SPRITES[this._animationOf(crab)];
        let t = crab.animTick % anim.cycle;
        let index = 0;
        while (t >= anim.every[index]) {
            t -= anim.every[index];
            index++;
        }
        const set = anim.mirrored && crab.dir < 0 ? anim.mirrored : anim.frames;
        return set[index];
    }

    /**
     * Drawable state of every crab, back to front.
     * @returns {Array<{id, color, dark, x, dim, animation, sprite}>}
     *   sprite = {body, dark, eyes} pixel lists in grid units
     */
    frames() {
        const out = [];
        for (const crab of this._crabs.values()) {
            out.push({
                id: crab.id,
                color: crab.color,
                dark: crab.dark,
                x: Math.round(crab.x),
                dim: !crab.busy,
                animation: this._animationOf(crab),
                sprite: this._spriteOf(crab),
            });
        }
        return out;
    }

    _maxX() {
        return Math.max(0, this._width - SPRITE_W);
    }

    _placeAtHome(crab, count) {
        const maxX = this._maxX();
        crab.x = count <= 1 ? Math.round(maxX / 2) : Math.round(maxX * crab.home / (count - 1));
    }

    _clampAll() {
        const maxX = this._maxX();
        for (const crab of this._crabs.values())
            crab.x = Math.max(0, Math.min(maxX, crab.x));
    }
}
