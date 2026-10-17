"""Independent generated-artifact oracle. OS RTF decoding, stdlib HTML inspection.
Never imports or calls the edit.ac RTF importer. No network or third-party package.
"""
import json,re,sys
from html.parser import HTMLParser
class Reader(HTMLParser):
 def __init__(self,html):
  super().__init__(convert_charrefs=True);self.css={};self.stack=[];self.body=False;self.paragraphs=[];self.tables=[];self.row=None;self.cell=None;self.p=None;self.after_br=False;self.empty_p=False
  for cls,style in re.findall(r'(?:p|span)\.(\w+)\s*\{([^}]+)\}',html):self.css[cls]=style
  self.feed(html)
 def handle_starttag(self,tag,attrs):
  a=dict(attrs);styles=a.get('style','')+';'+self.css.get(a.get('class',''),'');marks=set(self.stack[-1][1] if self.stack else [])
  if tag in ('b','strong') or 'font-weight: bold' in styles:marks.add('bold')
  if tag in ('i','em') or 'font-style: italic' in styles:marks.add('italic')
  if tag=='u' or 'underline' in styles:marks.add('underline')
  if tag in ('s','strike','del') or 'line-through' in styles:marks.add('strike')
  if tag=='body':self.body=True
  if tag=='table':self.tables.append([])
  if tag=='tr':self.row=[];self.tables[-1].append(self.row)
  if tag=='td':self.cell=[];self.row.append(self.cell)
  if tag=='p':self.p=[];self.empty_p='min-height:' in styles;self.after_br=False;(self.cell if self.cell is not None else self.paragraphs).append(self.p)
  if tag=='br':
   # Cocoa's Apple-interchange-newline fills an empty paragraph, not an authored LF.
   if self.p is not None and not self.empty_p and a.get('class')!='Apple-interchange-newline':self.p.append({'text':'\n','marks':sorted(marks)})
   self.after_br=True
  else:self.stack.append((tag,marks))
 def handle_endtag(self,tag):
  if tag=='p':self.p=None
  if tag=='td':self.cell=None
  if tag=='body':self.body=False
  for i in range(len(self.stack)-1,-1,-1):
   if self.stack[i][0]==tag:del self.stack[i:];break
 def handle_data(self,text):
  if self.body and self.p is not None:
   if self.after_br:text=text.removeprefix('\n');self.after_br=False
   if text:self.p.append({'text':text,'marks':sorted(self.stack[-1][1]) if self.stack else []})
def chars(rs):return [(c,tuple(r['marks'])) for r in rs for c in r['text']]
def text(rs):return ''.join(r['text'] for r in rs)
def verify(html,kind):
 r=Reader(html)
 if kind=='supported':
  expected=['Unicode é € 🙂 e\u0301 العربية {literal} \\object \\u65? \\bin9','bolditalicunderstrikebothplain\ttab\nline','','Tailbase']
  assert [text(p) for p in r.paragraphs]==expected,([text(p) for p in r.paragraphs],expected)
  marked=[]
  for t,m in [('bold',['bold']),('italic',['italic']),('under',['underline']),('strike',['strike']),('both',['bold','italic']),('plain\ttab\nline',[])]:marked.extend((c,tuple(sorted(m))) for c in t)
  assert chars(r.paragraphs[1])==marked,chars(r.paragraphs[1])
  assert len(r.tables)==1 and len(r.tables[0])==3
  assert [[[text(p) for p in c] for c in row] for row in r.tables[0]]==[[['A'],['B']],[['🙂'],['=1+1']],[[''],['{cell} \\row']]]
  assert chars(r.tables[0][0][0][0])==[('A',('bold',))]
  assert chars(r.tables[0][2][1][0])==[(c,('underline',)) for c in '{cell} \\row']
  assert all(not x for p in [r.paragraphs[0],r.paragraphs[-1]] for _,x in chars(p))
 elif kind=='marks':
  assert len(r.paragraphs)==1
  expected=[]
  for n in range(16):expected.extend((c,tuple(sorted(m for i,m in enumerate(['bold','italic','underline','strike']) if n&(1<<i)))) for c in f'm{n:02}')
  expected.extend((c,()) for c in 'base')
  assert chars(r.paragraphs[0])==expected
 elif kind=='probe':
  assert text(r.paragraphs[0])=='bolditalicunderstrike🙂'
  assert [[[text(p) for p in c] for c in row] for row in r.tables[0]]==[[['A'],['B']]]
 else:raise ValueError(kind)
 return {'paragraphs':len(r.paragraphs),'tables':len(r.tables),'textUnits':sum(len(text(p)) for p in r.paragraphs)}
if __name__=='__main__':
 with open(sys.argv[1]) as f:result=verify(f.read(),sys.argv[2])
 print(json.dumps(result))
