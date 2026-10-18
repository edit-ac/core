"""Independent original EPUB ZIP/OPF/spine/nav/XHTML versus committed native facts."""
import copy,hashlib,posixpath,xml.etree.ElementTree as E,zipfile
H='{http://www.w3.org/1999/xhtml}';O='{http://www.idpf.org/2007/opf}';C='{urn:oasis:names:tc:opendocument:xmlns:container}'
def authored(source):
 with zipfile.ZipFile(source) as z:
  part=E.fromstring(z.read('META-INF/container.xml')).find('.//'+C+'rootfile').get('full-path');opf=E.fromstring(z.read(part));base=posixpath.dirname(part)
  manifest={n.get('id'):n for n in opf.find(O+'manifest')};spine=[posixpath.normpath(posixpath.join(base,manifest[n.get('idref')].get('href'))) for n in opf.find(O+'spine')]
  navpart=next(posixpath.join(base,n.get('href')) for n in manifest.values() if n.get('properties')=='nav');nav=E.fromstring(z.read(navpart))
  navigation=[]
  for a in nav.findall('.//'+H+'nav//'+H+'a'):
   path,fragment=a.get('href').split('#');navigation.append({'label':''.join(a.itertext()),'part':posixpath.normpath(posixpath.join(posixpath.dirname(navpart),path)),'fragment':fragment})
  blocks=[];chapters=[];lists=[];metadata={}
  for n in opf.find(O+'metadata'):
   key='modified' if n.tag==O+'meta' else n.tag.split('}')[-1];metadata[key]=''.join(n.itertext())
  def walk(n,list_style=None):
   tag=n.tag.split('}')[-1]
   if tag in ('ol','ul'):
    group=[]
    for c in n:walk(c,(tag,int(n.get('start','1')),group))
    return
   if tag in ('h1','h2','p','li'):
    runs=[]
    def append(t,marks):
     if not t:return
     if runs and runs[-1]['attributes']==marks:runs[-1]['text']+=t
     else:runs.append({'text':t,'attributes':dict(marks)})
    def inline(x,marks):
     marks=dict(marks);t=x.tag.split('}')[-1]
     if t=='strong':marks['bold']=True
     if t=='em':marks['italic']=True
     if t=='a':marks['link']=x.get('href')
     if t=='br':append('\n',marks);return
     append(x.text,marks)
     for c in x:inline(c,marks);append(c.tail,marks)
    inline(n,{})
    blocks.append({'runs':runs,'attributes':['heading',int(tag[1])] if tag.startswith('h') else ['paragraph']})
    if list_style:list_style[2].append(len(blocks)-1)
    return
   for c in n:walk(c,list_style)
  for p in spine:
   data=z.read(p);tree=E.fromstring(data);metadata['chapter-title:'+p]=''.join(tree.find(H+'head/'+H+'title').itertext());start=len(blocks);body=tree.find(H+'body');walk(body);chapters.append({'part':p,'firstBlock':start,'blockCount':len(blocks)-start,'sourceSha256':hashlib.sha256(data).hexdigest()})
  return blocks,chapters,navigation,metadata

def inspect(v,source):
 expected,chapters,navigation,metadata=authored(source);nodes=v['snapshotBlocks'];ps=[n for n in nodes if n['kind']=='block' and n['runs']]
 assert [{'runs':n['runs'],'attributes':n['attributes']} for n in ps]==expected,'committed exact Unicode/marks/headings/spine paragraphs'
 assert len(v['preparedBlocks'])==len(expected),'all prepared source paragraphs'
 assert v['report']['chapters']==chapters,'complete chapter provenance and boundaries'
 assert v['report']['navigation']==navigation,'navigation distinct from spine'
 assert v['report']['metadata']==metadata,'publication and chapter metadata'
 assert v['report']['diagnostics']==[],'complete supported diagnostics'
 assert v['report']['utf16Units']==sum(len(r['text'].encode('utf-16-le'))//2 for p in expected for r in p['runs'])
 assert [ps[i]['listNumber'] for i in (2,3,7)]==[3,4,None],'ordered start/continuation'
 assert ps[2]['parent']==ps[3]['parent'] and ps[7]['parent']!=ps[2]['parent'],'independent list containers'
 assert len(nodes)==len(expected)+2,'exact two containers, no added/dropped nodes'
 assert v['report']['stagedBytes']==0 and v['assets']==v['networkCalls']==v['activeJobs']==0
 assert v['historyGroups']==v['updates']==v['commits']==1 and all(v[k] for k in ('undo','redo','reopen'))
 assert v['originalSha256']==hashlib.sha256(source.read_bytes()).hexdigest(),'full original identity'
 return True

def negatives(v,source):
 changes=[('unicode-normalization',lambda x:x['snapshotBlocks'][next(i for i,n in enumerate(x['snapshotBlocks']) if any('é' in r['text'] for r in n['runs']))]['runs'][0].update(text='Exact é and 😀')),('paragraph',lambda x:x['snapshotBlocks'].pop(0)),('marks',lambda x:next(n for n in x['snapshotBlocks'] if any(r['attributes'].get('bold') for r in n['runs']))['runs'][1].update(attributes={})),('spine-order',lambda x:x['snapshotBlocks'].reverse()),('metadata',lambda x:x['report']['metadata'].update(title='wrong')),('chapter-hash',lambda x:x['report']['chapters'][0].update(sourceSha256='0'*64)),('chapter-boundary',lambda x:x['report']['chapters'][1].update(firstBlock=0)),('navigation',lambda x:x['report']['navigation'].reverse()),('list',lambda x:next(n for n in x['snapshotBlocks'] if n['listNumber']==3).update(listNumber=1)),('history',lambda x:x.update(historyGroups=2)),('reopen',lambda x:x.update(reopen=False)),('diagnostics',lambda x:x['report'].update(diagnostics=[{'code':'bad'}])),('original',lambda x:x.update(originalSha256='0'*64))]
 for name,change in changes:
  x=copy.deepcopy(v);change(x)
  try:inspect(x,source)
  except (AssertionError,KeyError,StopIteration,IndexError):continue
  raise AssertionError('oracle accepted '+name)
 return [name for name,_ in changes]
