import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { prerequisiteGroups, requiredSourcePaths, requiredArtifactPaths, verifyPrerequisiteQualification } from '../scripts/verify-prerequisite-qualification.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
function fixture() {
  const files = new Map();
  const pins = paths => Object.fromEntries(paths.map(p => { const b = Buffer.from(p); files.set(p, b); return [p, sha(b)]; }));
  const checks = prerequisiteGroups.flatMap(group => Array.from({length:group==='minimal-core'?3:group==='production-build'?5:group==='storage-sync'?2:1},(_,i)=>({group, exit:0, executed:1, passed:1, failed:0, skipped:0, cancelled:0, log:`logs/${group}-${i}`})));
  const receipt = {schema:1, state:'implemented-and-verified-current-prerequisites', requiredGroups:[...prerequisiteGroups], providerCalls:0, sourceRoadmapEdits:0, checks,
    sourceHashes:pins([...requiredSourcePaths,'core/source-1']),
    artifactHashes:pins(requiredArtifactPaths), evidenceHashes:pins([...checks.map(c=>c.log),'virtual/receipt.json']),
    virtualClipboard:{developmentGate:'PASS',counts:{executed:5,passed:5,failed:0,skipped:0,cancelled:0},physicalDevicesObserved:0,receipt:'virtual/receipt.json'}};
  for (const c of checks) {
    if (c.group==='emulator-menu') c.executed=c.passed=5;
    const log=Buffer.from(`# tests ${c.executed}\n# pass ${c.passed}\n# fail 0\n# skipped 0\n# cancelled 0\n`);
    files.set(c.log,log);receipt.evidenceHashes[c.log]=sha(log);
  }
  return {receipt,files};
}
const verify = ({receipt,files}) => verifyPrerequisiteQualification({path:'receipt',read: async p => p==='receipt'?Buffer.from(JSON.stringify(receipt)):files.get(p)});
test('accept complete deterministic current-proof fixture', async () => {await verify(fixture());});
for (const [name, mutate] of [
  ['incomplete production build', f=>{f.receipt.checks=f.receipt.checks.filter(c=>c.log!=='logs/production-build-4');}],
  ['missing consumed runtime', f=>{delete f.receipt.artifactHashes[requiredArtifactPaths[0]];}],
  ['missing consumed source', f=>{delete f.receipt.sourceHashes['core/crates/editac-session/src/edit_service.rs'];}],
  ['fractional case count', f=>{f.receipt.checks[0].executed=1.5;f.receipt.checks[0].passed=1.5;}],
  ['invented count differs from raw log', f=>{f.receipt.checks[0].executed=2;f.receipt.checks[0].passed=2;}],
  ['historical state', f=>{f.receipt.state='historical-complete';}],
  ['missing boundary', f=>{f.receipt.checks=f.receipt.checks.filter(c=>c.group!=='session-browser');}],
  ['zero executed', f=>{f.receipt.checks[0].executed=0;f.receipt.checks[0].passed=0;}],
  ['required skip', f=>{f.receipt.checks[0].skipped=1;}],
  ['failed check', f=>{f.receipt.checks[0].exit=1;}],
  ['stale source', f=>{f.files.set('core/source-1',Buffer.from('changed'));}],
  ['stale runtime', f=>{f.files.set(requiredArtifactPaths[0],Buffer.from('changed'));}],
  ['missing log pin', f=>{delete f.receipt.evidenceHashes[f.receipt.checks[0].log];}],
  ['unexecuted virtual case', f=>{f.receipt.virtualClipboard.counts.passed=4;}],
  ['missing current requirement', f=>{delete f.receipt.sourceHashes['architecture/specs/verification.md'];}],
]) test(`reject ${name}`,async()=>{const f=fixture();mutate(f);await assert.rejects(()=>verify(f));});
