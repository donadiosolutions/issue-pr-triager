import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function verifyCoverage(root, summary) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(resolve(path));
    }
  };
  visit(resolve(root, 'src'));
  for (const name of ['total', ...files]) {
    const report = summary[name];
    if (!report) throw new Error(`Missing coverage for ${name}`);
    for (const metric of ['lines', 'branches', 'statements', 'functions']) {
      const value = report[metric];
      if (!value || value.covered !== value.total || value.skipped !== 0 || value.pct !== 100) {
        throw new Error(`Incomplete coverage: ${name} ${metric}`);
      }
    }
  }
  return files.length;
}

if (import.meta.main) {
  const count = verifyCoverage(process.cwd(), JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')));
  console.log(`All four metrics are 100% across ${count} implementation files.`);
}
