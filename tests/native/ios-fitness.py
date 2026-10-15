#!/usr/bin/env python3
"""PRF-07 fixed native scenario. Private simulator; no network/provider fixtures."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shlex
import shutil
import subprocess

CORE = Path(__file__).resolve().parents[2]
BUNDLE = 'ac.edit.nativefitness'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def project(directory, library):
    """Minimal standalone app/UI-test project, all source inputs pinned by caller."""
    directory.mkdir()
    objects = {}
    def obj(name, value):
        key = hashlib.sha256(name.encode()).hexdigest()[:24].upper()
        objects[key] = value
        return key
    def q(v): return json.dumps(str(v))
    def refs(values): return '(' + ','.join(values) + ',)'
    def conf(name, settings): return obj(name, '{isa=XCBuildConfiguration; name=' + q(name.rsplit('-', 1)[-1]) + '; buildSettings={' + ''.join(k+'='+v+';' for k,v in settings.items()) + '};}')
    def configs(name, settings):
        ids = [conf(name+'-'+mode, settings) for mode in ['Debug', 'Release']]
        return obj(name+'-configs', '{isa=XCConfigurationList; buildConfigurations='+refs(ids)+'; defaultConfigurationIsVisible=0; defaultConfigurationName=Release;}')
    common = {'ARCHS':'arm64','ONLY_ACTIVE_ARCH':'YES','SDKROOT':'iphonesimulator','IPHONEOS_DEPLOYMENT_TARGET':'26.5','SWIFT_VERSION':'5.0','TARGETED_DEVICE_FAMILY':'1','CODE_SIGNING_ALLOWED':'NO','GENERATE_INFOPLIST_FILE':'YES','SWIFT_OPTIMIZATION_LEVEL':q('-O'),'CLANG_ENABLE_MODULES':'YES'}
    appSettings = dict(common, PRODUCT_BUNDLE_IDENTIFIER=q(BUNDLE), PRODUCT_NAME=q('NativeFitness'), INFOPLIST_KEY_UILaunchScreen_Generation='YES',
        SWIFT_INCLUDE_PATHS=q(CORE/'crates/editac-ffi/generated'), OTHER_SWIFT_FLAGS=refs([q('-Xcc'),q('-fmodule-map-file='+str(CORE/'crates/editac-ffi/generated/EditacNativeFFI.modulemap'))]),
        OTHER_LDFLAGS=refs([q(library),q('-lc++')]))
    testSettings = dict(common, PRODUCT_BUNDLE_IDENTIFIER=q(BUNDLE+'.uitests'), PRODUCT_NAME=q('NativeFitnessUITests'), TEST_TARGET_NAME=q('NativeFitness'))
    appConfigs = configs('app', appSettings); testConfigs = configs('tests', testSettings)
    def file(name, path, kind): return obj(name, '{isa=PBXFileReference; lastKnownFileType='+kind+'; path='+q(path)+'; sourceTree="<absolute>";}')
    appSource = file('app-source', CORE/'native/ios/fitness/NativeFitness.swift', 'sourcecode.swift')
    bridge = file('bridge', CORE/'crates/editac-ffi/generated/EditacNative.swift','sourcecode.swift')
    testSource = file('test-source', CORE/'native/ios/fitness/NativeFitnessUITests.swift','sourcecode.swift')
    fixture = file('fixture', CORE/'tests/native/fixtures/bounded-abi.json','text.json')
    appProduct = obj('app-product','{isa=PBXFileReference; explicitFileType=wrapper.application; path=NativeFitness.app; sourceTree=BUILT_PRODUCTS_DIR;}')
    testProduct = obj('test-product','{isa=PBXFileReference; explicitFileType=wrapper.cfbundle; path=NativeFitnessUITests.xctest; sourceTree=BUILT_PRODUCTS_DIR;}')
    def phase(name, kind, sources):
        builds = [obj(name+str(i), '{isa=PBXBuildFile; fileRef='+source+';}') for i,source in enumerate(sources)]
        return obj(name, '{isa='+kind+'; buildActionMask=2147483647; files='+refs(builds)+'; runOnlyForDeploymentPostprocessing=0;}')
    workloads = [file('workload-'+name+suffix, directory.parent/'fixtures'/(name+suffix+'.json'), 'text.json') for name in ['Task','Long'] for suffix in ['', '.native-checkpoint', '.native-snapshot']]
    appPhases = [phase('app-sources','PBXSourcesBuildPhase',[appSource,bridge]),phase('app-resources','PBXResourcesBuildPhase',[fixture]+workloads)]
    testPhases = [phase('tests-sources','PBXSourcesBuildPhase',[testSource])]
    app = obj('app-target','{isa=PBXNativeTarget; buildConfigurationList='+appConfigs+'; buildPhases='+refs(appPhases)+'; buildRules=(); dependencies=(); name=NativeFitness; productName=NativeFitness; productReference='+appProduct+'; productType="com.apple.product-type.application";}')
    dep = obj('test-dependency','{isa=PBXTargetDependency; target='+app+';}')
    tests = obj('tests-target','{isa=PBXNativeTarget; buildConfigurationList='+testConfigs+'; buildPhases='+refs(testPhases)+'; buildRules=(); dependencies='+refs([dep])+'; name=NativeFitnessUITests; productName=NativeFitnessUITests; productReference='+testProduct+'; productType="com.apple.product-type.bundle.ui-testing";}')
    group = obj('main-group','{isa=PBXGroup; children='+refs([appSource,bridge,testSource,fixture,appProduct,testProduct])+'; sourceTree="<group>";}')
    root = obj('project','{isa=PBXProject; attributes={LastUpgradeCheck=2660; TargetAttributes={'+tests+'={TestTargetID='+app+';};};}; buildConfigurationList='+configs('project',common)+'; compatibilityVersion="Xcode 14.0"; developmentRegion=en; hasScannedForEncodings=0; knownRegions=(en,Base); mainGroup='+group+'; projectDirPath=""; projectRoot=""; targets='+refs([app,tests])+';}')
    (directory/'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion=1; classes={}; objectVersion=56; objects={'+''.join(k+'='+v+';\n' for k,v in objects.items())+'}; rootObject='+root+';}\n')
    scheme = directory/'xcshareddata/xcschemes/NativeFitness.xcscheme'; scheme.parent.mkdir(parents=True)
    def reference(key, name): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{key}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:NativeFitness.xcodeproj"/>'
    scheme.write_text('<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2660" version="1.3"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries>'+''.join('<BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">'+reference(k,n)+'</BuildActionEntry>' for k,n in [(app,'NativeFitness.app'),(tests,'NativeFitnessUITests.xctest')])+'</BuildActionEntries></BuildAction><TestAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">'+reference(tests,'NativeFitnessUITests.xctest')+'</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Release"/><ProfileAction buildConfiguration="Release"/><AnalyzeAction buildConfiguration="Release"/><ArchiveAction buildConfiguration="Release"/></Scheme>')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True); args = parser.parse_args()
    output = args.output.resolve(); output.relative_to(CORE); output.mkdir(parents=True, exist_ok=False)
    profilePath = CORE/'benchmarks/profiles/native-input-v1.json'; profile = json.loads(profilePath.read_text())
    record = {'version':1, 'qualification':'unqualified', 'state':'unfinished', 'profileHash':digest(profilePath), 'startedUtc':datetime.now(timezone.utc).isoformat(),
              'counts':{'executed':0,'passed':0,'failed':0,'skipped':0}, 'checks':[], 'sourceInputs':{}, 'artifacts':{}, 'cleanup':{},
              'metadata':{'provenance':'iOS Simulator', 'physical':False, 'hostOS':platform.platform(), 'machine':platform.machine()}}
    env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
    env['PATH'] = str(Path.home()/'.cargo/bin')+':'+env['PATH']
    simulator = None
    derived = CORE/'target/native-fitness-xcode'
    target = CORE/'target/native-fitness'
    def run(name, command, timeout=300, allowFailure=False):
        log = output/(name+'.log')
        timedOut = False
        with log.open('w') as stream:
            done = subprocess.Popen([str(x) for x in command], cwd=CORE, env=env, stdout=stream, stderr=subprocess.STDOUT)
            try: done.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timedOut = True; done.terminate()
                try: done.wait(timeout=15)
                except subprocess.TimeoutExpired: done.kill(); done.wait()
        record['checks'].append({'id':name,'command':shlex.join([str(x) for x in command]),'pid':done.pid,'workspace':str(CORE),'timeout':timedOut,'exit':done.returncode,'log':log.name,'sha256':digest(log)})
        if (done.returncode or timedOut) and not allowFailure: raise RuntimeError(f'{name}: exit {done.returncode}, timeout={timedOut}; {log}')
        return log.read_text()
    try:
        record['metadata']['node'] = run('node-version',['node','--version']).strip()
        assert record['metadata']['node'] == 'v'+(CORE/'.node-version').read_text().strip()
        record['metadata']['revision'] = run('revision',['git','rev-parse','HEAD']).strip()
        record['metadata']['cpu'] = run('cpu',['sysctl','-n','machdep.cpu.brand_string']).strip()
        record['metadata']['memoryBytes'] = int(run('memory',['sysctl','-n','hw.memsize']).strip())
        record['metadata']['cores'] = int(run('cores',['sysctl','-n','hw.ncpu']).strip())
        runtimes = json.loads(run('simulator-runtimes',['xcrun','simctl','list','runtimes','-j']))
        runtime = next(r for r in runtimes['runtimes'] if r['identifier'] == profile['runtime'])
        assert runtime['isAvailable'] and runtime['buildversion'] == profile['runtimeBuildVersion']
        record['metadata']['runtime'] = {k:runtime[k] for k in ['identifier','version','buildversion','isAvailable']}
        version = run('xcode',['xcodebuild','-version']).strip(); assert version == 'Xcode 26.6\nBuild version 17F113'
        record['metadata']['xcode'] = version
        record['metadata']['swift'] = run('swift',['xcrun','swiftc','--version']).strip()
        sdk = run('sdk',['xcrun','--sdk','iphonesimulator','--show-sdk-path']).strip(); env['SDKROOT'] = sdk; env['IPHONEOS_DEPLOYMENT_TARGET'] = '26.5'
        assert run('sdk-version',['xcrun','--sdk','iphonesimulator','--show-sdk-version']).strip() == '26.5'
        sources = [CORE/'.node-version', CORE/'scripts/prepare-native-workloads.mjs', CORE/'benchmarks/fixtures.mjs', CORE/'crates/editac-ffi/examples/fitness-seed.rs', CORE/'fixtures/schema-v5/mapping.rs', CORE/'fixtures/schema-v5/seed.json', profilePath,Path(__file__),CORE/'native/ios/fitness/NativeFitness.swift',CORE/'native/ios/fitness/NativeFitnessUITests.swift',CORE/'tests/native/fixtures/bounded-abi.json',CORE/'Cargo.toml',CORE/'Cargo.lock']
        for crate in ['editac-core','editac-ffi','editac-wasm']:
            sources += [CORE/f'crates/{crate}/Cargo.toml'] + sorted((CORE/f'crates/{crate}/src').rglob('*.rs'))
        sources += sorted((CORE/'crates/editac-ffi/generated').glob('*'))
        record['sourceInputs'] = {str(p.relative_to(CORE)):digest(p) for p in sources if p.is_file()}
        for p in sources:
            if p.is_file():
                retained = output/'sources'/p.relative_to(CORE); retained.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,retained)
        cargo = [Path.home()/'.cargo/bin/cargo','+1.97.1']
        graphCommand = cargo+['tree','--locked','--offline','--target','aarch64-apple-ios-sim','-p','editac-ffi','--edges','normal,build,features','--prefix','none','--format','{p}|{f}']
        graph = run('native-target-graph',graphCommand)
        rust = run('native-rustc',[Path.home()/'.cargo/bin/rustc','+1.97.1','-vV'])
        run('native-build',cargo+['build','-p','editac-ffi','--lib','--release','--target','aarch64-apple-ios-sim','--target-dir',target,'--locked','--offline'],timeout=900)
        assert run('native-target-graph-after',graphCommand) == graph, 'native target graph changed during build'
        library = target/'aarch64-apple-ios-sim/release/libeditac_ffi.a'
        record['libraryHash'] = digest(library)
        shutil.copy2(library,output/'libeditac_ffi.a')
        record['nativeBuild'] = {'target':'aarch64-apple-ios-sim','package':'editac-ffi','profile':'release','features':'default',
                                 'graphHash':digest(output/'native-target-graph.log'),'rustcHash':digest(output/'native-rustc.log'),
                                 'libraryHash':record['libraryHash'],'measurementReuse':False}
        run('seed-build',cargo+['build','-p','editac-ffi','--example','fitness-seed','--release','--locked','--offline'],timeout=600)
        shutil.copy2(CORE/'target/release/examples/fitness-seed',output/'fitness-seed')
        run('workload-seeds',['node','scripts/prepare-native-workloads.mjs',output/'fixtures',output/'fitness-seed'],timeout=900)
        project(output/'NativeFitness.xcodeproj',library)
        run('xcode-build',['xcodebuild','build-for-testing','-project',output/'NativeFitness.xcodeproj','-scheme','NativeFitness','-configuration','Release','-destination','generic/platform=iOS Simulator','-derivedDataPath',derived,'CODE_SIGNING_ALLOWED=NO'],timeout=900)
        simulator = run('simulator-create',['xcrun','simctl','create','editac-PRF07-'+str(os.getpid()),profile['device'],profile['runtime']]).strip()
        record['metadata']['simulator'] = {'udid':simulator,'device':profile['device'],'runtime':profile['runtime'],'ownership':'created by this harness'}
        # Configure only this new, private simulator before first boot. Actual
        # UITextInputMode and marked calls must independently prove admission.
        preferences = Path.home()/'Library/Developer/CoreSimulator/Devices'/simulator/'data/Library/Preferences/.GlobalPreferences.plist'
        values = plistlib.loads(preferences.read_bytes()) if preferences.exists() else {}
        values['AppleKeyboards'] = ['en_US', profile['cjk']['keyboard']]
        values['AppleLanguages'] = ['en-US', 'zh-Hans']
        preferences.parent.mkdir(parents=True, exist_ok=True); preferences.write_bytes(plistlib.dumps(values))
        shutil.copy2(preferences, output/'simulator-keyboard-preferences.plist')
        run('simulator-boot' ,['xcrun','simctl','boot',simulator]); run('simulator-ready',['xcrun','simctl','bootstatus',simulator,'-b'],timeout=300)
        # Actual XCUITest injects OS keyboard events and queries/actions OS accessibility.
        run('xctest',['xcodebuild','test-without-building','-project',output/'NativeFitness.xcodeproj','-scheme','NativeFitness','-configuration','Release','-destination','platform=iOS Simulator,id='+simulator,'-derivedDataPath',derived,'-resultBundlePath',output/'NativeFitness.xcresult','-parallel-testing-enabled','NO','CODE_SIGNING_ALLOWED=NO'],timeout=900,allowFailure=True)
        xctest = record['checks'][-1]
        # Always collect runtime/test failures before deleting the private simulator.
        containerText = run('container',['xcrun','simctl','get_app_container',simulator,BUNDLE,'data'],allowFailure=True).strip()
        resultPath = Path(containerText)/'Documents/result.json' if record['checks'][-1]['exit'] == 0 else None
        result = None
        cjkResult = None
        if resultPath is not None and (resultPath.parent/'partial.json').is_file(): shutil.copy2(resultPath.parent/'partial.json',output/'partial.json')
        if resultPath is not None and resultPath.is_file():
            shutil.copy2(resultPath,output/'native-result.json')
            result = json.loads((output/'native-result.json').read_text())
            record['counts'] = result['counts']
        if resultPath is not None:
            for name in ['cjk-partial.json','cjk-result.json','Task-result.json','Long-result.json','Task-partial.json','Long-partial.json'] + [n+'-'+suffix for n in ['Task','Long'] for suffix in ['final-snapshot.json','reopened-snapshot.json','checkpoint.bin','checkpoint-metadata.json']]:
                if (resultPath.parent/name).is_file(): shutil.copy2(resultPath.parent/name,output/name)
            if (output/'cjk-result.json').is_file():
                cjkResult = json.loads((output/'cjk-result.json').read_text()); record['cjkCounts'] = cjkResult['counts']
        run('xcresult-summary' ,['xcrun','xcresulttool','get','test-results','summary','--path',output/'NativeFitness.xcresult','--format','json'],allowFailure=True)
        if record['checks'][-1]['exit'] == 0:
            summary = json.loads((output/'xcresult-summary.log').read_text())
            record['xctestCounts'] = {k:summary.get(k) for k in ['totalTestCount','passedTests','failedTests','skippedTests']}
        run('attachments',['xcrun','xcresulttool','export','attachments','--path',output/'NativeFitness.xcresult','--output-path',output/'attachments'],allowFailure=True)
        matches = []; cjkMatches = []
        if (output/'attachments').exists():
            for p in (output/'attachments').rglob('*'):
                if p.is_file():
                    try:
                        value = json.loads(p.read_text())
                        if isinstance(value,dict) and value.get('client') == 'XCTest XCUIElement OS accessibility query/action': matches.append(value)
                        if isinstance(value,dict) and value.get('client') == 'XCTest OS Pinyin candidate accessibility query/action': cjkMatches.append(value)
                    except (ValueError,UnicodeError): pass
        if len(matches) == 1: (output/'accessibility.json').write_text(json.dumps(matches[0],indent=2)+'\n')
        if len(cjkMatches) == 1: (output/'cjk-accessibility.json').write_text(json.dumps(cjkMatches[0],indent=2,ensure_ascii=False)+'\n')
        executable = derived/'Build/Products/Release-iphonesimulator/NativeFitness.app/NativeFitness'
        if executable.exists():
            shutil.copy2(executable,output/'NativeFitness')
            shutil.copytree(executable.parent,output/'NativeFitness.app')
            shutil.copy2(library,output/'libeditac_ffi.a')
        assert xctest['exit'] == 0 and not xctest['timeout'], 'XCTest failed; retained result/summary/attachments'
        assert result is not None, 'actual native app result missing'
        assert result['counts'] == {'executed':5,'passed':5,'failed':0,'skipped':0}, result['counts']
        assert record.get('xctestCounts') == {'totalTestCount':4,'passedTests':4,'failedTests':0,'skippedTests':0}, record.get('xctestCounts')
        assert len(matches) == 1, 'missing actual XCTest accessibility attachment'
        assert cjkResult is not None and cjkResult['counts'] == {'executed':6,'passed':6,'failed':0,'skipped':0}, record.get('cjkCounts')
        assert len(cjkMatches) == 1, 'missing OS CJK candidate accessibility attachment'
        record['workloadCounts'] = {}
        for name in profile['workloads']['names']:
            value = json.loads((output/(name+'-result.json')).read_text())
            record['workloadCounts'][name] = value['counts']
            assert value['counts'] == {'executed':3,'passed':3,'failed':0,'skipped':0}, value
        record['state'] = 'diagnostic-delivered'
    except Exception as error:
        record['state'] = 'failed'; record['error'] = str(error)
    finally:
        if simulator:
            run('simulator-terminate',['xcrun','simctl','terminate',simulator,BUNDLE],allowFailure=True)
            run('simulator-shutdown',['xcrun','simctl','shutdown',simulator],allowFailure=True)
            run('simulator-delete',['xcrun','simctl','delete',simulator],allowFailure=True)
            devicesText = run('simulator-final',['xcrun','simctl','list','devices','-j'],allowFailure=True)
            record['cleanup']['simulatorDeleted'] = False
            if record['checks'][-1]['exit'] == 0:
                devices = json.loads(devicesText)
                record['cleanup']['simulatorDeleted'] = not any(d.get('udid') == simulator for ds in devices['devices'].values() for d in ds)
            if not record['cleanup']['simulatorDeleted']:
                record['state'] = 'failed'; record['error'] = 'private simulator teardown unverified'
        record['finishedUtc'] = datetime.now(timezone.utc).isoformat()
        record['artifacts'] = {str(p.relative_to(output)):digest(p) for p in output.rglob('*') if p.is_file()}
        (output/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps({k:record.get(k) for k in ['state','counts','xctestCounts','error']}))
    return 0 if record['state'] == 'diagnostic-delivered' else 1

if __name__ == '__main__': raise SystemExit(main())
