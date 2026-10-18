/* Run from the Deepnest repository root after npm install: node tests/toolpath.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DEEPNEST_REPO || process.cwd();
const deps = process.env.DEEPNEST_DEPS || root;
const ts = require(path.join(deps, 'node_modules/typescript'));

const src = fs.readFileSync(path.join(root, 'main/ui/utils/toolpath.ts'), 'utf8').replace(/^import .*;\s*$/mg, '');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { module: mod, exports: mod.exports, Math });
const { buildToolpath, segmentIndexAt, positionAt: pos } = mod.exports;
// objects built inside the vm context have a different prototype; copy them for deepEqual
const positionAt = (tp, t) => ({ ...pos(tp, t) });

// closed square starting at (2,0): rapid from origin, then 4 cuts back to the start
const square = { points: [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 }], closed: true };
const tp = buildToolpath([square]);
assert.deepEqual([...tp.segments.map((s) => s.cut)], [false, true, true, true, true]);
// rapid 2 units at 4x speed = 0.5, then 4 units of cutting
assert.equal(tp.duration, 4.5);
// the closing cut returns to the start point
const last = tp.segments[4];
assert.deepEqual([last.x1, last.y1], [2, 0]);
// segments are contiguous in time and space
tp.segments.slice(1).forEach((s, i) => {
  const p = tp.segments[i];
  assert.equal(s.t0, p.t1);
  assert.deepEqual([s.x0, s.y0], [p.x1, p.y1]);
});

// position along the time axis
assert.deepEqual(positionAt(tp, 0), { x: 0, y: 0 });
assert.deepEqual(positionAt(tp, 0.5), { x: 2, y: 0 });
assert.deepEqual(positionAt(tp, 1), { x: 2.5, y: 0 });
assert.deepEqual(positionAt(tp, 999), { x: 2, y: 0 });
assert.equal(segmentIndexAt(tp, 0), 0);
assert.equal(segmentIndexAt(tp, 1), 1);
assert.equal(segmentIndexAt(tp, 999), 4);

// custom rapid speed
assert.equal(buildToolpath([{ points: [{ x: 1, y: 0 }, { x: 2, y: 0 }], closed: false }], 1).duration, 2);

// skipped / zero-length input
assert.equal(buildToolpath([{ points: [{ x: 1, y: 1 }], closed: true }]).segments.length, 0);
assert.equal(buildToolpath([{ points: [{ x: 0, y: 0 }, { x: 0, y: 0 }], closed: false }]).segments.length, 0);
assert.equal(segmentIndexAt({ segments: [], duration: 0 }, 1), -1);
assert.deepEqual(positionAt({ segments: [], duration: 0 }, 1), { x: 0, y: 0 });

console.log('toolpath tests passed');
