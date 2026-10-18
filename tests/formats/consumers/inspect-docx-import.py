"""Compare browser import projection with original XML facts; reject mutations."""
import copy,json,pathlib,sys,zipfile
from xml.etree import ElementTree as ET
out=pathlib.Path(sys.argv[1]); actual=json.loads((out/'browser-docx-import-projection.json').read_text()); manifest=json.loads((out/'docx-import-fixtures/manifest.json').read_text()); W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
with zipfile.ZipFile(out/'docx-import-fixtures/supported.docx') as z: tree=ET.fromstring(z.read('word/document.xml'))
body=tree.find('{'+W+'}body')
expected=[''.join(t.text or '' for t in p.iter('{'+W+'}t')) for p in body.findall('{'+W+'}p')]
expected_cells=[[''.join(t.text or '' for t in c.iter('{'+W+'}t')) for c in row.findall('{'+W+'}tc')] for row in body.find('{'+W+'}tbl').findall('{'+W+'}tr')]
def inspect(value):
    blocks=value['blocks']; paragraphs=[''.join(r['text'] for r in b['runs']) for b in blocks if not b['attributes'] or b['attributes'].get('type')!='content']
    assert paragraphs==expected,(paragraphs,expected)
    table=next(b['attributes']['tuple'] for b in blocks if (b.get('attributes') or {}).get('type')=='content')
    assert table[:2]==['module:editac.table',1]
    cells=[[''.join(run[0] for run in cell) for cell in row] for row in table[2]['rows']]
    assert cells==expected_cells
    assert table[2]['rows'][0][0][0][1]==[['bold']]
    first=blocks[0];assert any(r['text']==manifest['expected']['bold'] and r['marks']==[{'mark':'bold','href':None}] for r in first['runs'])
    assert any(any(m['mark']=='link' and m.get('href')==manifest['expected']['link'] for m in r['marks']) for r in first['runs'])
    listed=[b for b in blocks if b.get('containers')]
    assert [''.join(r['text'] for r in b['runs']) for b in listed]==manifest['expected']['listTexts']
    assert [len(b['containers']) for b in listed]==[1,2,1]
    assert listed[0]['containers'][0]['style']=={'type':'ordered','start':3}
    assert listed[1]['containers'][1]['style']=={'type':'unordered'}
    live=value['snapshot']['visible'];assert [n['blockAttributes'] for n in live if isinstance(n.get('blockAttributes'),list) and n['blockAttributes'][0]=='module:editac.table']==[table]
    assert value['reopenedSnapshot']['visible']==live
    assert value['diagnostics']==[{'action':'Keep this relationship inert; no network request is performed.','code':'EXTERNAL_RELATIONSHIP_INERT','location':'word/_rels/document.xml.rels#web','lossy':False}]
inspect(actual)
mutations=[]
def reject(name,mutate):
    v=copy.deepcopy(actual);mutate(v)
    try:inspect(v)
    except (AssertionError,KeyError,StopIteration):mutations.append(name);return
    raise AssertionError('oracle accepted '+name)
reject('unicode-normalization',lambda v:v['blocks'][0]['runs'][0].update(text='DOCX import 🙂 é'))
reject('missing-bold',lambda v:v['blocks'][0]['runs'][0].update(marks=[]))
reject('wrong-link',lambda v:v['blocks'][0]['runs'][-1]['marks'][0].update(href='https://wrong.test/'))
reject('lost-list-level',lambda v:v['blocks'][2].update(containers=[]))
reject('lost-table-cell',lambda v:next(b['attributes']['tuple'] for b in v['blocks'] if (b.get('attributes') or {}).get('type')=='content')[2]['rows'][0].pop())
reject('missing-live-table',lambda v:v['snapshot'].update(visible=[n for n in v['snapshot']['visible'] if not isinstance(n.get('blockAttributes'),list)]))
reject('missing-inert-relationship-diagnostic',lambda v:v.update(diagnostics=[]))
receipt={'oracle':'Python stdlib original OOXML ZIP/XML vs actual worker/shared live/reopen semantic projection','fixtures':manifest,'supported':True,'rejectedMutations':mutations,'scope':'partial text/list/v1-table import; no original media or full DI qualification'}
(out/'docx-import-independent.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':1,'negativeMutations':len(mutations)}))
