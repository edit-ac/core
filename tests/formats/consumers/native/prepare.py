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
metadata = json.loads(run(['cargo','metadata','--manifest-path',manifest,'--locked','--offline','--filter-platform','aarch64-apple-darwin','--format-version=1'],'metadata'))
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
paths = {'Cargo.toml','Cargo.lock','LICENSE'}
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
fixtures = ['fixtures/formats/rtf/supported.rtf','fixtures/formats/native/rtf-loss.rtf']
for p in fixtures:
    if not (ROOT/p).is_file(): raise RuntimeError('missing exact fixture: '+p)
paths.update(fixtures)
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
        else:raise RuntimeError('missing exact notices: '+package['name'])
    records.append({k:package[k] for k in ('name','version','license','source')})
    notices.append('\n'+package['name']+' '+package['version']+' '+str(package['license'])+'\n')
    for p in files:
        data=p.read_bytes();notices.append(p.name+'\n'+data.decode()+'\n');notice_pins[str(p)]=digest(data)
(OUT/'THIRD-PARTY-NOTICES.txt').write_text(''.join(notices))
# Default and qualification executables are independently pinned and preserved.
for label,features in [('native',[]),('native-probe',['--features','qualification'])]:
    run(['cargo','build','--manifest-path',manifest,'--locked','--offline',*features], 'build-'+label,consumer)
    built=OUT.parent/'build-target/debug/editac-formats-native'
    shutil.copy2(built,OUT/label)
receipt=dict(schemaVersion=1, archive=str(archive),archiveSha256=archive_hash,archiveBytes=archive.stat().st_size,
    consumer=str(consumer),sourcePins=source_pins,noticePins=notice_pins,dependencies=records,
    noticesSha256=digest((OUT/'THIRD-PARTY-NOTICES.txt').read_bytes()),
    fixtures={p:digest((ROOT/p).read_bytes()) for p in fixtures},
    binaries={label:dict(path=str(OUT/label),sha256=digest((OUT/label).read_bytes()),bytes=(OUT/label).stat().st_size) for label in ('native','native-probe')})
(OUT/'prepared.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(dict(sourceMembers=len(source_pins),dependencies=len(records),archiveBytes=receipt['archiveBytes'],binaries=receipt['binaries'])))
