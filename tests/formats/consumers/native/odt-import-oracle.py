"""Independent authored ODF XML versus actual committed native Session semantics."""
import copy, hashlib, json, xml.etree.ElementTree as ET, zipfile
N={k:'urn:oasis:names:tc:opendocument:xmlns:'+v+':1.0' for k,v in [('o','office'),('t','text'),('tb','table'),('s','style')]}
def text(n):
 if n.tag=='{'+N['t']+'}s':return ' '*int(n.get('{'+N['t']+'}c','1'))
 if n.tag=='{'+N['t']+'}tab':return '\t'
 if n.tag=='{'+N['t']+'}line-break':return '\n'
 return (n.text or '')+''.join(text(c)+(c.tail or '') for c in n)
def inspect(v,source):
 with zipfile.ZipFile(source) as z:
  assert z.read('mimetype')==b'application/vnd.oasis.opendocument.text'
  body=ET.fromstring(z.read('content.xml')).find('./o:body/o:text',N)
 paragraphs=[]
 def walk(n):
  if n.tag=='{'+N['tb']+'}table':return
  if n.tag in ('{'+N['t']+'}p','{'+N['t']+'}h'):paragraphs.append(text(n));return
  for c in n:walk(c)
 walk(body)
 expected_cells=[[text(c.find('t:p',N)) for c in row.findall('tb:table-cell',N)] for row in body.find('tb:table',N).findall('tb:table-row',N)]
 nodes=v['snapshotBlocks'];ps=[n for n in nodes if n['kind']=='block' and (n.get('attributes') or [''])[0]!='module:editac.table']
 assert [''.join(r['text'] for r in n['runs']) for n in ps]==paragraphs+[''],'committed authored text and explicit trailing cursor paragraph'
 assert ps[-1]['attributes']==['paragraph'] and ps[-1]['runs']==[],'cursor tail'
 assert len(nodes)==len(paragraphs)+4,'complete committed node projection'
 assert ps[0]['attributes']==['heading',2],'heading'
 both=next(r for r in ps[1]['runs'] if r['text']=='C🙂');assert both['attributes']=={'bold':True,'italic':True},'nested style marks'
 assert next(r for r in ps[1]['runs'] if r['text']=='D')['attributes']=={'bold':True},'style scope'
 assert ps[2]['runs'][0]['attributes']=={'link':'https://example.test/?a=1&b=2'},'link'
 assert ps[3]['listNumber']==3 and ps[5]['listNumber']==4 and ps[3]['parent']==ps[5]['parent'],'ordered continuation'
 assert ps[4]['parent']!=ps[3]['parent'],'nested list'
 table=next(n['attributes'] for n in nodes if (n.get('attributes') or [''])[0]=='module:editac.table')
 assert table[1]==1 and [[''.join(r[0] for r in c) for c in row] for row in table[2]['rows']]==expected_cells,'committed table'
 assert table[2]['rows'][0][0][0][1]==[['bold']],'cell marks'
 assert v['report']['diagnostics']==[] and v['report']['stagedBytes']==0,'complete report'
 assert v['historyGroups']==v['updates']==v['commits']==1 and all(v[k] for k in ('undo','redo','reopen')),'atomic history/reopen'
 assert v['originalSha256']==hashlib.sha256(source.read_bytes()).hexdigest(),'source identity'
 return True

def negatives(v,source):
 changes=[('heading',lambda x:x['snapshotBlocks'][0].update(attributes=['heading',1])),('text',lambda x:x['snapshotBlocks'][1]['runs'][0].update(text='CORRUPT')),('paragraph',lambda x:x['snapshotBlocks'].pop(0)),('marks',lambda x:next(r for n in x['snapshotBlocks'] for r in n['runs'] if r['text']=='C🙂').update(attributes={})),('table',lambda x:next(n for n in x['snapshotBlocks'] if (n.get('attributes') or [''])[0]=='module:editac.table')['attributes'][2]['rows'][1].pop()),('list',lambda x:next(n for n in x['snapshotBlocks'] if n['listNumber']==3).update(listNumber=1)),('history',lambda x:x.update(historyGroups=2)),('reopen',lambda x:x.update(reopen=False)),('diagnostics',lambda x:x['report']['diagnostics'].append({'code':'UNEXPECTED'})),('original',lambda x:x.update(originalSha256='0'*64))]
 for name,change in changes:
  x=copy.deepcopy(v);change(x)
  try:inspect(x,source)
  except (AssertionError,KeyError,StopIteration,IndexError):continue
  raise AssertionError('oracle accepted '+name)
 return [name for name,_ in changes]
