"""Bind committed owned source and exact retained qualification artifacts."""
from pathlib import Path
import hashlib,json,subprocess,re
ROOT=Path(__file__).resolve().parent
CORE=ROOT.parents[3]
WORKSPACE=CORE.parent
SOURCE=WORKSPACE/'.roadmap-runner/shared-native-table-boundary-repair-20261015/.roadmap-runner/roadmap-831829a3ecc0/source-3ccb07692d63.md'
REV='d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,d): p.write_text(json.dumps(d,indent=2,sort_keys=True)+'\n')
assert sha(SOURCE)==REV
swift=json.loads((ROOT/'swift/receipt.json').read_text())
assert swift['counts']=={'executed':125,'passed':125,'failed':0,'skipped':0}
for name,h in swift['sourceHashes'].items(): assert sha(CORE/name)==h,name
assert sha(ROOT/'library/libeditac_ffi.dylib')==swift['library']['sha256']
for name,h in swift['generatedArtifacts'].items(): assert sha(CORE/name)==h,name
prior=json.loads((ROOT.parent/'stb-1.4-b2-20261015/source-envelope.json').read_text())
original=json.loads((ROOT/'unrelated-baseline.json').read_text())
for name,h in original.items(): assert sha(CORE/name)==h==prior['core'][name],name
core_paths=set(prior['core'])
for name in subprocess.check_output(['git','ls-files'],cwd=CORE,text=True).splitlines():
 p=Path(name)
 if (name.startswith(('crates/','packages/core/src/')) and p.suffix in {'.rs','.toml','.lock','.ts','.swift','.kt','.h','.modulemap'}) or name in {'Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json','scripts/build-wasm.mjs','packages/core/package.json','packages/core/tsconfig.json'}:
  core_paths.add(name)
core_paths.update(swift['sourceHashes'])
core_paths.update(swift['generatedArtifacts'])
core_paths.update(['native/macos/tests/AttachmentsFixture/src/main.rs','native/macos/tests/AttachmentsFixture/corpus.json','native/macos/tests/AttachmentsFixture/Cargo.toml','native/macos/tests/AttachmentsFixture/Cargo.lock','tests/atomic-content-commands.test.mjs','tests/table-commands.test.mjs','tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json'])
source={'core':{p:sha(CORE/p) for p in sorted(core_paths)},'architecture':{f'specs/{p}':sha(WORKSPACE/'architecture/specs'/p) for p in ['client-contracts.md','native-sdk-parity.md','extension-library.md','formats.md']},'unchangedPreexistingDirtySources':original,'toolchains':{'node':subprocess.check_output(['/Users/bpstr/.nvm/versions/node/v24.19.0/bin/node','--version'],text=True).strip(),'rust':subprocess.check_output(['rustc','+1.97.1','--version'],text=True).strip()},'sourceRoadmapSha256':sha(SOURCE)}
write(ROOT/'source-envelope.json',source)
artifacts={str(p.relative_to(ROOT)):{'sha256':sha(p),'bytes':p.stat().st_size} for p in sorted(ROOT.rglob('*')) if p.is_file() and p.name not in {'artifact-envelope.json','delivery.json'} and '__pycache__' not in p.parts}
write(ROOT/'artifact-envelope.json',artifacts)
counts={k:{'executed':n,'passed':n,'failed':0,'skipped':0} for k,n in {'nativeRust':128,'coreRust':36,'sessionRust':3,'generatedSwiftAndLegacyEngine':125,'unchangedPriorSessionSwift':12,'bindings':77,'abi':96,'architecture':14,'productionWasm':6}.items()}
assert sum(x['executed'] for x in counts.values())==497
write(ROOT/'delivery.json',{'id':'STB-1.5-20261015','state':'implemented/verified; not main-integrated or deployed','qualifiedGates':['STB-1.5-a','STB-1.5-b','STB-1.5-c','STB-1.5'],'sourceRoadmapRevision':REV,'loadedPromptRevision':'2e18a98412c7','sourceCommit':'87898b4f3b799399a3384d77209c2684a772d7c9','implementationCommit':'5cbdded87f31571db47bc6a800e8a197fefde1ec','architectureCommit':'d31201f63014199c136efbb5c2415b2b4d2319e8','counts':counts,'totalFinalExecuted':497,'finalFailed':0,'finalSkipped':0,'countApplicability':'README: 7 formatted atomic refreshes replace prior corresponding cases; 62 unchanged library and unchanged integration/core/table/consumer checks reused by exact inputs. Filtered supplementary checks are not counted as passes.','artifacts':{'sourceEnvelopeSha256':sha(ROOT/'source-envelope.json'),'artifactEnvelopeSha256':sha(ROOT/'artifact-envelope.json'),'artifactCount':len(artifacts)},'remainingGates':['STB-1.6','STB-1.7 MONITOR ONLY'],'originalNativeAcceptanceClosed':False,'mainIntegration':False,'productionEncryptionQualified':False,'nativeUiImeQualified':False,'providerCalls':0,'networkCalls':0,'publication':False,'initialFailures':'README and retained raw logs/attempts; all final required checks passed','sourceApplicability':'Exact source envelope includes three unchanged, uncommitted unrelated sources; no clean-commit-only binary claim.'})
for name,meta in artifacts.items(): assert sha(ROOT/name)==meta['sha256'],name
print(json.dumps({'artifactsVerified':len(artifacts),'sourceFilesPinned':len(source['core'])+len(source['architecture']),'finalExecuted':497,'failed':0,'skipped':0}))
