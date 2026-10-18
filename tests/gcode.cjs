/* Run from the Deepnest repository root after npm install: node tests/gcode.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DEEPNEST_REPO || process.cwd();
const deps = process.env.DEEPNEST_DEPS || root;
const ts = require(path.join(deps, 'node_modules/typescript'));

const src = fs.readFileSync(path.join(root, 'main/ui/utils/gcode.ts'), 'utf8').replace(/^import .*;\s*$/mg, '');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { module: mod, exports: mod.exports });
const { generateGcode } = mod.exports;

// open path, inches converted to mm
assert.equal(
  generateGcode([{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false }]),
  'G21\nG90\nM5\nG0 X0 Y0\nM3 S1000\nG1 X25.4 Y0 F1000\nM5\nM2\n'
);

// closed path returns to start, feed rate only on the first cut move
assert.equal(
  generateGcode([{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true }]),
  'G21\nG90\nM5\nG0 X0 Y0\nM3 S1000\nG1 X25.4 Y0 F1000\nG1 X25.4 Y25.4\nG1 X0 Y0\nM5\nM2\n'
);

// rounding to 3 decimals
assert(generateGcode([{ points: [{ x: 0, y: 0 }, { x: 0.12345, y: 0 }], closed: false }]).includes('G1 X3.136 Y0 F1000'));

// custom feed rate and Z-axis tool commands
assert.equal(
  generateGcode(
    [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false }],
    { feedRate: 300, toolOn: 'G1 Z-1', toolOff: 'G0 Z5' }
  ),
  'G21\nG90\nG0 Z5\nG0 X0 Y0\nG1 Z-1\nG1 X25.4 Y0 F300\nG0 Z5\nM2\n'
);

// paths with fewer than 2 points are skipped
assert.equal(
  generateGcode([{ points: [], closed: false }, { points: [{ x: 1, y: 1 }], closed: true }]),
  'G21\nG90\nM5\nM2\n'
);

console.log('gcode tests passed');
