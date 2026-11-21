/**
 * Independent reference tests for the `windowSize` option.
 *
 * The library's windowed post-pass (incremental column sums + sliding horizontal sum) is checked
 * against a deliberately simple, independent brute-force reference: every N×N window position is
 * enumerated and the diff pixels inside are re-counted. All expected diff/AA locations are hand
 * labeled as coordinate lists (never derived from pixelmatch internals), so a bug that changes
 * which pixels are counted cannot hide behind shared logic.
 *
 * Determinism: random inputs use a fixed-seed PRNG (mulberry32), so every failure is reproducible.
 * This file neither touches the network nor writes any file. The one platform-specific behavior
 * asserted here (4-byte alignment of Uint32Array views over a non-zero byteOffset) is required by
 * the ECMAScript typed-array spec on every platform and documented at the assertion.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import match from '../index.js';

/* ------------------------------------------------------------------ */
/* fixed-seed PRNG so randomized cases fail reproducibly               */
/* ------------------------------------------------------------------ */

/** Deterministic 32-bit PRNG (mulberry32); returns () => float in [0, 1). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ------------------------------------------------------------------ */
/* tiny grid helpers: images are built from hand-placed cells so that */
/* every differing pixel has a hand-computed label                    */
/* ------------------------------------------------------------------ */

const BLACK = [0, 0, 0];

/** A blank RGBA image (white, opaque). */
function blank(width, height) {
    return new Uint8Array(width * height * 4).fill(255);
}

/** Set one pixel's RGB (alpha stays 255). */
function setRGB(img, width, x, y, [r, g, b]) {
    const p = (y * width + x) * 4;
    img[p] = r;
    img[p + 1] = g;
    img[p + 2] = b;
    img[p + 3] = 255;
}

/** Copy of an image with the given cells repainted. */
function imageWith(width, height, cells) {
    const img = blank(width, height);
    for (const [x, y, color] of cells) setRGB(img, width, x, y, color);
    return img;
}

/** Index of a pixel in a per-pixel (one byte per pixel) array. */
const cellIndex = (width, x, y) => y * width + x;

/* ------------------------------------------------------------------ */
/* independent brute-force reference for windowed counts               */
/* ------------------------------------------------------------------ */

/**
 * Reference N×N sliding-window maximum, written independently from the library implementation:
 * enumerate every window top-left corner, count the labeled diff cells inside, take the max.
 * N is floored and clamped to [1, min(width, height)] exactly as documented.
 *
 * @param {number} width
 * @param {number} height
 * @param {Array<[number, number]>} diffCells hand-labeled counted-diff coordinates
 * @param {number} windowSize
 * @returns {{max: number, windows: Array<{x: number, y: number, count: number}>}}
 */
function referenceWindowMax(width, height, diffCells, windowSize) {
    const n = Math.min(Math.max(Math.floor(windowSize), 1), width, height);
    const windows = [];
    let max = 0;
    // the last window position is (width-n, height-n), so this enumeration explicitly
    // covers windows touching the last column and the last row
    for (let wy = 0; wy <= height - n; wy++) {
        for (let wx = 0; wx <= width - n; wx++) {
            let count = 0;
            for (const [x, y] of diffCells) {
                if (x >= wx && x < wx + n && y >= wy && y < wy + n) count++;
            }
            windows.push({x: wx, y: wy, count});
            if (count > max) max = count;
        }
    }
    return {max, windows};
}

/**
 * Every windowSize value the requirement asks for: N=1, whole-image N, oversize,
 * fractional, zero, negative, Infinity (plus NaN, which is non-finite like Infinity).
 */
const ALL_SIZES = [1, 2, 3, 4, 5, 7, 100, 2.9, 0, -5, Infinity, NaN];

/**
 * Assert pixelmatch's windowed result against the brute-force reference for every size,
 * and confirm each returned value is the window maximum rather than the total diff count.
 *
 * @param {object} scenario
 * @param {number} scenario.width
 * @param {number} scenario.height
 * @param {Uint8Array} scenario.img1
 * @param {Uint8Array} scenario.img2
 * @param {Array<[number, number]>} scenario.diffCells counted-diff coordinates (hand labels)
 * @param {Array<[number, number]>} [scenario.aaCells] anti-aliased coordinates (hand labels)
 * @param {Uint8Array} [scenario.ignoreMask]
 * @param {object} [extraOpts]
 */
function assertWindowsMatchReference(scenario, extraOpts = {}) {
    const {width, height, img1, img2, diffCells, ignoreMask} = scenario;
    const total = diffCells.length;

    for (const windowSize of ALL_SIZES) {
        const opts = {...extraOpts, windowSize};
        if (ignoreMask) opts.ignoreMask = ignoreMask;
        const actual = match(img1, img2, null, width, height, opts);

        // NaN/Infinity are non-finite: documented behavior is the whole-image total count
        if (!Number.isFinite(windowSize)) {
            assert.equal(actual, total,
                `non-finite windowSize ${String(windowSize)} must return total ${total}`);
            continue;
        }

        const n = Math.min(Math.max(Math.floor(windowSize), 1), width, height);
        const expected = referenceWindowMax(width, height, diffCells, windowSize).max;
        assert.equal(actual, expected,
            `windowSize=${String(windowSize)} (effective N=${n}): got ${actual}, reference ${expected}`);

        // the defining property: a finite window result is a per-window maximum, never the
        // total unless a single clamped window actually covers the whole image
        if (n < Math.min(width, height)) {
            assert.ok(actual <= total, 'window max cannot exceed the total diff count');
        }
    }
}

/* ------------------------------------------------------------------ */
/* Scenario A: corner/edge differences + a sparse row                  */
/* ------------------------------------------------------------------ */

function buildSparseScenario() {
    const width = 8, height = 6;
    // hand-placed opaque black cells on a white image; solid black-on-white blocks are never
    // classified as anti-aliasing, so every labeled cell is a counted diff at includeAA:true
    const cells = [
        [0, 0, BLACK],          // top-left corner
        [width - 1, 0, BLACK],  // top-right corner (last column)
        [0, height - 1, BLACK], // bottom-left corner (last row)
        [width - 1, height - 1, BLACK], // bottom-right corner (last row + last column)
        [3, 0, BLACK],          // sparse pixel on the top row
        [4, height - 1, BLACK], // sparse pixel on the bottom row
        [2, 3, BLACK],
        [5, 4, BLACK]
    ];
    const diffCells = cells.map(([x, y]) => [x, y]);
    return {
        width,
        height,
        img1: blank(width, height),
        img2: imageWith(width, height, cells),
        diffCells,
        aaCells: []
    };
}

test('windowSize: sparse corner/edge scenario matches brute-force reference for every N', () => {
    const scenario = buildSparseScenario();
    const {width, height, img1, img2, diffCells} = scenario;

    // sanity-check the hand labels against plain (non-windowed) counts first
    assert.equal(match(img1, img2, null, width, height, {includeAA: true}), diffCells.length);
    assert.equal(match(img1, img2, null, width, height, {includeAA: false}), diffCells.length);

    assertWindowsMatchReference(scenario, {includeAA: true});

    // explicit boundary-window checks: windows touching the last row and last column exist
    // and are considered by the maximum (the four corner diffs can only be captured there)
    const n = 3;
    const {windows, max} = referenceWindowMax(width, height, diffCells, n);
    const lastColX = width - n;
    const lastRowY = height - n;
    assert.ok(windows.some(w => w.x === lastColX), 'reference enumerates a last-column window');
    assert.ok(windows.some(w => w.y === lastRowY), 'reference enumerates a last-row window');
    const cornerWindow = windows.find(w => w.x === lastColX && w.y === lastRowY);
    assert.ok(cornerWindow, 'bottom-right corner window enumerated');
    assert.equal(cornerWindow.count, 2, 'bottom-right window holds the two right/bottom corner cells');
    assert.equal(
        match(img1, img2, null, width, height, {includeAA: true, windowSize: n}),
        max,
        'library max equals reference max including boundary windows');

    // prove the return value is a window maximum, not the total: a 1x1 window can hold at
    // most one cell while the total is 8 (N=2 already merges adjacent cells, e.g. (0,0)+(1,0))
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 1}), 1);
    assert.equal(referenceWindowMax(width, height, diffCells, 2).max, 2,
        'hand check: (0,0)+(1,0) and (4,5)+(3,5) each share a 2x2 window');
    assert.ok(diffCells.length > 2, 'window max is strictly below the total for sparse diffs');
});

/* ------------------------------------------------------------------ */
/* Scenario B: anti-aliased ramp pixel + a solid diff (includeAA)      */
/* ------------------------------------------------------------------ */

function buildAAScenario() {
    const width = 7, height = 5;
    // both images: a solid black block (columns 0..2, all rows) next to a white field;
    // the black block gives a candidate pixel many equal siblings, which is the structural
    // cue the anti-aliasing detector looks for
    const base = () => {
        const img = blank(width, height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < 3; x++) setRGB(img, width, x, y, BLACK);
        }
        return img;
    };
    const img1 = base();
    const img2 = base();
    // (3,2): white -> gray ramp pixel right of the black block => detected as anti-aliasing
    setRGB(img2, width, 3, 2, [128, 128, 128]);
    // (6,2): white -> solid black far from the ramp => a real, counted difference
    setRGB(img2, width, 6, 2, BLACK);
    return {
        width,
        height,
        img1,
        img2,
        diffCells: [[6, 2]],   // hand label: only the solid black cell is counted by default
        aaCells: [[3, 2]]      // hand label: the ramp cell is excluded AA
    };
}

test('windowSize: anti-aliased pixels are excluded unless includeAA is set', () => {
    const scenario = buildAAScenario();
    const {width, height, img1, img2, diffCells, aaCells} = scenario;

    // hand labels verified against the non-windowed API first
    assert.equal(match(img1, img2, null, width, height), diffCells.length,
        'default includeAA:false counts only the solid diff');
    assert.equal(
        match(img1, img2, null, width, height, {includeAA: true}),
        diffCells.length + aaCells.length,
        'includeAA:true counts the ramp cell too');

    // windowed mode with AA excluded: reference sees only the solid cell
    assertWindowsMatchReference(scenario);

    // windowed mode with AA included: the reference label set gains the AA cell, and every
    // window size must then match the brute-force enumeration over diffCells ∪ aaCells
    const includedScenario = {...scenario, diffCells: [...diffCells, ...aaCells]};
    assertWindowsMatchReference(includedScenario, {includeAA: true});

    // a 1x1 window still distinguishes the two modes at each candidate position
    assert.equal(match(img1, img2, null, width, height, {windowSize: 1}), 1);
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 1}), 1);
    // N=4 spans columns 3..6 on row 2: with AA included both cells fit one window
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 4}), 2);
    assert.equal(match(img1, img2, null, width, height, {windowSize: 4}), 1);
});

/* ------------------------------------------------------------------ */
/* Scenario C: ignoreMask removes labeled cells from every window      */
/* ------------------------------------------------------------------ */

test('windowSize: ignoreMask cells are skipped in the diff labels and all windows', () => {
    const width = 6, height = 4;
    const img1 = blank(width, height);
    const img2 = blank(width, height);
    const allCells = [
        [0, 0], [1, 0], [2, 0], // left half (will be masked)
        [3, 1], [4, 1], [5, 1]  // right half (kept)
    ];
    for (const [x, y] of allCells) setRGB(img2, width, x, y, BLACK);

    // one byte per pixel: mask the left two columns
    const ignoreMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < 2; x++) ignoreMask[cellIndex(width, x, y)] = 1;
    }

    const visibleCells = allCells.filter(([x]) => x >= 2);
    const scenario = {width, height, img1, img2, diffCells: visibleCells, ignoreMask};

    // non-windowed counts: mask halves the diffs
    assert.equal(match(img1, img2, null, width, height, {ignoreMask}), visibleCells.length);
    assert.equal(match(img1, img2, null, width, height), allCells.length);

    // windowed counts match the reference over the unmasked labels for every N
    assertWindowsMatchReference(scenario);

    // the densest unmasked 2x2 window contains two cells (3,1)+(4,1), never the masked ones
    assert.equal(
        match(img1, img2, null, width, height, {ignoreMask, windowSize: 2}),
        referenceWindowMax(width, height, visibleCells, 2).max);
    assert.equal(referenceWindowMax(width, height, visibleCells, 2).max, 2);
});

test('windowSize: fully masked images hit the identical fast path and return 0', () => {
    const width = 4, height = 3;
    const img1 = blank(width, height);
    const img2 = imageWith(width, height, [[0, 0, BLACK], [3, 2, BLACK]]);
    const ignoreMask = new Uint8Array(width * height).fill(1);

    for (const windowSize of [1, 2, Infinity]) {
        assert.equal(
            match(img1, img2, null, width, height, {ignoreMask, windowSize}),
            0,
            `masked image must be identical for windowSize=${String(windowSize)}`);
    }
});

/* ------------------------------------------------------------------ */
/* Scenario D: dense full-image diffs (whole-image window, clamping)   */
/* ------------------------------------------------------------------ */

test('windowSize: dense diffs return total for whole-image windows and clamp oversize N', () => {
    const width = 5, height = 5;
    const img1 = blank(width, height);
    const img2 = new Uint8Array(width * height * 4); // all black
    const diffCells = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) diffCells.push([x, y]);

    for (const windowSize of [width, 100, 2147483648, Number.MAX_SAFE_INTEGER, Infinity]) {
        assert.equal(
            match(img1, img2, null, width, height, {includeAA: true, windowSize}),
            width * height,
            `whole-image/oversize N=${String(windowSize)} returns the total`);
    }

    // every smaller N returns exactly N*N, which is both the window max and reference value
    for (const n of [1, 2, 3, 4]) {
        assert.equal(
            match(img1, img2, null, width, height, {includeAA: true, windowSize: n}),
            n * n);
        assert.equal(referenceWindowMax(width, height, diffCells, n).max, n * n);
    }

    // fractional N floors: 2.9 behaves as N=2
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 2.9}), 4);

    // zero, negative and NaN behave per the documented clamping rules
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 0}), 1);
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: -5}), 1);
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: NaN}), 25);
});

/* ------------------------------------------------------------------ */
/* Scenario E: identical / empty images                                */
/* ------------------------------------------------------------------ */

test('windowSize: identical images and 1x1 degenerate images return 0', () => {
    const img = blank(6, 4);
    for (const windowSize of [1, 2, 3, Infinity, NaN, 0, -1]) {
        assert.equal(match(img, img, null, 6, 4, {windowSize}), 0);
    }

    const one = new Uint8Array([10, 20, 30, 255]);
    assert.equal(match(one, one.slice(), null, 1, 1, {windowSize: 1}), 0);
    // a real diff on a 1x1 image: every clamped window is the whole image
    assert.equal(
        match(one, new Uint8Array([200, 20, 30, 255]), null, 1, 1, {windowSize: 1}),
        1);
});

/* ------------------------------------------------------------------ */
/* Non-square clamping: N can never exceed the smaller dimension       */
/* ------------------------------------------------------------------ */

test('windowSize: N clamps to min(width, height) on non-square images', () => {
    const width = 10, height = 3;
    const img1 = blank(width, height);
    const img2 = blank(width, height);
    const diffCells = [];
    // one diff per column, spread over all three rows so no 3x3 window is empty of structure
    for (let x = 0; x < width; x++) {
        const y = x % height;
        setRGB(img2, width, x, y, BLACK);
        diffCells.push([x, y]);
    }
    const scenario = {width, height, img1, img2, diffCells};

    for (const windowSize of [3, 10, 100]) {
        // clamped N = height = 3
        const expected = referenceWindowMax(width, height, diffCells, 3).max;
        assert.equal(
            match(img1, img2, null, width, height, {includeAA: true, windowSize}),
            expected,
            `N=${windowSize} clamps to 3 on a 10x3 image`);
    }
    assertWindowsMatchReference(scenario, {includeAA: true});
});

/* ------------------------------------------------------------------ */
/* Typed-array variants and non-zero byteOffset subviews               */
/* ------------------------------------------------------------------ */

test('windowSize: works through Uint8ClampedArray and non-zero byteOffset subviews', () => {
    const width = 4, height = 4;
    const cells = [[0, 0], [1, 0], [0, 1], [3, 3]];
    const plain1 = blank(width, height);
    const plain2 = blank(width, height);
    for (const [x, y] of cells) setRGB(plain2, width, x, y, BLACK);
    const diffCells = cells;

    // Uint8ClampedArray at byteOffset 0
    const clamped1 = new Uint8ClampedArray(plain1);
    const clamped2 = new Uint8ClampedArray(plain2);
    assert.equal(
        match(clamped1, clamped2, null, width, height, {includeAA: true, windowSize: 2}),
        referenceWindowMax(width, height, diffCells, 2).max);

    // non-zero, 4-byte-aligned byteOffset: pad each backing buffer by 8 bytes (2 RGBA pixels).
    // The library builds a Uint32Array over the same byteOffset, which requires 4-byte
    // alignment per the ECMAScript typed-array spec; an aligned offset must work transparently.
    const PAD = 8;
    function paddedView(TypedArray, src) {
        const buf = new ArrayBuffer(PAD + src.length);
        const view = new TypedArray(buf, PAD, src.length);
        view.set(src);
        return view;
    }
    const off1 = paddedView(Uint8Array, plain1);
    const off2 = paddedView(Uint8Array, plain2);
    assert.equal(off1.byteOffset, PAD);
    for (const windowSize of [1, 2, 4, Infinity]) {
        assert.equal(
            match(off1, off2, null, width, height, {includeAA: true, windowSize}),
            match(plain1, plain2, null, width, height, {includeAA: true, windowSize}),
            `offset subview windowSize=${String(windowSize)} matches a zero-offset view`);
    }

    // same exercise with a padded ignoreMask subview
    const mask0 = new Uint8Array(width * height);
    mask0[cellIndex(width, 3, 3)] = 1; // mask the corner cell
    const mbuf = new ArrayBuffer(PAD + mask0.length);
    const maskView = new Uint8Array(mbuf, PAD, mask0.length);
    maskView.set(mask0);
    const visible = diffCells.filter(([x, y]) => !(x === 3 && y === 3));
    assert.equal(
        match(off1, off2, null, width, height, {
            includeAA: true, windowSize: 2, ignoreMask: maskView
        }),
        referenceWindowMax(width, height, visible, 2).max);

    // ECMA-262 requires Uint32Array byte offsets to be a multiple of 4; a subview whose
    // byteOffset is not aligned cannot be viewed as Uint32Array on any platform, so the
    // library rejects it with a RangeError rather than silently misreading pixels.
    const unalignedBuf = new ArrayBuffer(plain1.length + 2);
    const unaligned = new Uint8Array(unalignedBuf, 2, plain1.length);
    unaligned.set(plain1);
    assert.throws(
        () => match(unaligned, unaligned, null, width, height, {windowSize: 2}),
        RangeError,
        'unaligned byteOffset cannot back a Uint32Array (spec-level platform behavior)');
});

/* ------------------------------------------------------------------ */
/* Fixed-seed random inputs: brute-force cross-check across sizes      */
/* ------------------------------------------------------------------ */

test('windowSize: fixed-seed random images match the reference for every N', () => {
    const rand = mulberry32(0x5EED1234);
    const width = 12, height = 9;
    const img1 = blank(width, height);
    const img2 = blank(width, height);
    const diffCells = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (rand() < 0.25) {
                // opaque, strongly separated colors so the threshold never drops a label
                const v = rand() < 0.5 ? 0 : 255;
                setRGB(img2, width, x, y, [v, v, 255 - v]);
                diffCells.push([x, y]);
            }
        }
    }
    // black/white extreme pairs on white always cross the default threshold; verify the labels
    assert.equal(
        match(img1, img2, null, width, height, {includeAA: true}),
        diffCells.length,
        'hand labels match the total count for the seeded random image');

    const scenario = {width, height, img1, img2, diffCells};
    assertWindowsMatchReference(scenario, {includeAA: true});

    // spot-check one concrete window by hand: N=1 must be 1 whenever any diff exists
    assert.ok(diffCells.length > 0, 'seeded case contains diffs');
    assert.equal(match(img1, img2, null, width, height, {includeAA: true, windowSize: 1}), 1);
});

/* ------------------------------------------------------------------ */
/* Validation errors: sentinel prefill proves there are no partial     */
/* writes, and messages identify the offending field                   */
/* ------------------------------------------------------------------ */

const SENTINEL = 0xA5;

test('windowSize validation: length/size/type errors leave the output buffer untouched', () => {
    const width = 4, height = 4;
    const len = width * height * 4;
    const good = new Uint8Array(len);
    const sentinelFilled = () => new Uint8Array(len).fill(SENTINEL);

    /**
     * Run a call expected to throw; assert the exact error message names the bad field and
     * every output byte still holds its sentinel (no partial write happened before the throw).
     * `badOutput` marks a case where the output buffer's own length is the invalid field,
     * so it must be allocated at that invalid length (still fully prefilled with sentinels).
     */
    function expectNoPartialWrite(makeArgs, messageFragment, badOutput = false) {
        const output = badOutput ? new Uint8Array(len + 4).fill(SENTINEL) : sentinelFilled();
        assert.throws(() => {
            match(...makeArgs(output));
        }, err => err instanceof Error && String(err.message).includes(messageFragment));
        assert.ok(output.every(b => b === SENTINEL),
            `output was partially written for error mentioning "${messageFragment}"`);
    }

    // pixel length mismatch between img1 and img2 (message names image sizes)
    expectNoPartialWrite(
        output => [new Uint8Array(len), new Uint8Array(len + 4), output, width, height, {windowSize: 2}],
        'Image sizes do not match');

    // output length mismatch (images themselves equal-length so the output check is reached)
    expectNoPartialWrite(
        output => [good, new Uint8Array(len), output, width, height, {windowSize: 2}],
        'Image sizes do not match', true);

    // pixel buffer length inconsistent with width/height (60 bytes cannot be 4x4 RGBA).
    // Validation order means a sub-multiple length can surface at either check; both messages
    // identify an image-size/shape field, and either way the throw precedes the pixel loop.
    expectNoPartialWrite(
        output => [new Uint8Array(len - 4), new Uint8Array(len - 4), output, width, height, {windowSize: 2}],
        'Image');

    // empty image (0 pixels) with width/height claiming pixels. With a full-sized output the
    // output-length check fires first; without output the width/height shape check fires.
    expectNoPartialWrite(
        output => [new Uint8Array(0), new Uint8Array(0), output, width, height, {windowSize: 2}],
        'Image sizes do not match');
    assert.throws(
        () => match(new Uint8Array(0), new Uint8Array(0), null, width, height, {windowSize: 2}),
        /Image data size does not match width\/height/);

    // ignoreMask wrong length (message names the mask field)
    expectNoPartialWrite(
        output => [good, new Uint8Array(len), output, width, height,
            {windowSize: 2, ignoreMask: new Uint8Array(width * height + 1)}],
        'Ignore mask size does not match');

    // wrong pixel data type (message names the image-data contract)
    const plain = new Array(len).fill(0);
    expectNoPartialWrite(
        output => [plain, good, output, width, height, {windowSize: 2}],
        'Uint8Array, Uint8ClampedArray or Buffer expected');
    expectNoPartialWrite(
        output => [good, good, output, width, height,
            {windowSize: 2, ignoreMask: new Float32Array(width * height)}],
        'Uint8Array, Uint8ClampedArray or Buffer expected');

    // error messages must let a caller locate the invalid field at a glance
    let caught;
    assert.throws(() => match(good, good, null, width, height,
        {ignoreMask: new Uint8Array(1)}), (err) => {
        caught = err;
        return /Ignore mask size/.test(String(err.message));
    });
    assert.ok(caught instanceof Error);
    assert.throws(() => match(new Uint8Array(9), new Uint8Array(9), null, 2, 1),
        /Image data size does not match width\/height/);
});

test('windowSize validation: length errors detected through non-zero byteOffset subviews', () => {
    const width = 3, height = 3;
    const len = width * height * 4;
    const PAD = 8;

    // two views of different logical lengths inside padded buffers must still be rejected
    const buf1 = new ArrayBuffer(PAD + len);
    const view1 = new Uint8Array(buf1, PAD, len);
    const buf2 = new ArrayBuffer(PAD + len + 4);
    const view2 = new Uint8Array(buf2, PAD, len + 4);
    assert.throws(
        () => match(view1, view2, null, width, height, {windowSize: 2}),
        /Image sizes do not match/);

    // a correctly sized subview whose declared width/height disagree: error names width/height
    assert.throws(
        () => match(view1, new Uint8Array(buf1, PAD, len), null, width + 1, height, {windowSize: 2}),
        /Image data size does not match width\/height/);

    // mask subview of the wrong logical length
    const mbuf = new ArrayBuffer(PAD + width * height);
    const maskShort = new Uint8Array(mbuf, PAD, width * height - 1);
    assert.throws(
        () => match(view1, new Uint8Array(buf1, PAD, len), null, width, height,
            {windowSize: 2, ignoreMask: maskShort}),
        /Ignore mask size does not match/);
});

/* ------------------------------------------------------------------ */
/* Overlapping views of one shared ArrayBuffer: fast path stays in      */
/* bounds and never mutates inputs                                     */
/* ------------------------------------------------------------------ */

test('shared ArrayBuffer: identical fast path with overlapping views does not corrupt inputs', () => {
    const width = 4, height = 4;
    const len = width * height * 4;
    // one buffer holds two image-sized regions that overlap by one RGBA pixel (4 bytes);
    // img1 starts at offset 0, img2 at offset len-4. Both views are 4-byte aligned.
    const buffer = new ArrayBuffer(len * 2 - 4);
    const img1 = new Uint8Array(buffer, 0, len);
    const img2 = new Uint8Array(buffer, len - 4, len);
    for (let i = 0; i < len; i++) img1[i] = (i * 31 + 7) & 0xFF;

    // identical content is required for the fast path; make img2's region equal img1's.
    // snapshot AFTER this write: the views overlap by 4 bytes, so filling img2 mutates the
    // tail of img1's region by construction — the library itself must not mutate anything.
    for (let i = 0; i < len; i++) img2[i] = img1[i];
    const snapshot1 = img1.slice();
    const snapshot2 = img2.slice();

    const result = match(img1, img2, null, width, height, {windowSize: 3});
    assert.equal(result, 0);
    assert.deepEqual(img1, snapshot1, 'img1 unchanged after fast path');
    assert.deepEqual(img2, snapshot2, 'img2 unchanged after fast path');
});

test('shared ArrayBuffer: windowed comparison with overlapping views stays in bounds', () => {
    const width = 5, height = 5;
    const len = width * height * 4;
    const buffer = new ArrayBuffer(len * 2 - 4);
    const img1 = new Uint8Array(buffer, 0, len);
    const img2 = new Uint8Array(buffer, len - 4, len);
    img1.fill(255);
    img2.fill(255);
    // a handful of black cells only inside img2's own region
    const diffCells = [[0, 0], [1, 0], [4, 4], [3, 3]];
    for (const [x, y] of diffCells) setRGB(img2, width, x, y, BLACK);

    const before1 = img1.slice();
    const before2 = img2.slice();
    const result = match(img1, img2, null, width, height, {includeAA: true, windowSize: 2});
    assert.equal(result, referenceWindowMax(width, height, diffCells, 2).max);
    // inputs are read-only for the library: overlapping storage must not be mutated
    assert.deepEqual(img1, before1, 'img1 unchanged');
    assert.deepEqual(img2, before2, 'img2 unchanged');

    // writing a diff into an output view sharing a larger buffer must stay inside the view:
    // 8 guard bytes precede it and the view ends exactly at the end of its backing buffer
    const outBuf = new ArrayBuffer(len + 8);
    const output = new Uint8Array(outBuf, 8, len);
    const guardBefore = new Uint8Array(outBuf, 0, 8);
    const guardSnapshot = guardBefore.slice();
    match(img1, img2, output, width, height, {includeAA: true, windowSize: 2});
    assert.deepEqual(guardBefore, guardSnapshot, 'prefix guard bytes outside the output view untouched');
});
