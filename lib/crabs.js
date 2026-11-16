// Claude crabs: pixel-art sprite and behaviour model (no drawing here).
// Pure module, no imports: testable with plain gjs. The indicator paints the
// rectangles returned by crabPixels() on a St.DrawingArea.

export const PIXEL = 2;               // logical px per sprite pixel
export const GRID_W = 11;
export const GRID_H = 7;
export const SPRITE_W = GRID_W * PIXEL; // 22
export const SPRITE_H = GRID_H * PIXEL; // 14
export const CRAB_SLOT = 24;          // preferred width per crab in the panel
export const CRAB_MIN_STEP = 14;      // min distance between crab homes when cramped
export const FPS = 8;

// Tones of Claude orange drifting to red.
export const PALETTE = [
    '#d97757', '#e0835e', '#cc6b4a', '#d4603f',
    '#c75438', '#db6a4b', '#bf4a33', '#e28f6a',
];
export const EYE_COLOR = '#2a1610';

const BEHAVIOURS = ['walk', 'walk', 'dance', 'claws', 'pause'];

/** Stable palette index for a session id. */
export function colorFor(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return PALETTE[(h >>> 0) % PALETTE.length];
}

/*
 *    0 1 2 3 4 5 6 7 8 9 10
 * 0      B B B B B B B
 * 1  ^   B E B B B E B   ^     ^ raised arm
 * 2  ^   B E B B B E B   ^     E eyes (row 2 only when closed)
 * 3  C C B B B B B B B C C     C arm (down)
 * 4      B B B B B B B
 * 5      L   L   L   L         legs
 * 6      L   L   L   L         (alternate pairs lift while walking)
 */

/**
 * Sprite pixels for a pose, in grid units.
 * @param {{leftUp?: boolean, rightUp?: boolean, legs?: 0|1|null, eyesOpen?: boolean}} pose
 * @returns {{body: Array<[number, number]>, eyes: Array<[number, number]>}} [col, row] pairs
 */
export function crabPixels(pose = {}) {
    const {leftUp = false, rightUp = false, legs = null, eyesOpen = true} = pose;
    const body = [];
    const eyes = [];
    const eyeCols = [3, 7];

    for (let row = 0; row <= 4; row++) {
        for (let col = 2; col <= 8; col++) {
            const isEye = eyeCols.includes(col) && (row === 2 || (row === 1 && eyesOpen));
            (isEye ? eyes : body).push([col, row]);
        }
    }

    // Arms: down = two pixels beside the body; up = shoulder + raised claw.
    if (leftUp)
        body.push([1, 3], [0, 2], [0, 1]);
    else
        body.push([0, 3], [1, 3]);
    if (rightUp)
        body.push([9, 3], [10, 2], [10, 1]);
    else
        body.push([9, 3], [10, 3]);

    // Legs: pairs (2, 6) and (4, 8); in phase p, the other pair is lifted.
    for (const col of [2, 4, 6, 8]) {
        body.push([col, 5]);
        const pair = col === 2 || col === 6 ? 0 : 1;
        if (legs === null || legs === pair)
            body.push([col, 6]);
    }
    return {body, eyes};
}

function randInt(rand, min, max) {
    return min + Math.floor(rand() * (max - min + 1));
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

    /** True when at least one crab is moving (an animation timer is needed). */
    get animating() {
        for (const crab of this._crabs.values()) {
            if (crab.busy)
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
                crab = {
                    id: s.id,
                    color: colorFor(s.id),
                    x: 0,
                    home: index,
                    dir: this._rand() < 0.5 ? -1 : 1,
                    behaviour: 'pause',
                    left: 0,
                    tick: 0,
                    busy: false,
                };
                this._crabs.set(s.id, crab);
                changed = true;
            }
            crab.home = index;
            if (s.busy && !crab.busy)
                crab.left = 0; // pick a behaviour on the next step
            crab.busy = Boolean(s.busy);
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

    /** Advance one animation frame. */
    step() {
        const maxX = this._maxX();
        for (const crab of this._crabs.values()) {
            if (!crab.busy)
                continue;
            crab.tick++;
            if (crab.left <= 0) {
                crab.behaviour = BEHAVIOURS[randInt(this._rand, 0, BEHAVIOURS.length - 1)];
                crab.left = crab.behaviour === 'pause'
                    ? randInt(this._rand, FPS / 2, FPS * 1.5)
                    : randInt(this._rand, FPS * 2, FPS * 5);
                if (crab.behaviour === 'walk' && this._rand() < 0.5)
                    crab.dir = -crab.dir;
            }
            crab.left--;

            if (crab.behaviour === 'walk' && maxX > 0) {
                crab.x += crab.dir;
                if (crab.x <= 0 || crab.x >= maxX) {
                    crab.x = Math.max(0, Math.min(maxX, crab.x));
                    crab.dir = -crab.dir;
                }
            }
        }
    }

    /**
     * Drawable state of every crab, back to front.
     * @returns {Array<{id, color, x, y, dim, pose}>} y = vertical offset in px (negative = up)
     */
    frames() {
        const out = [];
        for (const crab of this._crabs.values()) {
            const t = crab.tick;
            let pose = {eyesOpen: true, legs: null};
            let y = 0;
            if (!crab.busy) {
                pose = {eyesOpen: false, legs: null};
            } else {
                switch (crab.behaviour) {
                case 'walk':
                    pose.legs = t % 2;
                    break;
                case 'dance': {
                    const beat = Math.floor(t / 2) % 2;
                    pose.leftUp = beat === 0;
                    pose.rightUp = beat === 1;
                    pose.legs = beat;
                    y = beat === 0 ? -1 : 0;
                    break;
                }
                case 'claws': {
                    const snap = Math.floor(t / 2) % 2 === 0;
                    pose.leftUp = snap;
                    pose.rightUp = snap;
                    break;
                }
                default:
                    break;
                }
            }
            out.push({id: crab.id, color: crab.color, x: Math.round(crab.x), y, dim: !crab.busy, pose});
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
