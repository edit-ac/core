"""Exact-input preflight and immutable native source-package preparation. Offline."""
import hashlib, io, json, os, pathlib, shutil, subprocess, sys, tarfile
ROOT = pathlib.Path.cwd()
OUT = pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve()
OUT.mkdir(parents=True, exist_ok=True)
commands = []
def run(args, name, cwd=ROOT):
    environment=dict(os.environ)
    environment['CARGO_TARGET_DIR']=str(OUT.parent/'build-target')
    environment['CARGO_INCREMENTAL']='0'
    environment['CARGO_BUILD_JOBS']='2'
    r = subprocess.run(args, cwd=cwd, capture_output=True, env=environment)
    (OUT / (name + '.log')).write_bytes(r.stdout + r.stderr)
    commands.append(dict(args=list(map(str,args)), cwd=str(cwd), exit=r.returncode))
    (OUT / 'prepare-commands.json').write_text(json.dumps(commands, indent=2)+'\n')
    if r.returncode:
        raise RuntimeError(f'{name} exit={r.returncode}; see retained log')
    return r.stdout

def digest(data): return hashlib.sha256(data).hexdigest()
manifest = 'crates/editac-formats-native/Cargo.toml'
pdf = os.environ.get('EDITAC_NATIVE_PDF') == '1'
metadata = json.loads(run(['cargo','metadata','--manifest-path',manifest,'--locked','--offline','--filter-platform','aarch64-apple-darwin','--format-version=1','--features','odt-export,odt-import,docx-export,epub-export'+(',pdf-export' if pdf else '')],'metadata'))
nodes={n['id']:n for n in metadata['resolve']['nodes']}
root=metadata['resolve']['root']; reached=set(); pending=[root]
while pending:
    n=pending.pop()
    if n in reached:continue
    reached.add(n)
    pending.extend(d['pkg'] for d in nodes[n]['deps'] if any(k['kind']!='dev' for k in d['dep_kinds']))
metadata['packages']=[p for p in metadata['packages'] if p['id'] in reached]
# Includes inherited root workspace manifests and path dependency sources; no
# generated target directories or working-copy caches are copied into the package.
local = [pathlib.Path(p['manifest_path']).parent for p in metadata['packages'] if not p['source']]
paths = {'Cargo.toml','Cargo.lock','LICENSE','scripts/licenses/docx-rs-0.4.22.LICENSE','scripts/licenses/docx-rs-0.4.22.source.json'}
if pdf: paths.update(str(p.relative_to(ROOT)) for p in (ROOT/'scripts/licenses').glob('krilla-0.8.2.*') if p.is_file())
for directory in local:
    relative = directory.relative_to(ROOT)
    if directory.name == 'editac-formats-native':
        paths.update(str(p.relative_to(ROOT)) for p in directory.rglob('*') if p.is_file() and 'target' not in p.parts and '__pycache__' not in p.parts)
    else:
        tracked = run(['git','ls-files','-z',str(relative)],'files-'+directory.name).split(b'\0')
        paths.update(p.decode() for p in tracked if p)
# Root workspace manifests may name members not otherwise in the selected graph.
# Include their manifests and empty src markers only? Instead preserve exact
# tracked workspace source files so Cargo never consumes a fabricated crate.
root_members = ['editac-html','editac-core','editac-wasm','editac-markdown','editac-markdown-wasm','editac-ffi','editac-session','editac-diff','editac-security','editac-highlighting']
for name in root_members:
    prefix = 'crates/'+name
    paths.update(p.decode() for p in run(['git','ls-files','-z',prefix],'workspace-files-'+name).split(b'\0') if p)
# Shared core compiles these versioned mappings outside its crate directory.
for folder in ('schema-v4','schema-v5'):
    paths.update(p.decode() for p in run(['git','ls-files','-z','fixtures/'+folder],'schema-files-'+folder).split(b'\0') if p)
    for required in ('mapping.rs','bounded_decoder.rs','policy.rs','seed.json'):
        if 'fixtures/'+folder+'/'+required not in paths:raise RuntimeError('missing compile input: '+folder+'/'+required)
# Preflight all inputs before any compiler or feature execution.
fixtures = ['tests/formats/rtf-reader.py','fixtures/formats/rtf/export/reader-probe.rtf','fixtures/formats/rtf/supported.rtf','fixtures/formats/native/rtf-loss.rtf']
for p in fixtures:
    if not (ROOT/p).is_file(): raise RuntimeError('missing exact fixture: '+p)
fixtures += [str(p.relative_to(ROOT)) for p in (ROOT/'fixtures/formats/table-text').rglob('*') if p.is_file()]
fixtures += ['tests/formats/consumers/odt-fixture.json','tests/formats/consumers/inspect-odt.py']
fixtures += [str(p.relative_to(ROOT)) for p in (ROOT/'fixtures/formats/odt/export/schema').rglob('*') if p.is_file()]
fixtures += ['fixtures/formats/odt/supported.xml','fixtures/formats/docx/probe/pixel.png','tests/formats/consumers/odt-import-fixtures.py']
fixtures += ['tests/formats/consumers/docx-fixture.json','tests/formats/inspect-epub-export.py']
fixtures += [str(p.relative_to(ROOT)) for p in (ROOT/'fixtures/formats/fonts').glob('*') if p.is_file()]
fixtures += [str(p.relative_to(ROOT)) for p in (ROOT/'fixtures/formats/pdf/export').glob('*') if p.is_file()]
fixtures += [str(p.relative_to(ROOT)) for p in (ROOT/'tests/formats').glob('*pdf*.py') if p.is_file()]
paths.update(fixtures)
paths.update(str(p.relative_to(ROOT)) for p in (ROOT/'tests/formats/consumers/native').glob('*') if p.is_file())
source_pins = {}
archive = OUT / 'native-source.tar'
with tarfile.open(archive,'w') as tar:
    for name in sorted(paths):
        p = ROOT/name
        if not p.is_file(): raise RuntimeError('missing source input: '+name)
        data = p.read_bytes(); source_pins[name]=dict(sha256=digest(data),bytes=len(data))
        info = tarfile.TarInfo(name); info.size=len(data);info.mode=0o644;info.mtime=0
        tar.addfile(info, io.BytesIO(data))
archive_hash=digest(archive.read_bytes())
consumer=OUT/('source-'+archive_hash[:16]);consumer.mkdir(exist_ok=True)
with tarfile.open(archive) as tar:
    for member in tar:
        if member.name not in source_pins or not member.isfile() or not (consumer/member.name).resolve().is_relative_to(consumer):
            raise RuntimeError('unsafe source member: '+member.name)
        target=consumer/member.name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(tar.extractfile(member).read())
for name, pin in source_pins.items():
    if digest((consumer/name).read_bytes())!=pin['sha256']:raise RuntimeError('source member mismatch: '+name)
notices=[]; records=[]; notice_pins={}
for package in sorted(metadata['packages'],key=lambda p:p['name']):
    if not package['source']:continue
    directory=pathlib.Path(package['manifest_path']).parent
    files=sorted(p for p in directory.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE','COPYING','NOTICE')))
    if not files:
        if package['name']=='yrs' and package['version']=='0.28.0':files=[ROOT/'scripts/licenses/yrs-0.28.0.LICENSE']
        elif package['name']=='docx-rs' and package['version']=='0.4.22':files=[ROOT/'scripts/licenses/docx-rs-0.4.22.LICENSE']
        elif package['name']=='krilla' and package['version']=='0.8.2':files=[p for p in (ROOT/'scripts/licenses').glob('krilla-0.8.2.*') if p.suffix!='.json']
        else:raise RuntimeError('missing exact notices: '+package['name'])
    records.append({k:package[k] for k in ('name','version','license','source')})
    notices.append('\n'+package['name']+' '+package['version']+' '+str(package['license'])+'\n')
    for p in files:
        data=p.read_bytes();notices.append(p.name+'\n'+data.decode()+'\n');notice_pins[str(p)]=digest(data)
(OUT/'THIRD-PARTY-NOTICES.txt').write_text(''.join(notices))
if pdf:
    notices.append('\nBundled optional Noto fonts; OFL-1.1\n'+(ROOT/'fixtures/formats/fonts/OFL.txt').read_text())
    (OUT/'THIRD-PARTY-NOTICES.txt').write_text(''.join(notices))
# Default and qualification executables are independently pinned and preserved.
builds = [('native',[]),('native-probe',['--features','qualification']),('odt-native',['--features','odt-export,odt-import']),('odt-probe',['--features','odt-export,odt-import,qualification']),('docx-native',['--features','docx-export']),('docx-probe',['--features','docx-export,qualification']),('epub-native',['--features','epub-export']),('epub-probe',['--features','epub-export,qualification'])]
if pdf: builds += [('pdf-native',['--features','pdf-export']),('pdf-probe',['--features','pdf-export,qualification'])]
for label,features in builds:
    optimized = label.startswith('pdf-')
    run(['cargo','build','--manifest-path',manifest,'--locked','--offline',*(['--release'] if optimized else []),*features], 'build-'+label,consumer)
    built=OUT.parent/'build-target'/('release' if optimized else 'debug')/'editac-formats-native'
    shutil.copy2(built,OUT/label)
receipt=dict(schemaVersion=1, archive=str(archive),archiveSha256=archive_hash,archiveBytes=archive.stat().st_size,
    consumer=str(consumer),sourcePins=source_pins,noticePins=notice_pins,dependencies=records,
    noticesSha256=digest((OUT/'THIRD-PARTY-NOTICES.txt').read_bytes()),
    fixtures={p:digest((ROOT/p).read_bytes()) for p in fixtures},
    binaries={label:dict(path=str(OUT/label),sha256=digest((OUT/label).read_bytes()),bytes=(OUT/label).stat().st_size) for label,_ in builds})
(OUT/'prepared.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(dict(sourceMembers=len(source_pins),dependencies=len(records),archiveBytes=receipt['archiveBytes'],binaries=receipt['binaries'])))
