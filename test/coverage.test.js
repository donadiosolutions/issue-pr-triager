import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCoverage } from '../scripts/check-coverage.js';

test('coverage inventory requires every implementation file and exact complete counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'triager-coverage-'));
  try {
    mkdirSync(join(root, 'src/nested'), { recursive: true });
    writeFileSync(join(root, 'src/main.js'), 'export const main = 1;');
    writeFileSync(join(root, 'src/nested/unused.js'), 'export const unused = 1;');
    writeFileSync(join(root, 'src/readme.md'), 'not production JavaScript');
    const metrics = () => Object.fromEntries(['lines', 'branches', 'statements', 'functions'].map(k => [k, { total: 1, covered: 1, skipped: 0, pct: 100 }]));
    const summary = { total: metrics(), [join(root, 'src/main.js')]: metrics() };
    assert.throws(() => verifyCoverage(root, summary), /Missing coverage.*unused.js/);
    summary[join(root, 'src/nested/unused.js')] = metrics();
    assert.equal(verifyCoverage(root, summary), 2);
    summary.total.lines.covered = 0;
    assert.throws(() => verifyCoverage(root, summary), /total.*lines/);
    summary.total.lines.covered = 1;
    summary[join(root, 'src/main.js')].branches.skipped = 1;
    assert.throws(() => verifyCoverage(root, summary), /main.js.*branches/);
    summary[join(root, 'src/main.js')].branches.skipped = 0;
    delete summary[join(root, 'src/main.js')].functions;
    assert.throws(() => verifyCoverage(root, summary), /main.js.*functions/);
  } finally { rmSync(root, { recursive: true }); }
});
