/* Run from the Deepnest repository root after npm install: node tests/path-order.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DEEPNEST_REPO || process.cwd();
const deps = process.env.DEEPNEST_DEPS || root;
const ts = require(path.join(deps, 'node_modules/typescript'));

const src = fs.readFileSync(path.join(root, 'main/ui/utils/path-order.ts'), 'utf8').replace(/^import .*;\s*$/mg, '');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { module: mod, exports: mod.exports, Math, Infinity });
const { optimizePathOrder, travelDistance } = mod.exports;
// arrays built inside the vm context have a different prototype; copy them for deepEqual
const plain = (v) => JSON.parse(JSON.stringify(v));

const square = (x, y, s, closed = true) => ({
  points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }],
  closed,
});
const start = { x: 0, y: 0 };

// squares given in a zig-zag order: the optimized order travels less and keeps every path
const bad = [square(100, 0, 10), square(0, 0, 10), square(110, 0, 10), square(10, 0, 10)];
const good = optimizePathOrder(bad, start);
assert.equal(good.length, 4);
assert(travelDistance(good, start) < travelDistance(bad, start));
assert.deepEqual(
  plain(good.map((p) => p.points.length)),
  [4, 4, 4, 4]
);
// same set of vertices (only rotation/order changed)
const key = (p) => JSON.stringify(p.points.map((q) => [q.x, q.y]).sort());
assert.deepEqual(plain(good.map(key).sort()), plain(bad.map(key).sort()));

// closed path is rotated to start at the vertex nearest the tool
const far = optimizePathOrder([square(50, 50, 10)], { x: 60, y: 60 });
assert.deepEqual(plain(far[0].points[0]), { x: 60, y: 60 });
assert.equal(far[0].closed, true);

// open path is reversed when its far end is nearer
const line = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false };
assert.deepEqual(plain(optimizePathOrder([line], { x: 10, y: 0 })[0].points), [{ x: 10, y: 0 }, { x: 0, y: 0 }]);
assert.deepEqual(plain(optimizePathOrder([line], { x: 0, y: 0 })[0].points), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);

// a hole is cut before the outline that contains it, even when the outline is nearer
const outer = square(0, 0, 100);
const hole = square(40, 40, 10);
const ordered = optimizePathOrder([outer, hole], start);
assert.deepEqual(plain(ordered.map((p) => p.points.length)), [4, 4]);
assert.equal(ordered[0].points.some((p) => p.x === 40 || p.x === 50), true);
// nested: part inside a hole of another part still goes before that other part's outline
const sheet = square(0, 0, 300);
const partA = square(10, 10, 100);
const holeA = square(30, 30, 50);
const partInHole = square(40, 40, 10);
const order = optimizePathOrder([sheet, partA, holeA, partInHole], start).map((p) => p.points.length === 4 ? Math.max(...p.points.map((q) => q.x)) - Math.min(...p.points.map((q) => q.x)) : -1);
assert.deepEqual(plain(order), [10, 50, 100, 300]);

// identical duplicate polygons must not hang or crash
assert.equal(optimizePathOrder([square(0, 0, 10), square(0, 0, 10)], start).length, 2);

// degenerate input
assert.deepEqual(plain(optimizePathOrder([], start)), []);
assert.deepEqual(plain(optimizePathOrder([{ points: [{ x: 1, y: 1 }], closed: true }], start)), []);
assert.equal(travelDistance([], start), 0);

// 2-opt: never worse than greedy alone, usually better, keeps every path and the holes-first rule
{
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let greedyTotal = 0;
  let twoOptTotal = 0;

  for (let trial = 0; trial < 12; trial++) {
    const paths = [];
    const holeOf = new Map();
    for (let i = 0; i < 40; i++) {
      const x = rnd() * 500, y = rnd() * 300, w = 12 + rnd() * 20;
      const outerPath = square(x, y, w);
      paths.push(outerPath);
      if (i % 3 === 0) {
        const h = square(x + w * 0.3, y + w * 0.3, w * 0.3);
        holeOf.set(h, outerPath);
        paths.push(h);
      }
      if (i % 5 === 0) {
        paths.push({ points: [{ x: x + 40, y }, { x: x + 40 + rnd() * 30, y: y + rnd() * 30 }], closed: false });
      }
    }

    const greedy = optimizePathOrder(paths, start, false);
    const better = optimizePathOrder(paths, start, true);
    const dg = travelDistance(greedy, start);
    const d2 = travelDistance(better, start);
    assert(d2 <= dg + 1e-6, 'trial ' + trial + ': 2-opt must not be worse');
    greedyTotal += dg;
    twoOptTotal += d2;

    // every path kept, same vertices
    assert.equal(better.length, paths.length);
    assert.deepEqual(plain(better.map(key).sort()), plain(paths.map(key).sort()));

    // every hole is cut before the outline around it
    const firstX = (p) => p.points.map((q) => q.x + ',' + q.y).sort().join('|');
    const index = new Map(better.map((p, k) => [firstX(p), k]));
    for (const [h, o] of holeOf) {
      assert(index.get(firstX(h)) < index.get(firstX(o)), 'hole before outline');
    }
  }

  assert(twoOptTotal < greedyTotal, '2-opt should shorten travel overall');
}

console.log('path-order tests passed');
