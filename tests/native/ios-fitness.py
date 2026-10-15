#!/usr/bin/env python3
"""PRF-07 fixed native scenario. Private simulator; no network/provider fixtures."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
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
    appPhases = [phase('app-sources','PBXSourcesBuildPhase',[appSource,bridge]),phase('app-resources','PBXResourcesBuildPhase',[fixture])]
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
        sources = [profilePath,Path(__file__),CORE/'native/ios/fitness/NativeFitness.swift',CORE/'native/ios/fitness/NativeFitnessUITests.swift',CORE/'tests/native/fixtures/bounded-abi.json',CORE/'Cargo.toml',CORE/'Cargo.lock']
        for crate in ['editac-core','editac-ffi','editac-wasm']:
            sources += [CORE/f'crates/{crate}/Cargo.toml'] + sorted((CORE/f'crates/{crate}/src').rglob('*.rs'))
        sources += sorted((CORE/'crates/editac-ffi/generated').glob('*'))
        record['sourceInputs'] = {str(p.relative_to(CORE)):digest(p) for p in sources if p.is_file()}
        for p in sources:
            if p.is_file():
                retained = output/'sources'/p.relative_to(CORE); retained.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,retained)
        run('native-build',[Path.home()/'.cargo/bin/cargo','+1.97.1','build','-p','editac-ffi','--lib','--release','--target','aarch64-apple-ios-sim','--target-dir',target,'--locked'],timeout=900)
        library = target/'aarch64-apple-ios-sim/release/libeditac_ffi.a'
        record['libraryHash'] = digest(library)
        project(output/'NativeFitness.xcodeproj',library)
        run('xcode-build',['xcodebuild','build-for-testing','-project',output/'NativeFitness.xcodeproj','-scheme','NativeFitness','-configuration','Release','-destination','generic/platform=iOS Simulator','-derivedDataPath',derived,'CODE_SIGNING_ALLOWED=NO'],timeout=900)
        simulator = run('simulator-create',['xcrun','simctl','create','editac-PRF07-'+str(os.getpid()),profile['device'],profile['runtime']]).strip()
        record['metadata']['simulator'] = {'udid':simulator,'device':profile['device'],'runtime':profile['runtime'],'ownership':'created by this harness'}
        run('simulator-boot',['xcrun','simctl','boot',simulator]); run('simulator-ready',['xcrun','simctl','bootstatus',simulator,'-b'],timeout=300)
        # Actual XCUITest injects OS keyboard events and queries/actions OS accessibility.
        run('xctest',['xcodebuild','test-without-building','-project',output/'NativeFitness.xcodeproj','-scheme','NativeFitness','-configuration','Release','-destination','platform=iOS Simulator,id='+simulator,'-derivedDataPath',derived,'-resultBundlePath',output/'NativeFitness.xcresult','-parallel-testing-enabled','NO','CODE_SIGNING_ALLOWED=NO'],timeout=900,allowFailure=True)
        xctest = record['checks'][-1]
        # Always collect runtime/test failures before deleting the private simulator.
        containerText = run('container',['xcrun','simctl','get_app_container',simulator,BUNDLE,'data'],allowFailure=True).strip()
        resultPath = Path(containerText)/'Documents/result.json' if record['checks'][-1]['exit'] == 0 else None
        result = None
        if resultPath is not None and (resultPath.parent/'partial.json').is_file(): shutil.copy2(resultPath.parent/'partial.json',output/'partial.json')
        if resultPath is not None and resultPath.is_file():
            shutil.copy2(resultPath,output/'native-result.json')
            result = json.loads((output/'native-result.json').read_text())
            record['counts'] = result['counts']
        run('xcresult-summary',['xcrun','xcresulttool','get','test-results','summary','--path',output/'NativeFitness.xcresult','--format','json'],allowFailure=True)
        if record['checks'][-1]['exit'] == 0:
            summary = json.loads((output/'xcresult-summary.log').read_text())
            record['xctestCounts'] = {k:summary.get(k) for k in ['totalTestCount','passedTests','failedTests','skippedTests']}
        run('attachments',['xcrun','xcresulttool','export','attachments','--path',output/'NativeFitness.xcresult','--output-path',output/'attachments'],allowFailure=True)
        matches = []
        if (output/'attachments').exists():
            for p in (output/'attachments').rglob('*'):
                if p.is_file():
                    try:
                        value = json.loads(p.read_text())
                        if isinstance(value,dict) and value.get('client') == 'XCTest XCUIElement OS accessibility query/action': matches.append(value)
                    except (ValueError,UnicodeError): pass
        if len(matches) == 1: (output/'accessibility.json').write_text(json.dumps(matches[0],indent=2)+'\n')
        executable = derived/'Build/Products/Release-iphonesimulator/NativeFitness.app/NativeFitness'
        if executable.exists():
            shutil.copy2(executable,output/'NativeFitness')
            shutil.copytree(executable.parent,output/'NativeFitness.app')
            shutil.copy2(library,output/'libeditac_ffi.a')
        assert xctest['exit'] == 0 and not xctest['timeout'], 'XCTest failed; retained result/summary/attachments'
        assert result is not None, 'actual native app result missing'
        assert result['counts'] == {'executed':5,'passed':5,'failed':0,'skipped':0}, result['counts']
        assert record.get('xctestCounts') == {'totalTestCount':1,'passedTests':1,'failedTests':0,'skippedTests':0}, record.get('xctestCounts')
        assert len(matches) == 1, 'missing actual XCTest accessibility attachment'
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
