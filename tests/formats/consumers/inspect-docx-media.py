"""Independent original ZIP/XML/PNG facts versus actual packed live/storage output."""
import copy,hashlib,json,pathlib,struct,sys,zipfile
from xml.etree import ElementTree as ET
out=pathlib.Path(sys.argv[1]);actual=json.loads((out/'browser-docx-media-projection.json').read_text())
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
with zipfile.ZipFile(out/'docx-import-fixtures/media.docx') as z:
    original=(out/'docx-import-fixtures/media.docx').read_bytes();pixel=z.read('word/media/pixel.png');tree=ET.fromstring(z.read('word/document.xml'))
width,height=struct.unpack('>II',pixel[16:24]);sha=hashlib.sha256(pixel).hexdigest();props=tree.find('.//{'+WP+'}docPr')
paragraphs=[''.join(n.text or '' for n in p.iter('{'+W+'}t')) for p in tree.find('{'+W+'}body').findall('{'+W+'}p') if not p.findall('.//{'+W+'}drawing')]
cells=[[''.join(t.text or '' for t in c.iter('{'+W+'}t')) for c in row.findall('{'+W+'}tc')] for row in tree.find('.//{'+W+'}tbl').findall('{'+W+'}tr')]
def inspect(v):
    blocks=v['blocks'];assert [ ''.join(r['text'] for r in b['runs']) for b in blocks if (b.get('attributes') or {}).get('type')!='content']==paragraphs,'paragraphs'
    table=next(b['attributes']['tuple'] for b in blocks if (b.get('attributes') or {}).get('tuple',[''])[0]=='module:editac.table')
    assert [[''.join(run[0] for run in cell) for cell in row] for row in table[2]['rows']]==cells,'cells'
    assets=[n for n in v['after']['visible'] if (n.get('blockAttributes') or [''])[0]=='module:editac.asset'];assert len(assets)==1,'asset count'
    d=assets[0]['blockAttributes'][2];assert d['identity']=={'host':'fixture-host','key':'docx-original-png'},'identity'
    m=d['metadata'];assert m['sha256']==sha and m['byteLength']==len(pixel),'hash/bytes'
    assert (m['width'],m['height'])==(width,height),'dimensions'
    assert m['alt']==props.get('descr','') and m['caption']==props.get('title',''),'accessibility'
    assert v['retained']==list(pixel) and v['reopenedOriginal']==list(pixel),'retained original'
    assert v['original']==list(original) and v['retainedPackage']==list(original) and v['reopenedPackage']==list(original),'original package'
    assert v['reopened']==v['after']['visible'],'reopen'
    assert v['updates']==1 and v['after']['history']['undoGroups']==1,'one content/history update'
    assert len(v['entries'])==1,'one durable update'
    assert v['siblingBefore']==v['siblingAfter'],'sibling'
    assert v['completion']['localCommit']['state']=='localCommitted','durability'
    assert any(d['code']=='EXTERNAL_RELATIONSHIP_INERT' for d in v['diagnostics']),'inert link diagnostic'
inspect(actual)
mutations=[]
def reject(name,mutate):
    v=copy.deepcopy(actual);mutate(v)
    try:inspect(v)
    except (AssertionError,KeyError,IndexError,StopIteration):mutations.append(name);return
    raise AssertionError('accepted '+name)
reject('changed-original-byte',lambda v:v['retained'].__setitem__(0,1))
reject('changed-reopened-byte',lambda v:v['reopenedOriginal'].pop())
def asset(v):return next(n['blockAttributes'][2] for n in v['after']['visible'] if (n.get('blockAttributes') or [''])[0]=='module:editac.asset')
reject('wrong-identity',lambda v:asset(v)['identity'].update(key='wrong'))
reject('corrupt-digest',lambda v:asset(v)['metadata'].update(sha256='0'*64))
reject('wrong-dimensions',lambda v:asset(v)['metadata'].update(width=999))
reject('lost-alt',lambda v:asset(v)['metadata'].update(alt='wrong'))
reject('duplicate-update',lambda v:v.update(updates=2))
reject('extra-durable-update',lambda v:v['entries'].append(v['entries'][0]))
reject('lost-sibling',lambda v:v.update(siblingAfter=None))
reject('changed-reopen',lambda v:v.update(reopened=[]))
reject('missing-diagnostic',lambda v:v.update(diagnostics=[]))
reject('lost-original-package',lambda v:v['original'].pop())
reject('lost-reopened-package',lambda v:v['reopenedPackage'].pop())
receipt={'state':'passed','oracle':'Python stdlib ZIP/XML/PNG + independently observed live/history/update journal/reopen/originals','sourceSha256':hashlib.sha256(original).hexdigest(),'pngSha256':sha,'pngBytes':len(pixel),'dimensions':[width,height],'negativeMutations':mutations,'passed':1,'failed':0,'skipped':0}
(out/'docx-media-independent.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
