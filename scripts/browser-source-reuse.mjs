import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins } from './architecture-budgets.mjs';
const require = (ok, message) => { if (!ok) throw Error(message); };
// The monitor added a native session module. Browser source/runtime evidence is
// reusable only for this exact reviewed delta; future drift fails closed.
export async function verifyBrowserSources(root, pins, policy, dependencyPins = pins) {
  require(policy?.version === 1 && /^[a-f0-9]{40}$/.test(policy.beforeRevision) && /^[a-f0-9]{40}$/.test(policy.afterRevision), 'Invalid browser reuse revisions');
  const paths = ['Cargo.lock', 'crates/editac-session/Cargo.toml', 'crates/editac-session/src/lib.rs'];
  require(JSON.stringify(Object.keys(policy.changes)) === JSON.stringify(paths), 'Unexpected browser source reuse path');
  const sources = {};
  for (const path of paths) {
    const entry = policy.changes[path]; sources[path] = {};
    for (const [key, revision] of [['before', policy.beforeRevision], ['after', policy.afterRevision]]) {
      const result = spawnSync('git', ['show', `${revision}:${path}`], { cwd: root });
      require(result.status === 0 && digest(result.stdout) === entry[key], 'Missing/changed reviewed source revision');
      sources[path][key] = result.stdout.toString();
    }
    require(digest(await readFile(resolve(root, path))) === entry.after, 'Current reuse source drift');
  }
  const lock = sources['Cargo.lock'];
  // url already exists in this lock; only editac-session gains this edge.
  const chunks = text => text.split('[[package]]');
  const oldChunks = chunks(lock.before), newChunks = chunks(lock.after);
  require(oldChunks.length === newChunks.length, 'Changed browser dependency lock packages');
  for (let i = 0; i < oldChunks.length; i++) {
    if (oldChunks[i] !== newChunks[i]) require(oldChunks[i].includes('name = "editac-session"') && oldChunks[i].replace(' "sha2",\n', ' "sha2",\n "url",\n') === newChunks[i], 'Changed browser dependency lock closure');
  }
  // Session is not a reachable WASM dependency; both manifests remain pinned by
  // the original receipt and this explicit graph assertion.
  for (const path of ['crates/editac-wasm/Cargo.toml', 'crates/editac-core/Cargo.toml']) {
    require(dependencyPins[path] && digest(await readFile(resolve(root, path))) === dependencyPins[path], 'Unpinned WASM dependency manifest');
    require(!(await readFile(resolve(root, path), 'utf8')).includes('editac-session'), 'Session entered WASM dependency closure');
  }
  require(sources[paths[1]].before.replace('sha2 = "=0.10.9"\n', 'sha2 = "=0.10.9"\nurl = "=2.5.8"\n') === sources[paths[1]].after, 'Unexpected native manifest change');
  require(sources[paths[2]].before + '\n/// Host-owned public/private link contracts; no IO or semantic transactions.\npub mod links;\n' === sources[paths[2]].after, 'Unexpected native module change');
  const admitted = { ...pins };
  for (const path of paths) if (Object.hasOwn(admitted, path)) {
    require(admitted[path] === policy.changes[path].before, 'Receipt source does not match reviewed prior input');
    admitted[path] = policy.changes[path].after;
  }
  return { current: await verifyPins(root, admitted), reused: paths.filter(path => Object.hasOwn(pins, path)), policyHash: digest(JSON.stringify(policy)) };
}
