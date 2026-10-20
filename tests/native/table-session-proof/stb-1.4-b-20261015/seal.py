"""Bind scoped prerequisite proof without promoting the open parent."""
from pathlib import Path
import hashlib,json,re,shutil,subprocess

core=Path(__file__).resolve().parents[4]; out=Path(__file__).resolve().parent
workspace=core.parent; arch=workspace/'architecture'
def digest(p):
    with p.open('rb') as stream:
        h=hashlib.sha256()
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
        return h.hexdigest()
def write(name,value): (out/name).write_text(json.dumps(value,indent=2)+'\n')
def receipt(name): return json.loads((out/name).read_text())
def fact(p,root=out):return {'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':digest(p)}
def ref(name):return fact(out/name)

source=workspace/'.roadmap-runner/shared-native-table-boundary-repair-20261015/.roadmap-runner/roadmap-831829a3ecc0/source-3ccb07692d63.md'
expected='d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526'
assert digest(source)==expected
preserved=receipt('preserved-changes.json')
assert all(digest(core/p)==h for p,h in preserved.items())
rust=(out/'rust-qualified.log').read_text()
summaries=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out',rust)
assert len(summaries)==6 and sum(int(x[0]) for x in summaries)==118
assert all(all(int(n)==0 for n in s[1:]) for s in summaries)
bins=out/'rust-binaries';bins.mkdir(exist_ok=True)
executed=re.findall(r'Running .*?\((target/debug/deps/[^)]+)\)',rust)
assert len(executed)==6
for name in executed:shutil.copy2(core/name,bins/Path(name).name)
generated=out/'generated';generated.mkdir(exist_ok=True)
for p in (core/'crates/editac-ffi/generated').rglob('*'):
    if p.is_file():
        dest=generated/p.relative_to(core/'crates/editac-ffi/generated');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)

paths=set()
for base in ['crates','fixtures/schema-v4','fixtures/schema-v5']:
    for p in (core/base).rglob('*'):
        if p.is_file() and p.suffix in ['.rs','.toml','.json','.mjs']:paths.add(p)
for name in ['Cargo.toml','Cargo.lock','package.json','package-lock.json','tests/native/bounded-bindings.py','tests/native/session-swift.py','tests/native/session-backward.py','tests/native/session-command-proof/run.py','tests/native/session-command-proof/CommandCases.swift','tests/native/session-probe/main.swift','tests/native/session-probe/RichCases.swift','tests/native/fixtures/bounded-abi.json','native/ios/probe/main.swift','tests/native/table-session-proof/TablePolicyCases.swift','tests/native/table-session-proof/RemoteCases.swift','tests/native/table-session-proof/HostTransportCases.swift','tests/native/table-session-proof/PresenceCases.swift','tests/native/table-session-proof/presence-oracle.mjs']:
    if (core/name).is_file():paths.add(core/name)
write('source-envelope.json',{'core':{str(p.relative_to(core)):digest(p) for p in sorted(paths)},'architecture':{str(p.relative_to(arch)):digest(p) for p in [arch/'specs/client-contracts.md',arch/'specs/native-sdk-parity.md',arch/'specs/storage-sync.md',arch/'specs/formats.md',arch/'specs/extension-library.md']},'unchangedPreexistingDirtySources':preserved})
node=Path('/Users/bpstr/.nvm/versions/node/v24.19.0/bin/node')
runtime={'node':fact(node,node.parent),'nodePath':str(node),'rust':'1.97.1','nativeLibrary':ref('library/libeditac_ffi.dylib'),'oracleDependencies':{}}
for name in ['y-protocols','yjs','lib0']:
    for p in (core/'node_modules'/name).rglob('*'):
        if p.is_file() and p.suffix in ['.js','.mjs','.cjs','.json']:runtime['oracleDependencies'][str(p.relative_to(core))]=digest(p)
write('runtime-envelope.json',runtime)
bind=receipt('bindings-qualified/bindings-receipt.json');swift=receipt('swift-qualified/receipt.json');back=receipt('backward/receipt.json');abi=receipt('abi-audit.json')
assert bind['counts']=={'executed':77,'passed':77,'failed':0,'skipped':0}
assert abi['counts']=={'executed':89,'passed':89,'failed':0,'skipped':0}
assert swift['counts']=={'executed':105,'passed':105,'failed':0,'skipped':0}
assert all(c['exit']==0 for c in back['checks'])
assert digest(out/'library/libeditac_ffi.dylib')==bind['library']['sha256']==swift['library']['sha256']==back['librarySha256']
archlog=(out/'architecture-check.log').read_text();assert 'pass 14' in archlog and 'fail 0' in archlog and 'skipped 0' in archlog
for name in ['fmt-check.log','source-whitespace.log','contract-whitespace.log','node-syntax.log']:assert (out/name).read_text()==''
# Save process names without arguments/environment/credentials. No task browser or
# server was started; unrelated controller/browser/listener resources are preserved.
process=subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True)
(out/'process-names.txt').write_text(process)
free=shutil.disk_usage('/System/Volumes/Data').free
write('hygiene.json',{'taskBrowsersStarted':0,'taskServersStarted':0,'confirmedAbandonedTaskProcesses':0,'stopped':[],'removedPaths':[],'reclaimedBytes':0,'dataVolumeFreeBytes':free,'preservedUnrelatedSourceHashes':preserved,'retainedQualificationArtifacts':True})
artifacts={str(p.relative_to(out)):{'sha256':digest(p),'bytes':p.stat().st_size} for p in sorted(out.rglob('*')) if p.is_file() and p.name not in ['artifact-envelope.json','delivery.json','evidence-commit.log']}
write('artifact-envelope.json',artifacts)
write('delivery.json',{'gate':'STB-1.4','child':'STB-1.4-b1','state':'implemented-verified-prerequisite-parent-open','parentQualified':False,'sourceRevision':expected,'promptRevision':'2e18a98412c7','owningCommits':{'core':'730f44177da1bc8598f614e7908f22171cdfced5','architecture':'325986f202a413642e5243cd4889a4f827d56038'},'sourceEnvelope':ref('source-envelope.json'),'artifactEnvelope':ref('artifact-envelope.json'),'runtimeEnvelope':ref('runtime-envelope.json'),'library':ref('library/libeditac_ffi.dylib'),'generated':[fact(p) for p in sorted(generated.rglob('*')) if p.is_file()],'rust':{'executed':118,'passed':118,'failed':0,'skipped':0,'ignored':0,'filtered':0,'suites':6,'binaries':[fact(p) for p in sorted(bins.iterdir())],'log':ref('rust-qualified.log')},'swift':{'executed':117,'passed':117,'failed':0,'skipped':0,'currentReceipt':ref('swift-qualified/receipt.json'),'unchangedSessionReceipt':ref('backward/receipt.json')},'bindings':{'counts':bind['counts'],'receipt':ref('bindings-qualified/bindings-receipt.json')},'abi':{'counts':abi['counts'],'receipt':ref('abi-audit.json')},'architecture':{'executed':14,'passed':14,'failed':0,'skipped':0,'log':ref('architecture-check.log')},'preservedFailedPhases':[{'log':ref('check.log'),'kind':'compile-failure'},{'log':ref('check-repair.log'),'kind':'compile-failure'},{'log':ref('rust-final.log'),'passed':55,'failed':1,'skipped':0,'reason':'Node stdin fixture API'},{'log':ref('rust-repaired.log'),'passed':58,'failed':1,'skipped':0,'reason':'split alias incorrectly assumed deleted; corrected actual owner-deletion fixture'}],'remaining':'STB-1.4-b2 authority/key admission and remaining lifecycle; STB-1.4-c full generated-client qualification; all original native acceptance open','noPublication':True,'noPaidCalls':True})
print(json.dumps({'sourceFiles':len(paths),'artifactFiles':len(artifacts),'retainedRustBinaries':len(executed),'freeBytes':free,'deliverySha256':digest(out/'delivery.json')}))
