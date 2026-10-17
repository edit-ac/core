import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
const groups = { authoring: { files: ['tests/extension-dx/authoring.test.mjs'], minimumTests: 33 }, contract: { files: ['tests/extension-dx/contract.test.mjs'], minimumTests: 30 }, configuration: { files: ['tests/extension-dx/configuration.test.mjs'], minimumTests: 45 }, loading: { files: ['tests/extension-dx/loading.test.mjs'], minimumTests: 24 } };
if (args.length !== 2 || args[0] !== '--group' || !Object.hasOwn(groups, args[1])) {
  console.error('Specify exactly --group contract, --group configuration, --group authoring or --group loading; unavailable/unimplemented groups fail closed.'); process.exit(2);
}
const output = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT ?? `.artifacts/extension-dx/${args[1]}`);
mkdirSync(output, { recursive: true });
const { files, minimumTests } = groups[args[1]];
for (const file of files) if (!readFileSync(file).length) throw Error(`Missing/empty test file ${file}`);
if (args[1] === 'loading') {
  const runs = [];
  variants: for (const browser of ['chromium','firefox','webkit']) for (const host of ['direct','bundler']) {
    const directory = resolve(output, browser, host); mkdirSync(directory, {recursive:true});
    const result = spawnSync(process.execPath, ['--test','--test-reporter=tap',...files], {
      encoding:'utf8',env:{...process.env,EDITAC_EXTENSION_DX_OUTPUT:directory,EDITAC_LOADING_OUTPUT:resolve(directory,'browser'),EDITAC_LOADING_BROWSER:browser,EDITAC_LOADING_HOST:host},maxBuffer:16*1024*1024,
    });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`; writeFileSync(resolve(directory,'tests.tap'),log);
    const count = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1] ?? NaN);
    const counts={executed:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled'),todo:count('todo')};
    runs.push({browser,host,counts,status:result.status,error:result.error?.message});
    console.log(JSON.stringify(runs.at(-1)));
    // Preserve the failed cell and stop; never continue an unchanged failure
    // through five more equivalent setups just to accumulate red evidence.
    if(result.error || result.status!==0 || !(counts.executed>=minimumTests) || counts.passed!==counts.executed || counts.failed!==0 || counts.skipped!==0 || counts.cancelled!==0 || counts.todo!==0) break variants;
  }
  writeFileSync(resolve(output,'dispatch-receipt.json'),JSON.stringify({group:'loading',files,minimumTests,node:process.versions.node,runs},null,2));
  if(runs.length!==6 || runs.some(run=>run.status!==0 || run.counts.passed!==run.counts.executed || !(run.counts.executed>=minimumTests) || run.counts.skipped!==0 || run.counts.cancelled!==0 || run.counts.todo!==0)) process.exit(1);
  process.exit(0);
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', env: { ...process.env, EDITAC_EXTENSION_DX_OUTPUT: output }, maxBuffer: 16 * 1024 * 1024,
});
const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
writeFileSync(resolve(output, 'tests.tap'), log);
const count = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
const counts = { executed: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), todo: count('todo') };
writeFileSync(resolve(output, 'dispatch-receipt.json'), JSON.stringify({ group: args[1], files, minimumTests, node: process.versions.node, counts, status: result.status }, null, 2));
console.log(JSON.stringify({ group: args[1], counts, output }));
if (result.error || result.status !== 0 || !(counts.executed >= minimumTests) || counts.passed !== counts.executed || counts.failed !== 0 || counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) process.exit(1);
