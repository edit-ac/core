"""Independent ODF ZIP/XML text/style/list/table/PNG versus real worker/live storage."""
import copy,hashlib,json,pathlib,struct,sys,zipfile
from xml.etree import ElementTree as ET
out=pathlib.Path(sys.argv[1]);actual=json.loads((out/'browser-odt-media-projection.json').read_text())
ns={k:'urn:oasis:names:tc:opendocument:xmlns:'+v+':1.0' for k,v in [('o','office'),('t','text'),('tb','table'),('d','drawing'),('s','style'),('svg','svg-compatible')]};ns['x']='http://www.w3.org/1999/xlink';ns['fo']='urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'
original=(out/'odt-import-fixtures/media.odt').read_bytes()
with zipfile.ZipFile(out/'odt-import-fixtures/media.odt') as z:
 assert z.read('mimetype')==b'application/vnd.oasis.opendocument.text';tree=ET.fromstring(z.read('content.xml'));pixel=z.read('Pictures/pixel.png')
def q(k,n):return '{'+ns[k]+'}'+n
def text(n):
 if n.tag==q('t','s'):return ' '*int(n.get(q('t','c'),'1'))
 if n.tag==q('t','tab'):return '\t'
 if n.tag==q('t','line-break'):return '\n'
 return (n.text or '')+''.join(text(c)+(c.tail or '') for c in n)
body=tree.find('./o:body/o:text',ns)
# All source paragraphs outside table cells and standalone images, in authored order.
paragraphs=[]
def walk(n):
 if n.tag==q('tb','table'):return
 if n.tag in [q('t','p'),q('t','h')]:
  if n.find('d:frame',ns) is None:paragraphs.append(text(n))
  return
 for c in n:walk(c)
walk(body)
cells=[[text(c.find('t:p',ns)) for c in row.findall('tb:table-cell',ns)] for row in body.find('tb:table',ns).findall('tb:table-row',ns)]
sha=hashlib.sha256(pixel).hexdigest();width,height=struct.unpack('>II',pixel[16:24]);frame=body.find('.//d:frame',ns)
def inspect(v):
 blocks=v['blocks'];ps=[b for b in blocks if (b.get('attributes') or {}).get('type')!='content'];assert [''.join(r['text'] for r in b['runs']) for b in ps]==paragraphs,'paragraphs'
 assert ps[0]['attributes']=={'type':'heading','level':2},'heading'
 assert ps[1]['runs'][1]=={'text':'B','marks':[{'mark':'bold','href':None}]},'bold'
 assert ps[1]['runs'][2]=={'text':'C🙂','marks':[{'mark':'bold','href':None},{'mark':'italic','href':None}]},'inherited marks'
 assert ps[2]['runs'][0]['marks']==[{'mark':'link','href':body.find('.//t:a',ns).get(q('x','href'))}],'link'
 assert ps[3]['containers'][0]['style']=={'type':'ordered','start':3},'ordered'
 assert len(ps[4]['containers'])==2 and ps[4]['containers'][1]['style']=={'type':'unordered'},'nested list'
 assert ps[3]['containers']==ps[5]['containers'],'list continuation'
 table=next(b['attributes']['tuple'] for b in blocks if (b.get('attributes') or {}).get('tuple',[''])[0]=='module:editac.table')
 assert [[''.join(r[0] for r in c) for c in row] for row in table[2]['rows']]==cells,'cells'
 assert table[2]['rows'][0][0][0][1]==[['bold']],'table marks'
 assets=[n for n in v['after']['visible'] if (n.get('blockAttributes') or [''])[0]=='module:editac.asset'];assert len(assets)==1,'asset count'
 d=assets[0]['blockAttributes'][2];assert d['identity']=={'host':'fixture-host','key':'odt-original-png'},'identity'
 m=d['metadata'];assert m['sha256']==sha and m['byteLength']==len(pixel),'hash/bytes';assert (m['width'],m['height'])==(width,height),'dimensions'
 assert m['alt']==frame.find('svg:desc',ns).text and m['caption']==frame.find('svg:title',ns).text,'accessibility'
 assert v['retained']==list(pixel) and v['reopenedOriginal']==list(pixel),'retained original'
 assert v['original']==list(original) and v['retainedPackage']==list(original) and v['reopenedPackage']==list(original),'original package'
 assert v['reopened']==v['after']['visible'],'reopen';assert v['updates']==1 and v['after']['history']['undoGroups']==1,'one update/history'
 assert len(v['entries'])==1,'one durable update';assert v['siblingBefore']==v['siblingAfter'],'sibling';assert v['completion']['localCommit']['state']=='localCommitted','durability';assert v['diagnostics']==[],'complete diagnostics'
inspect(actual);mutations=[]
def reject(name,mutate):
 v=copy.deepcopy(actual);mutate(v)
 try:inspect(v)
 except (AssertionError,KeyError,IndexError,StopIteration):mutations.append(name);return
 raise AssertionError('accepted '+name)
def asset(v):return next(n['blockAttributes'][2] for n in v['after']['visible'] if (n.get('blockAttributes') or [''])[0]=='module:editac.asset')
def ps(v):return [b for b in v['blocks'] if (b.get('attributes') or {}).get('type')!='content']
reject('changed-original-byte',lambda v:v['retained'].__setitem__(0,1));reject('changed-reopened-byte',lambda v:v['reopenedOriginal'].pop())
reject('wrong-identity',lambda v:asset(v)['identity'].update(key='wrong'));reject('corrupt-digest',lambda v:asset(v)['metadata'].update(sha256='0'*64));reject('wrong-dimensions',lambda v:asset(v)['metadata'].update(width=999));reject('lost-alt',lambda v:asset(v)['metadata'].update(alt='wrong'))
reject('duplicate-update',lambda v:v.update(updates=2));reject('extra-durable-update',lambda v:v['entries'].append(v['entries'][0]));reject('lost-sibling',lambda v:v.update(siblingAfter=None));reject('changed-reopen',lambda v:v.update(reopened=[]));reject('spurious-diagnostic',lambda v:v.update(diagnostics=[{'code':'bad'}]));reject('lost-original-package',lambda v:v['original'].pop());reject('lost-reopened-package',lambda v:v['reopenedPackage'].pop())
reject('lost-paragraph',lambda v:v['blocks'].pop(0));reject('changed-heading',lambda v:ps(v)[0]['attributes'].update(level=1));reject('lost-bold',lambda v:ps(v)[1]['runs'][1].update(marks=[]));reject('lost-inherited-italic',lambda v:ps(v)[1]['runs'][2].update(marks=[{'mark':'bold','href':None}]));reject('lost-link',lambda v:ps(v)[2]['runs'][0].update(marks=[]));reject('wrong-list-start',lambda v:ps(v)[3]['containers'][0]['style'].update(start=1));reject('lost-nested-list',lambda v:ps(v)[4]['containers'].pop())
receipt={'state':'passed','oracle':'Python stdlib ODF ZIP/XML/style/list/table/PNG + actual live/storage/history/recovery facts','sourceSha256':hashlib.sha256(original).hexdigest(),'pngSha256':sha,'paragraphs':paragraphs,'cells':cells,'negativeMutations':mutations,'passed':1,'failed':0,'skipped':0}
(out/'odt-media-independent.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps(receipt))
