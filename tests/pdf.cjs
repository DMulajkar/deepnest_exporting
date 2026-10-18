/* Run from the Deepnest repository root after npm install: node tests/pdf.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DEEPNEST_REPO || process.cwd();
const deps = process.env.DEEPNEST_DEPS || root;
const ts = require(path.join(deps, 'node_modules/typescript'));

const src = fs.readFileSync(path.join(root, 'main/ui/utils/pdf.ts'), 'utf8').replace(/^import .*;\s*$/mg, '');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { module: mod, exports: mod.exports });
const { generatePdf } = mod.exports;

const pdf = generatePdf(
  [
    { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
    { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true },
    { points: [{ x: 5, y: 5 }], closed: true },
  ],
  2,
  3
);

assert(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
// page size in points
assert(pdf.includes('/MediaBox [0 0 144 216]'));
// open path, then closed path (closed with "h"), single-point path skipped
assert(pdf.includes('0.5 w\n0 0 m\n72 0 l\nS\n0 0 m\n72 0 l\n72 72 l\nh S'));
assert(!pdf.includes('360'));

// declared stream length matches the stream
const m = pdf.match(/\/Length (\d+) >>\nstream\n([\s\S]*)\nendstream/);
assert.equal(Number(m[1]), m[2].length);

// xref offsets point at "N 0 obj"
const xrefStart = Number(pdf.match(/startxref\n(\d+)/)[1]);
assert(pdf.slice(xrefStart).startsWith('xref\n0 5\n'));
const offsets = [...pdf.slice(xrefStart).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
assert.equal(offsets.length, 4);
offsets.forEach((o, i) => assert(pdf.slice(o).startsWith(`${i + 1} 0 obj`)));

// empty input is still a valid document
assert(generatePdf([], 1, 1).includes('0.5 w\nendstream'));

console.log('pdf tests passed');
