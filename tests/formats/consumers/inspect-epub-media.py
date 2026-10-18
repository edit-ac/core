"""Independent original ZIP/OPF/spine/XHTML/PNG versus packed live/storage facts."""
import copy,hashlib,json,pathlib,posixpath,struct,sys,zipfile
from xml.etree import ElementTree as ET
out=pathlib.Path(sys.argv[1]);actual=json.loads((out/'browser-epub-media-projection.json').read_text())
original=(out/'epub-import-fixtures/media.epub').read_bytes()
ns={'c':'urn:oasis:names:tc:opendocument:xmlns:container','o':'http://www.idpf.org/2007/opf','h':'http://www.w3.org/1999/xhtml'}
def text(n):
 if n.tag=='{'+ns['h']+'}br':return '\n'
 return (n.text or '')+''.join(text(c)+(c.tail or '') for c in n)
with zipfile.ZipFile(out/'epub-import-fixtures/media.epub') as z:
 assert z.namelist()[0]=='mimetype' and z.read('mimetype')==b'application/epub+zip'
 container=ET.fromstring(z.read('META-INF/container.xml'));part=container.find('.//c:rootfile',ns).get('full-path')
 opf=ET.fromstring(z.read(part));base=posixpath.dirname(part)
 manifest={n.get('id'):n for n in opf.findall('o:manifest/o:item',ns)}
 spine=[posixpath.normpath(posixpath.join(base,manifest[n.get('idref')].get('href'))) for n in opf.findall('o:spine/o:itemref',ns)]
 navpart=next(posixpath.join(base,n.get('href')) for n in manifest.values() if n.get('properties')=='nav')
 nav=ET.fromstring(z.read(navpart));navigation=[(text(n),n.get('href')) for n in nav.findall('.//h:nav//h:a',ns)]
 assert [p.rsplit('/',1)[-1] for p in spine]==['first.xhtml','second.xhtml']
 assert navigation[0][1].startswith('text/second.xhtml'), 'navigation order deliberately differs from spine'
 chapters=[ET.fromstring(z.read(p)) for p in spine]
 paragraphs=[text(n) for c in chapters for n in c.find('h:body',ns).iter() if n.tag.split('}')[-1] in ['h1','h2','p','li'] and n.find('h:img',ns) is None]
 image=chapters[0].find('.//h:img',ns);pixel=z.read(posixpath.normpath(posixpath.join(posixpath.dirname(spine[0]),image.get('src'))))
sha=hashlib.sha256(pixel).hexdigest();width,height=struct.unpack('>II',pixel[16:24])
def ps(v):return [b for b in v['blocks'] if (b.get('attributes') or {}).get('type')!='content']
def asset(v):return next(n['blockAttributes'][2] for n in v['after']['visible'] if (n.get('blockAttributes') or [''])[0]=='module:editac.asset')
def inspect(v):
 p=ps(v);assert [''.join(r['text'] for r in b['runs']) for b in p]==paragraphs,'spine/paragraph text'
 assert p[0]['attributes']=={'type':'heading','level':1} and p[5]['attributes']=={'type':'heading','level':2},'heading levels'
 assert p[1]['runs'][1]=={'text':'B','marks':[{'mark':'bold','href':None}]},'bold'
 assert p[1]['runs'][2]=={'text':'C🙂','marks':[{'mark':'bold','href':None},{'mark':'italic','href':None}]},'inherited Unicode marks'
 assert p[4]['runs'][0]['marks']==[{'mark':'link','href':chapters[0].find('.//h:a',ns).get('href')}],'link'
 assert p[2]['containers'][0]['style']=={'type':'ordered','start':3} and p[2]['containers']==p[3]['containers'],'ordered list'
 assert p[7]['containers'][0]['style']=={'type':'unordered'} and p[7]['containers'][0]['key']!=p[2]['containers'][0]['key'],'independent list'
 d=asset(v);m=d['metadata'];assert d['identity']=={'host':'fixture-host','key':'epub-original-png'},'identity'
 assert m['sha256']==sha and m['byteLength']==len(pixel),'hash/bytes';assert (m['width'],m['height'])==(width,height),'dimensions'
 assert m['alt']==image.get('alt') and m['caption']==image.get('title'),'accessibility'
 assert v['retained']==list(pixel) and v['reopenedOriginal']==list(pixel),'original PNG'
 assert v['original']==list(original) and v['retainedPackage']==list(original) and v['reopenedPackage']==list(original),'complete original EPUB'
 assert v['reopened']==v['after']['visible'],'reopen';assert v['updates']==1 and v['after']['history']['undoGroups']==1,'one shared update/history'
 assert len(v['entries'])==1,'one durable update';assert v['siblingBefore']==v['siblingAfter'],'sibling isolation'
 assert v['completion']['localCommit']['state']=='localCommitted','durability';assert v['diagnostics']==[],'complete diagnostics'
inspect(actual);mutations=[]
def reject(name,mutate):
 v=copy.deepcopy(actual);mutate(v)
 try:inspect(v)
 except (AssertionError,KeyError,IndexError,StopIteration):mutations.append(name);return
 raise AssertionError('accepted '+name)
reject('changed-original-byte',lambda v:v['retained'].__setitem__(0,1));reject('changed-reopened-byte',lambda v:v['reopenedOriginal'].pop())
reject('wrong-identity',lambda v:asset(v)['identity'].update(key='wrong'));reject('corrupt-digest',lambda v:asset(v)['metadata'].update(sha256='0'*64));reject('wrong-dimensions',lambda v:asset(v)['metadata'].update(width=999));reject('lost-alt',lambda v:asset(v)['metadata'].update(alt='wrong'))
reject('duplicate-update',lambda v:v.update(updates=2));reject('extra-durable-update',lambda v:v['entries'].append(v['entries'][0]));reject('lost-sibling',lambda v:v.update(siblingAfter=None));reject('changed-reopen',lambda v:v.update(reopened=[]));reject('spurious-diagnostic',lambda v:v.update(diagnostics=[{'code':'bad'}]));reject('lost-original-package',lambda v:v['original'].pop());reject('lost-reopened-package',lambda v:v['reopenedPackage'].pop())
reject('lost-paragraph',lambda v:v['blocks'].pop(0));reject('changed-heading',lambda v:ps(v)[0]['attributes'].update(level=2));reject('lost-bold',lambda v:ps(v)[1]['runs'][1].update(marks=[]));reject('lost-inherited-italic',lambda v:ps(v)[1]['runs'][2].update(marks=[{'mark':'bold','href':None}]));reject('lost-link',lambda v:ps(v)[4]['runs'][0].update(marks=[]));reject('wrong-list-start',lambda v:ps(v)[2]['containers'][0]['style'].update(start=1));reject('wrong-spine-order',lambda v:v['blocks'].reverse())
receipt={'state':'passed','oracle':'Python stdlib original ZIP/OPF/spine/navigation/XHTML/PNG + actual live/storage/history/recovery','sourceSha256':hashlib.sha256(original).hexdigest(),'pngSha256':sha,'spine':spine,'navigation':navigation,'paragraphs':paragraphs,'negativeMutations':mutations,'passed':1,'failed':0,'skipped':0}
(out/'epub-media-independent.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps(receipt))
