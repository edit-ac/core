"""Bind the completed local qualification artifacts; never runs tests/providers."""
from pathlib import Path
import hashlib,json,re,subprocess,os
CORE=Path(__file__).resolve().parents[4]
OUT=Path(__file__).resolve().parent

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(name,data):(OUT/name).write_text(json.dumps(data,indent=2)+'\n')
def receipt(name):return json.loads((OUT/name).read_text())
def rust_counts(name,expected_suites):
    matches=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;', (OUT/name).read_text())
    assert len(matches)==expected_suites
    totals=[sum(int(row[i]) for row in matches) for i in range(5)]
    assert totals[0]>0 and not any(totals[1:])
    return dict(executed=totals[0],passed=totals[0],failed=totals[1],skipped=totals[2],filtered=totals[4])

swift=receipt('swift/receipt.json');bindings=receipt('bindings/bindings-receipt.json');backward=receipt('backward/receipt.json');abi=receipt('abi-audit.json')
counts={'nativeRust':rust_counts('rust-repaired.log',6),'securityRust':rust_counts('security.log',3),
        'generatedSwift':swift['counts'],'unchangedSessionSwift':backward['runtime']['counts'],
        'bindings':bindings['counts'],'abi':abi['counts']}
arch=(OUT/'architecture-check.log').read_text()
assert re.search(r'(?:ℹ|#) pass 14',arch) and re.search(r'(?:ℹ|#) fail 0',arch) and re.search(r'(?:ℹ|#) skipped 0',arch)
counts['architecture']={'executed':14,'passed':14,'failed':0,'skipped':0}
for count in counts.values():assert count['executed']==count['passed'] and count['executed'] and not count['failed'] and not count['skipped']
assert digest(OUT/'library/libeditac_ffi.dylib')==swift['library']['sha256']==bindings['library']['sha256']==backward['librarySha256']
assert digest(OUT/'fixture-binary/native-host-admission')==swift['authorityFixtureSha256']
assert all(digest(CORE/p)==h for p,h in receipt('unrelated-before.json').items())
paths=set()
for folder in ['crates/editac-core/src','crates/editac-session/src','crates/editac-ffi/src','crates/editac-security/src','crates/editac-security/tests','crates/editac-diff/src']:
    paths.update(p for p in (CORE/folder).rglob('*') if p.is_file())
for folder in ['crates/editac-ffi/generated','tests/native/session-command-proof','tests/native/session-probe']:
    paths.update(p for p in (CORE/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
paths.update([CORE/p for p in ['Cargo.toml','Cargo.lock','rust-toolchain.toml','crates/editac-ffi/Cargo.toml','crates/editac-security/Cargo.toml','crates/editac-security/examples/native-host-admission.rs','tests/native/bounded-bindings.py','tests/native/session-backward.py','tests/native/table-session-proof/AuthorityLifecycleCases.swift','tests/native/table-session-proof/HostTransportCases.swift','tests/native/table-session-proof/PresenceCases.swift','tests/native/table-session-proof/TablePolicyCases.swift','tests/native/table-session-proof/RemoteCases.swift','tests/native/table-session-proof/presence-oracle.mjs','tests/native/table-session-proof/stb-1.1-20261015/table-fixture/manifest.json','native/macos/tests/TablesFixture/corpus.json']])
for p in receipt('unrelated-before.json'):paths.add(CORE/p)
source={str(p.relative_to(CORE)):digest(p) for p in sorted(paths)}
architecture=CORE.parent/'architecture'
write('source-envelope.json',{'core':source,'architecture':{p:digest(architecture/p) for p in ['specs/client-contracts.md','specs/native-sdk-parity.md']},'toolchains':{'rust':subprocess.check_output(['rustc','+1.97.1','-Vv'],text=True).strip(),'node':subprocess.check_output(['/Users/bpstr/.nvm/versions/node/v24.19.0/bin/node','--version'],text=True).strip(),'swift':swift['toolchain']}})
artifacts={str(p.relative_to(OUT)):{'sha256':digest(p),'bytes':p.stat().st_size} for p in sorted(OUT.rglob('*')) if p.is_file() and p.name not in ['artifact-envelope.json','delivery.json'] and '__pycache__' not in p.parts}
write('artifact-envelope.json',artifacts)
write('delivery.json',{'id':'STB-1.4-b2-20261015','state':'implemented/verified; not main-integrated or deployed','qualifiedGates':['STB-1.4-b2','STB-1.4-b','STB-1.4-c','STB-1.4'], 'sourceRoadmapRevision':'d13a152297be458819482813ca5ec10ca4bc547830516e757b661184a0863526','loadedPromptRevision':'2e18a98412c7','sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=CORE,text=True).strip(),'architectureCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=architecture,text=True).strip(),'counts':counts,'totalFinalExecuted':sum(c['executed'] for c in counts.values()),'finalFailed':0,'finalSkipped':0,'initialFailures':{'hostFixtureCompile':1,'swiftCompileAttempt':1,'nativeRust':{'executed':62,'passed':61,'failed':1,'ignored':0,'filtered':0,'unexecutedRequestedSuites':5}},'artifacts':{'source-envelope.json':digest(OUT/'source-envelope.json'),'artifact-envelope.json':digest(OUT/'artifact-envelope.json'),'README.md':digest(OUT/'README.md')},'previousPrerequisites':['stb-1.4-a-20261015/delivery.json','stb-1.4-b-20261015/delivery.json'],'remainingGates':['STB-1.5','STB-1.6','STB-1.7 (MONITOR ONLY)'],'originalNativeAcceptanceClosed':False,'productionEncryptionQualified':False,'nativeUiImeQualified':False,'providerCalls':0,'publication':False,'mainIntegration':False})
print(json.dumps({'totalFinalExecuted':sum(c['executed'] for c in counts.values()),'failed':0,'skipped':0,'artifactFiles':len(artifacts),'sourceFiles':len(source)}))
