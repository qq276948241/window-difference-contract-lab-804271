/**
 * Black-box tests for the `bin/pixelmatch` command-line interface, driven through real child
 * processes against offline PNG files. Every input PNG is generated into a fresh tmp directory
 * (or read from the checked-in fixtures), so the suite needs no network access and leaves no
 * files behind: the tmp dir is removed in an after hook.
 *
 * Exit codes follow the documented contract:
 *   0  images match
 *   64 wrong usage (missing arguments / unreadable file)
 *   65 dimensions do not match
 *   66 images differ
 *
 * Platform notes: the "matched in" timing line comes from console.time and its exact wording can
 * vary across Node releases/locales, so assertions only check the stable "different pixels" and
 * "error:" lines. Paths are passed as argv entries (never interpolated into a shell string).
 */

import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {PNG} from 'pngjs';
import match from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, '..', 'bin', 'pixelmatch');
const fixtures = path.join(here, 'fixtures');

/* ------------------------------------------------------------------ */
/* isolated tmp workspace (auto-cleaned, no leftover files)            */
/* ------------------------------------------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelmatch-cli-'));
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

/** Serialize a PNG image to a file inside the tmp workspace. */
function writePNG(name, width, height, draw) {
    const png = new PNG({width, height});
    if (draw) draw(png.data);
    const file = path.join(tmp, name);
    fs.writeFileSync(file, PNG.sync.write(png));
    return file;
}

/** Solid-color RGBA image bytes. */
function solid(width, height, [r, g, b, a]) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return data;
}

/** Run the CLI; never uses a shell, so arguments are passed verbatim. */
function runCLI(args) {
    const result = spawnSync(process.execPath, [binPath, ...args], {encoding: 'utf8'});
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr
    };
}

const fixture = name => path.join(fixtures, `${name}.png`);

/* ------------------------------------------------------------------ */
/* Usage errors: missing arguments and missing files (exit 64)         */
/* ------------------------------------------------------------------ */

test('CLI: no arguments prints usage and exits 64', () => {
    const {status, stdout} = runCLI([]);
    assert.equal(status, 64);
    assert.match(stdout, /Usage: pixelmatch/);
});

test('CLI: a single argument is still wrong usage and exits 64', () => {
    const {status} = runCLI([fixture('1a')]);
    assert.equal(status, 64);
});

test('CLI: a missing input file exits 64 and mentions the unreadable path', () => {
    const missing = path.join(tmp, 'does-not-exist.png');
    const {status, stdout} = runCLI([missing, fixture('1a')]);
    assert.equal(status, 64);
    // the CLI reports read failures on stdout alongside its other user-facing messages
    assert.match(stdout, /Cannot read image file/);
    assert.match(stdout, /does-not-exist\.png/);
    // nothing was written
    assert.ok(!fs.existsSync(path.join(tmp, 'out.png')));
});

test('CLI: a corrupt (non-PNG) input file exits 64', () => {
    const corrupt = path.join(tmp, 'corrupt.png');
    fs.writeFileSync(corrupt, Buffer.from('this is definitely not a PNG'));
    const {status, stdout} = runCLI([corrupt, fixture('1a')]);
    assert.equal(status, 64);
    assert.match(stdout, /Cannot read image file/);
});

/* ------------------------------------------------------------------ */
/* Dimension mismatch (exit 65)                                        */
/* ------------------------------------------------------------------ */

test('CLI: differently sized images report dimensions and exit 65', () => {
    const a = writePNG('size-a.png', 4, 3);
    const b = writePNG('size-b.png', 5, 3);
    const {status, stdout} = runCLI([a, b]);
    assert.equal(status, 65);
    assert.match(stdout, /Image dimensions do not match: 4x3 vs 5x3/);
});

test('CLI: dimension mismatch aborts before writing any diff output', () => {
    const a = writePNG('dim-a.png', 4, 4);
    const b = writePNG('dim-b.png', 4, 5);
    const out = path.join(tmp, 'dim-diff.png');
    const {status} = runCLI([a, b, out]);
    assert.equal(status, 65);
    assert.ok(!fs.existsSync(out), 'no diff file is produced on a dimension error');
});

/* ------------------------------------------------------------------ */
/* Identical images: exit 0, zero count, zero percent                  */
/* ------------------------------------------------------------------ */

test('CLI: identical images exit 0 and report zero differences', () => {
    const a = writePNG('same-a.png', 8, 8, data => data.set(solid(8, 8, [12, 99, 200, 255])));
    const b = writePNG('same-b.png', 8, 8, data => data.set(solid(8, 8, [12, 99, 200, 255])));
    const {status, stdout} = runCLI([a, b]);
    assert.equal(status, 0);
    assert.match(stdout, /different pixels: 0/);
    assert.match(stdout, /error: 0%/);
});

test('CLI: identical checked-in fixtures exit 0', () => {
    const {status, stdout} = runCLI([fixture('6a'), fixture('6a')]);
    assert.equal(status, 0);
    assert.match(stdout, /different pixels: 0/);
});

/* ------------------------------------------------------------------ */
/* Differing images: exit 66 and a count consistent with the API       */
/* ------------------------------------------------------------------ */

test('CLI: differing generated images exit 66 and match the API pixel count', () => {
    const width = 12, height = 9;
    const a = writePNG('gen-a.png', width, height,
        data => data.set(solid(width, height, [255, 255, 255, 255])));
    const blackCells = [[1, 1], [2, 1], [10, 8], [0, 0], [11, 4]];
    const b = writePNG('gen-b.png', width, height, (data) => {
        data.set(solid(width, height, [255, 255, 255, 255]));
        for (const [x, y] of blackCells) {
            const p = (y * width + x) * 4;
            data[p] = data[p + 1] = data[p + 2] = 0;
        }
    });

    // independent API reference on the exact decoded bytes
    const imgA = PNG.sync.read(fs.readFileSync(a));
    const imgB = PNG.sync.read(fs.readFileSync(b));
    const apiCount = match(imgA.data, imgB.data, null, width, height, {includeAA: true});
    assert.equal(apiCount, blackCells.length, 'API counts every hand-placed black cell');

    const {status, stdout} = runCLI([a, b]);
    assert.equal(status, 66);
    assert.match(stdout, new RegExp(`different pixels: ${apiCount}`));
    // percentage line uses round(100 * 100 * count / total) / 100
    const expectedPct = Math.round(100 * 100 * apiCount / (width * height)) / 100;
    assert.match(stdout, new RegExp(`error: ${expectedPct}%`));
});

test('CLI: fixture 1a vs 1b exits 66 and reports the documented 152 pixels', () => {
    const {status, stdout} = runCLI([fixture('1a'), fixture('1b'), '', '0.05']);
    assert.equal(status, 66);
    assert.match(stdout, /different pixels: 152/);
});

/* ------------------------------------------------------------------ */
/* Diff PNG output: decoded output agrees with the API pixel results   */
/* ------------------------------------------------------------------ */

test('CLI: written diff PNG decodes to the same pixels the API produces', () => {
    const width = 10, height = 6;
    const a = writePNG('out-a.png', width, height,
        data => data.set(solid(width, height, [200, 200, 200, 255])));
    const b = writePNG('out-b.png', width, height, (data) => {
        data.set(solid(width, height, [200, 200, 200, 255]));
        // one diff drawn with the default red diff color in mind
        const p = (3 * width + 4) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
    });
    const out = path.join(tmp, 'out-diff.png');

    const {status} = runCLI([a, b, out]);
    assert.equal(status, 66);
    assert.ok(fs.existsSync(out), 'diff PNG was written');

    // decode the CLI's output and compare byte-for-byte with a fresh in-process API diff
    const cliDiff = PNG.sync.read(fs.readFileSync(out));
    const imgA = PNG.sync.read(fs.readFileSync(a));
    const imgB = PNG.sync.read(fs.readFileSync(b));
    const apiDiff = new PNG({width, height});
    const count = match(imgA.data, imgB.data, apiDiff.data, width, height);
    assert.ok(cliDiff.data.equals(apiDiff.data),
        'decoded CLI diff pixels equal an in-process API diff image');
    assert.equal(cliDiff.width, width);
    assert.equal(cliDiff.height, height);

    // the differing cell is marked with the default diff color (red, opaque)
    const p = (3 * width + 4) * 4;
    assert.deepEqual([...cliDiff.data.slice(p, p + 4)], [255, 0, 0, 255]);
    assert.ok(count >= 1);
});

/* ------------------------------------------------------------------ */
/* Threshold: a subtle pair flips match/differ around the cutoff        */
/* ------------------------------------------------------------------ */

test('CLI: threshold argument changes the result for a subtle difference', () => {
    const width = 2, height = 2;
    // near-black step that the default threshold tolerates but threshold 0 catches
    const a = writePNG('thr-a.png', width, height,
        data => data.set(solid(width, height, [0, 0, 0, 255])));
    const b = writePNG('thr-b.png', width, height,
        data => data.set(solid(width, height, [1, 0, 0, 255])));

    // API reference for the same two thresholds
    const imgA = PNG.sync.read(fs.readFileSync(a));
    const imgB = PNG.sync.read(fs.readFileSync(b));
    assert.equal(match(imgA.data, imgB.data, null, width, height), 0, 'default threshold: equal');
    assert.equal(match(imgA.data, imgB.data, null, width, height, {threshold: 0}), 4,
        'threshold 0: every pixel differs');

    const relaxed = runCLI([a, b, '', '0.1']);
    assert.equal(relaxed.status, 0);
    assert.match(relaxed.stdout, /different pixels: 0/);

    const strict = runCLI([a, b, '', '0']);
    assert.equal(strict.status, 66);
    assert.match(strict.stdout, /different pixels: 4/);
});

/* ------------------------------------------------------------------ */
/* Transparency: alpha-only changes compared via the checkerboard       */
/* ------------------------------------------------------------------ */

test('CLI: semi-transparent pixels are distinguished through PNG round-trip', () => {
    const width = 1, height = 1;
    // visually identical on white but distinguishable on the checkerboard blend
    const a = writePNG('alpha-a.png', width, height,
        data => data.set(new Uint8Array([0, 0, 0, 128])));
    const b = writePNG('alpha-b.png', width, height,
        data => data.set(new Uint8Array([127, 127, 127, 255])));

    const imgA = PNG.sync.read(fs.readFileSync(a));
    const imgB = PNG.sync.read(fs.readFileSync(b));
    assert.equal(match(imgA.data, imgB.data, null, 1, 1), 1, 'default checkerboard: differs');
    assert.equal(match(imgA.data, imgB.data, null, 1, 1, {checkerboard: false}), 0,
        'white blend: equal (reference only; the CLI always uses the default)');

    const {status, stdout} = runCLI([a, b]);
    assert.equal(status, 66);
    assert.match(stdout, /different pixels: 1/);
});

/* ------------------------------------------------------------------ */
/* Anti-aliasing: includeAA flag changes the count                      */
/* ------------------------------------------------------------------ */

test('CLI: includeAA false ignores an anti-aliased ramp pixel, true counts it', () => {
    const width = 7, height = 5;
    const drawBase = (data) => {
        data.set(solid(width, height, [255, 255, 255, 255]));
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < 3; x++) {
                const p = (y * width + x) * 4;
                data[p] = data[p + 1] = data[p + 2] = 0;
            }
        }
    };
    const a = writePNG('aa-a.png', width, height, drawBase);
    const b = writePNG('aa-b.png', width, height, (data) => {
        drawBase(data);
        // gray ramp pixel next to the black block: detected as anti-aliasing
        const p = (2 * width + 3) * 4;
        data[p] = data[p + 1] = data[p + 2] = 128;
    });

    const imgA = PNG.sync.read(fs.readFileSync(a));
    const imgB = PNG.sync.read(fs.readFileSync(b));
    assert.equal(match(imgA.data, imgB.data, null, width, height), 0, 'AA excluded by the API');
    assert.equal(match(imgA.data, imgB.data, null, width, height, {includeAA: true}), 1,
        'AA included by the API');

    // CLI default (includeAA argument omitted): anti-aliasing ignored -> match, exit 0
    const excluded = runCLI([a, b]);
    assert.equal(excluded.status, 0);
    assert.match(excluded.stdout, /different pixels: 0/);

    // explicit includeAA=false behaves the same
    const explicitFalse = runCLI([a, b, '', '', 'false']);
    assert.equal(explicitFalse.status, 0);

    // includeAA=true counts the ramp pixel -> differ, exit 66
    const included = runCLI([a, b, '', '', 'true']);
    assert.equal(included.status, 66);
    assert.match(included.stdout, /different pixels: 1/);
});

/* ------------------------------------------------------------------ */
/* Direction colors: diffColorAlt requires API options the CLI lacks,   */
/* so this is verified on the decoded diff PNG via the API directly     */
/* ------------------------------------------------------------------ */

test('direction color: darker and lighter diffs get distinct output colors with diffColorAlt', () => {
    const width = 3, height = 1;
    const img1 = solid(width, height, [128, 128, 128, 255]);
    const img2 = new Uint8Array(img1);
    img2.set([0, 0, 0, 255], 0);       // img2 darker than img1 at x=0
    img2.set([255, 255, 255, 255], 8); // img2 lighter than img1 at x=2

    const diff = new Uint8Array(width * height * 4);
    const count = match(img1, img2, diff, width, height, {
        includeAA: true,
        diffColor: [255, 0, 0],
        diffColorAlt: [0, 255, 0]
    });
    assert.equal(count, 2);
    // darker change uses the alt color (green), lighter change the default (red)
    assert.deepEqual([...diff.slice(0, 4)], [0, 255, 0, 255], 'darker pixel uses diffColorAlt');
    assert.deepEqual([...diff.slice(8, 12)], [255, 0, 0, 255], 'lighter pixel uses diffColor');
    // the middle pixel is unchanged: not painted with either diff color
    assert.notDeepEqual([...diff.slice(4, 8)], [255, 0, 0, 255]);
    assert.notDeepEqual([...diff.slice(4, 8)], [0, 255, 0, 255]);
});
