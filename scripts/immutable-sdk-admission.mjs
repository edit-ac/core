import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';

// Admission authenticates installed inputs only. It never admits browser results.
export function admitImmutableSdk(path) {
  const bytes = readFileSync(path), admission = JSON.parse(bytes);
  for (const pins of [admission.sources, admission.runtime])
    for (const [file, digest] of Object.entries(pins))
      assert.equal(hash(readFileSync(file)), digest, 'Changed admitted input: ' + file);
  const checked = spawnSync('python3', ['-c', `import sys,json,tarfile,hashlib,pathlib
a=json.load(sys.stdin); members={}
for name,p in a['packages'].items():
 assert hashlib.sha256(pathlib.Path(p['path']).read_bytes()).hexdigest()==p['sha256'],name
 with tarfile.open(p['path']) as t:
  assert json.load(t.extractfile('package/package.json'))['name']=='@edit-ac/'+name
  for m in t.getmembers():
   if m.isfile() and m.name.startswith('package/dist/'):
    members['packages/'+name+'/'+m.name.removeprefix('package/')]=hashlib.sha256(t.extractfile(m).read()).hexdigest()
assert members==a['runtime'],'Archive/runtime coverage or bytes differ'
print(len(members))`], { input: JSON.stringify(admission), encoding: 'utf8' });
  assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stderr);
  return { ...admission, receipt: { path: resolve(path), sha256: hash(bytes) } };
}
