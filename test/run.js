// Test runner: each suite declares its case count, runs once as-is and once with a planted defect.
// Exit 0 only when every case passes, every count matches and every planted run fails as expected.
import redirects from './suites/redirects.js';
import headers from './suites/headers.js';
import pages from './suites/pages.js';
import form from './suites/form.js';
import sparkpost from './suites/sparkpost.js';
import { cleanupTmp } from './lib.js';

const SUITES = [redirects, headers, pages, form, sparkpost];
const CASE_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 300000;

setTimeout(() => { console.error(`FAIL: test run exceeded ${TOTAL_TIMEOUT_MS / 1000} s`); process.exit(2); }, TOTAL_TIMEOUT_MS).unref();

const withTimeout = (p, ms, label) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${label}`)), ms); })])
    .finally(() => clearTimeout(t));
};

async function runSuite(suite, { planted = false, declared = suite.declared, quiet = false, opts = {} } = {}) {
  const built = await suite.build({ planted, ...opts });
  const failed = [];
  let passed = 0;
  const skipped = [];
  try {
    for (const [name, fn] of built.cases) {
      try {
        const out = await withTimeout(Promise.resolve().then(fn), CASE_TIMEOUT_MS, name);
        if (out === 'skip') skipped.push(name);
        passed += 1;
        if (!quiet && out === 'skip') console.log(`  SKIP ${name} (placeholder public/)`);
      } catch (err) {
        failed.push(name);
        if (!quiet) console.log(`  FAIL ${name}\n       ${String(err && err.message).split('\n').slice(0, 6).join('\n       ')}`);
      }
    }
  } finally {
    await built.close();
  }
  const ran = built.cases.length;
  const countOk = ran === declared;
  return { ran, passed, skipped, failed, countOk, ok: countOk && failed.length === 0 };
}

let bad = 0;
let totalCases = 0;
console.log('Suites');
for (const suite of SUITES) {
  const r = await runSuite(suite);
  totalCases += r.ran;
  const skipNote = r.skipped.length ? `, ${r.skipped.length} skipped` : '';
  console.log(`suite ${suite.name}: ${r.ran} cases (declared ${suite.declared}), ${r.passed - r.skipped.length} passed${skipNote}, ${r.failed.length} failed${r.countOk ? '' : '  COUNT MISMATCH'}`);
  if (!r.ok) bad += 1;
}

console.log('\nProofs (each planted run must fail on the named cases)');
let proofs = 0;
for (const suite of SUITES) {
  const r = await runSuite(suite, { planted: true, quiet: true });
  const missing = suite.plantedMustFail.filter((n) => !r.failed.includes(n));
  const held = !r.ok && missing.length === 0;
  console.log(`proof ${suite.name}: planted run ${r.ok ? 'PASSED (proof dead)' : `failed ${r.failed.length} cases`}; expected failures seen ${suite.plantedMustFail.length - missing.length}/${suite.plantedMustFail.length}${held ? '' : `  MISSING: ${missing.join(' | ')}`}`);
  if (held) proofs += 1; else bad += 1;
}
let proofCount = SUITES.length + 1;
for (const suite of SUITES) {
  for (const extra of suite.extraProofs || []) {
    proofCount += 1;
    const r = await runSuite(suite, { quiet: true, opts: extra.opts });
    const mustSkip = extra.mustSkip || [];
    const missing = [...extra.mustFail.filter((n) => !r.failed.includes(n)), ...mustSkip.filter((n) => !r.skipped.includes(n)).map((n) => `skip of ${n}`)];
    const held = !r.ok && missing.length === 0;
    const skipNote = mustSkip.length ? `; expected skips seen ${mustSkip.filter((n) => r.skipped.includes(n)).length}/${mustSkip.length}` : '';
    console.log(`proof ${extra.label}: ${r.ok ? 'PASSED (proof dead)' : `failed ${r.failed.length} cases`}; expected failures seen ${extra.mustFail.filter((n) => r.failed.includes(n)).length}/${extra.mustFail.length}${skipNote}${held ? '' : `  MISSING: ${missing.join(' | ')}`}`);
    if (held) proofs += 1; else bad += 1;
  }
}
{
  const r = await runSuite(SUITES[0], { declared: SUITES[0].declared + 1, quiet: true });
  const held = !r.ok && !r.countOk;
  console.log(`proof count guard: a declared count off by one ${held ? 'fails the suite' : 'PASSED (proof dead)'}`);
  if (held) proofs += 1; else bad += 1;
}

console.log(`\n${SUITES.length} suites, ${totalCases} cases, ${proofs}/${proofCount} proofs held: ${bad ? 'FAIL' : 'PASS'}`);
cleanupTmp();
process.exit(bad ? 1 : 0);
