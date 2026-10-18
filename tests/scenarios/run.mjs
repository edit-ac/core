import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function validateScenario(manifest, id) {
  const scenario = Object.hasOwn(manifest.scenarios ?? {}, id) && manifest.scenarios[id];
  if (!scenario) throw Error(`Unknown scenario: ${id}`);
  if (!Array.isArray(scenario.command) || scenario.command.length !== 2 || scenario.command[0] !== 'node' || !scenario.command[1]) throw Error('Missing or unsupported command');
  if (!Array.isArray(scenario.cases) || !scenario.cases.length || new Set(scenario.cases).size !== scenario.cases.length) throw Error('Missing, duplicate or zero cases');
  if (!Array.isArray(scenario.fixtures) || !scenario.fixtures.length) throw Error('Missing fixtures');
  return scenario;
}
export async function loadScenario(id, manifestPath = resolve(root, 'fixtures/product-scenarios/web/manifest.json')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const scenario = validateScenario(manifest, id);
  for (const path of [scenario.command[1], ...scenario.fixtures]) {
    if (!resolve(root, path).startsWith(root + '/')) throw Error('Fixture/command escapes repository');
    await access(resolve(root, path));
  }
  return { manifest, scenario };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('Expected exactly one scenario ID');
    const { scenario } = await loadScenario(process.argv[2]);
    const result = spawnSync(process.execPath, [resolve(root, scenario.command[1])], { cwd: root, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
