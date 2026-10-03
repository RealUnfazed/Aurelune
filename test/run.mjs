// `npm test` — checks that need no database or network: the player's element/EQ-graph switching logic,
// and the Studio upload UI (real views.js + uploader.js under jsdom, with a mocked API) in four hosting scenarios.
import { spawnSync } from 'node:child_process';
const jobs = [['player.test.mjs'], ...['selfhosted', 'vercel-direct', 'vercel-nodirect', 'no-storage'].map((s) => ['ui.test.mjs', s])];
let failed = 0;
for (const [file, ...args] of jobs) {
  const r = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname, ...args], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) FAILED` : '\nAll test files passed');
process.exit(failed ? 1 : 0);
