// Coverage goals for the e2e tier: things we want a game to exercise but that depend on
// how a randomly shuffled game against the AIs plays out (combat happening, the §6
// backstop landing un-interleaved, a playable land coming up). Tests must be
// deterministic, so these never fail a test; hard expects are kept for invariants that
// hold in every game. A goal is logged as a [coverage] line, attached to the test as an
// annotation, and under GitHub Actions appended to the job summary so a missed goal
// stays visible. Mirrors bridge/src/test/java/night/bridge/live/Coverage.java.

import { test } from '@playwright/test';
import fs from 'node:fs';

export function coverageGoal(goal: string, met: boolean, detail: string): void {
  const status = met ? 'MET' : 'MISSED';
  const title = test.info().title;
  console.log(`[coverage] ${status} ${title}: ${goal} (${detail})`);
  test.info().annotations.push({ type: `coverage ${status}`, description: `${goal} (${detail})` });
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    fs.appendFileSync(summary, `| ${met ? '✅' : '⚠️'} | \`${title}\` | ${goal} | ${detail} |\n`);
  }
}
