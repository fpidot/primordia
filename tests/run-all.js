// tests/run-all.js — runs every *.test.js under tests/ in sequence.
// Aggregates pass/fail and exits non-zero on any failure (CI-friendly).

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log(`Running ${tests.length} test file(s):`);
for (const t of tests) console.log(`  • ${t}`);

let failures = 0;
for (const t of tests) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ ${t}`);
  console.log('═'.repeat(60));
  try {
    // Run each test file in its own subprocess-equivalent — fresh import
    // graph, fresh module-scope state, fresh seeded RNG. Important since
    // the harness mutates Math.random globally.
    await import(pathToFileURL(join(here, t)).href);
  } catch (err) {
    failures++;
    console.error(`\n[FAIL ${t}]`, err.message || err);
  }
}

console.log(`\n${'═'.repeat(60)}`);
if (failures > 0) {
  console.error(`${failures} test file(s) failed.`);
  process.exit(1);
} else {
  console.log('All tests passed.');
}
