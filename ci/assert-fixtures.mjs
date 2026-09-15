// Assert that fixture/probe result files posted by ci/fixtures/*.html exist and that
// every row reports status 'pass'. Usage: node ci/assert-fixtures.mjs <results.json> [...]
// Exit code is nonzero on a missing file, invalid JSON, an empty results list, or any
// row that is not 'pass' (including 'fail', 'error', 'unavailable' and 'inconclusive').
import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node ci/assert-fixtures.mjs <results.json> [...]');
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  let report;
  try {
    report = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`FAIL ${file}: cannot read results JSON — ${error.message ?? error}`);
    failures++;
    continue;
  }
  const results = report?.results;
  if (!Array.isArray(results) || !results.length) {
    console.error(`FAIL ${file}: no results array in the posted report`);
    failures++;
    continue;
  }
  const bad = results.filter(row => row && row.status !== 'pass');
  const version = report.fixtureVersion ?? report.dspLiveProbeVersion ?? '?';
  if (bad.length) {
    failures += bad.length;
    for (const row of bad) {
      const label = row.kind ? `${row.kind}@${row.rate}` : row.probe ?? '(unnamed row)';
      const detail = row.error ?? row.reason
        ?? (row.arithmeticError !== null && row.arithmeticError !== undefined ? `arithmeticError ${row.arithmeticError}` : 'no detail');
      console.error(`FAIL ${file}: ${label} — status ${row.status} (${detail})`);
    }
  }
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${file}: ${results.length - bad.length}/${results.length} rows pass (suite version ${version})`);
}
process.exit(failures ? 1 : 0);
