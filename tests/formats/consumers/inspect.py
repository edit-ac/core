import csv,io,sys,json,subprocess
from html.parser import HTMLParser
from pathlib import Path
root=Path(sys.argv[1]);count=0
for fmt,sep in [('csv',','),('tsv','\t')]:
 for kind in ['exact','safe']:
  b=(root/f'browser-{kind}.{fmt}').read_bytes();assert b.endswith(b'\r\n')
  rows=list(csv.reader(io.StringIO(b.decode(),newline=''),delimiter=sep,strict=True))
  assert rows==[['name','value'],["'=1+1" if kind=='safe' else '=1+1','🙂,"line"\nnext']],rows
  count+=1
  # Independent corruption checks distinguish altered cell data/dialect.
  for mutation in [b.replace(b'=1+1',b'=2+2'),b.replace('🙂'.encode(),b'bad'),b.replace(b'"name"',b'"other"')]:
   altered=list(csv.reader(io.StringIO(mutation.decode(),newline=''),delimiter=sep,strict=True));assert altered!=rows;count+=1
(root/'independent-receipt.json').write_text(json.dumps({'generatedArtifacts':4,'checks':count,'positive':4,'negative':12,'passed':count,'failed':0,'skipped':0},indent=2)+'\n')
print(f'{count} independent artifact/corruption assertions passed')

class Marks(HTMLParser):
 def __init__(self):super().__init__();self.styles={};self.stack=[];self.bold=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs);style=a.get('style','')+';'+self.styles.get(a.get('class',''),'');bold=(self.stack[-1][1] if self.stack else False) or tag in ['b','strong'] or 'font-weight: bold' in style;self.stack.append((tag,bold))
 def handle_endtag(self,tag):
  for i in range(len(self.stack)-1,-1,-1):
   if self.stack[i][0]==tag:self.stack=self.stack[:i];break
 def handle_data(self,data):
  if self.stack and self.stack[-1][1]:self.bold.append(data)
raw=subprocess.check_output(['/usr/bin/textutil','-convert','html','-stdout',str(root/'browser-supported.rtf')]).decode()
import re
p=Marks();p.styles=dict(re.findall(r'(?:p|span)\.(\w+)\s*\{([^}]+)\}',raw));p.feed(raw);assert 'bold' in ''.join(p.bold),p.bold
(root/'browser-supported.html').write_text(raw)
