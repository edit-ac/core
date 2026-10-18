"""Independent original OOXML versus actual committed native Session semantics."""
import copy,hashlib,xml.etree.ElementTree as ET,zipfile
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def inspect(v,source):
 with zipfile.ZipFile(source) as z:body=ET.fromstring(z.read('word/document.xml')).find(W+'body')
 authored=[''.join(t.text or '' for t in p.iter(W+'t')) for p in body.findall(W+'p')]
 cells=[[''.join(t.text or '' for t in c.iter(W+'t')) for c in row.findall(W+'tc')] for row in body.find(W+'tbl').findall(W+'tr')]
 nodes=v['snapshotBlocks'];ps=[n for n in nodes if n['kind']=='block' and (n.get('attributes') or [''])[0]!='module:editac.table']
 assert [''.join(r['text'] for r in n['runs']) for n in ps]==authored,'exact committed Unicode text and source paragraph order'
 assert len(nodes)==len(authored)+3,'no hidden dropped/added node'
 assert ps[0]['runs'][0]=={'text':'DOCX import 🙂 é','attributes':{'bold':True}},'direct marks and authored spelling'
 assert ps[0]['runs'][-1]['attributes']=={'link':'https://example.test/'},'inert hyperlink'
 assert [n['listNumber'] for n in ps[1:4]]==[3,None,4],'ordered continuation'
 assert ps[1]['parent']==ps[3]['parent'] and ps[2]['parent']!=ps[1]['parent'],'list nesting'
 table=next(n['attributes'] for n in nodes if (n.get('attributes') or [''])[0]=='module:editac.table')
 assert table[1]==1 and [[''.join(r[0] for r in c) for c in row] for row in table[2]['rows']]==cells,'exact table cells'
 assert table[2]['rows'][0][0][0][1]==[['bold']],'cell mark'
 assert table[2]['rows'][1][1][0][1]==[['link','https://example.test/']],'cell link'
 assert v['report']['diagnostics']==[{'action':'Keep this relationship inert; no network request is performed.','code':'EXTERNAL_RELATIONSHIP_INERT','location':'word/_rels/document.xml.rels#web','lossy':False}],'complete diagnostic report'
 assert v['report']['stagedBytes']==0 and v['assets']==v['networkCalls']==v['activeJobs']==0
 assert v['historyGroups']==v['updates']==v['commits']==1 and all(v[k] for k in ('undo','redo','reopen'))
 assert v['originalSha256']==hashlib.sha256(source.read_bytes()).hexdigest(),'full original identity'
 return True

def negatives(v,source):
 changes=[('unicode-normalization',lambda x:x['snapshotBlocks'][0]['runs'][0].update(text='DOCX import 🙂 é')),('paragraph',lambda x:x['snapshotBlocks'].pop(0)),('marks',lambda x:x['snapshotBlocks'][0]['runs'][0].update(attributes={})),('hyperlink',lambda x:x['snapshotBlocks'][0]['runs'][-1].update(attributes={})),('table',lambda x:next(n for n in x['snapshotBlocks'] if (n.get('attributes') or [''])[0]=='module:editac.table')['attributes'][2]['rows'][1].pop()),('list',lambda x:next(n for n in x['snapshotBlocks'] if n['listNumber']==3).update(listNumber=1)),('history',lambda x:x.update(historyGroups=2)),('reopen',lambda x:x.update(reopen=False)),('diagnostics',lambda x:x['report'].update(diagnostics=[])),('original',lambda x:x.update(originalSha256='0'*64))]
 for name,change in changes:
  x=copy.deepcopy(v);change(x)
  try:inspect(x,source)
  except (AssertionError,KeyError,StopIteration,IndexError):continue
  raise AssertionError('oracle accepted '+name)
 return [name for name,_ in changes]

def styled(v,source):
 with zipfile.ZipFile(source) as z:body=ET.fromstring(z.read('word/document.xml')).find(W+'body')
 def authored(n):
  if n.tag==W+'t':return n.text or ''
  if n.tag==W+'tab':return '\t'
  if n.tag in (W+'br',W+'cr'):return '\n'
  return ''.join(authored(c) for c in n)
 ps=v['snapshotBlocks'];assert len(ps)==3 and all(n['kind']=='block' for n in ps)
 assert [''.join(r['text'] for r in n['runs']) for n in ps]==[authored(p) for p in body.findall(W+'p')]
 assert ps[0]['attributes']==['heading',2]
 runs=ps[0]['runs'];assert runs[0]['attributes']=={'bold':True,'italic':True}
 assert runs[1]['attributes']=={'italic':True,'strike':True,'underline':True}
 assert runs[-1]['attributes']=={'bold':True,'link':'https://example.test/'}
 assert v['report']['diagnostics']==[{'action':'Keep this relationship inert; no network request is performed.','code':'EXTERNAL_RELATIONSHIP_INERT','location':'word/_rels/document.xml.rels#web','lossy':False}]
 assert v['report']['utf16Units']==sum(len(authored(p).encode('utf-16-le'))//2 for p in body.findall(W+'p'))
 assert v['historyGroups']==v['updates']==v['commits']==1 and all(v[k] for k in ('undo','redo','reopen'))
 assert v['originalSha256']==hashlib.sha256(source.read_bytes()).hexdigest()
 return True
