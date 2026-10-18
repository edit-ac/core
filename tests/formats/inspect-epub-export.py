"""Independent generated-artifact reader: EbookLib + lxml, never runtime input.

The semantic oracle consumes the captured shared source projection, not exporter
XML or the edit.ac importer. All resources are inspected in-memory; no browser.
"""
import copy, hashlib, importlib.metadata, io, json, posixpath, sys, zipfile
from pathlib import Path
from ebooklib import epub
from lxml import etree as E
out=Path(sys.argv[1]); H='{http://www.w3.org/1999/xhtml}'; O='{http://www.idpf.org/2007/opf}'; C='{urn:oasis:names:tc:opendocument:xmlns:container}'; DC='{http://purl.org/dc/elements/1.1/}'; EP='{http://www.idpf.org/2007/ops}'
parser=E.XMLParser(resolve_entities=False,no_network=True)
def xml(b):
    assert b'<!DOCTYPE' not in b and b'<!ENTITY' not in b
    return E.fromstring(b,parser)
def label(n):
    result=n.text or ''
    for c in n: result+= ('\n' if c.tag==H+'br' else label(c))+(c.tail or '')
    return result
MARKS={'strong':'Bold','em':'Italic','u':'Underline','s':'Strike','code':'Code','a':'Link'}
def runs(n):
    result=[]
    def append(s,marks):
        if not s:return
        marks=sorted(marks,key=lambda v:v[0]);r={'text':s,'marks':marks}
        if result and result[-1]['marks']==marks:result[-1]['text']+=s
        else:result.append(r)
    def walk(n,marks):
        tag=E.QName(n).localname
        if tag in MARKS:marks=marks+[[MARKS[tag],n.get('href') if tag=='a' else None]]
        if tag=='br':append('\n',marks)
        else:
            append(n.text,marks)
            for child in n:walk(child,marks);append(child.tail,marks)
    walk(n,[]);return result

def normalized(expected):
    v=copy.deepcopy(expected)
    def nr(rs):
        result=[]
        for r in rs:
            r['marks'].sort(key=lambda p:p[0])
            if not r['text']:continue
            if result and result[-1]['marks']==r['marks']:result[-1]['text']+=r['text']
            else:result.append(r)
        return result
    for b in v:
        if 'runs' in b:b['runs']=nr(b['runs'])
        if 'rows' in b:b['rows']=[[nr(c) for c in row] for row in b['rows']]
    return v

def verify(data,expected):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos=z.infolist(); names=[i.filename for i in infos]
        assert names[0]=='mimetype' and infos[0].compress_type==0 and infos[0].extra==b''
        assert len(names)==len(set(names));assert z.read('mimetype')==b'application/epub+zip'
        assert all(not n.startswith('/') and '..' not in n.split('/') for n in names)
        root=xml(z.read('META-INF/container.xml'));rootfiles=root.find(C+'rootfiles');assert len(rootfiles)==1
        opf=rootfiles[0].get('full-path');p=xml(z.read(opf));base=posixpath.dirname(opf)
        assert p.get('version')=='3.0'; assert p.get('unique-identifier')=='pub-id'
        metadata=p.find(O+'metadata');assert metadata.find(DC+'language').text=='und'
        assert metadata.find(DC+'identifier').text.startswith('urn:sha256:')
        assert metadata.find(O+"meta[@property='dcterms:modified']").text=='1970-01-01T00:00:00Z'
        assert metadata.find(O+"meta[@property='rendition:layout']").text=='reflowable'
        items={n.get('id'):dict(n.attrib) for n in p.find(O+'manifest')};assert len(items)==len(p.find(O+'manifest'))
        assert all(not any(s in n.get('properties','').split() for s in ['scripted','remote-resources']) for n in items.values())
        assert all(n['href'] and not any(t in n['href'] for t in [':','?','#','..','%']) for n in items.values())
        assert set(names)=={'mimetype','META-INF/container.xml',opf}|{base+'/'+n['href'] for n in items.values()}
        spine=[n.get('idref') for n in p.find(O+'spine')];assert spine and len(spine)==len(set(spine))
        # Real independent EPUB reader opens the actual ZIP, resolves package,
        # XHTML items, spine, TOC, metadata and image resources.
        book=epub.read_epub(io.BytesIO(data),options={'ignore_ncx':True})
        assert [i[0] for i in book.spine]==spine
        projection=[];titles=[];hrefs=[]
        def blocks(n,lists):
            tag=E.QName(n).localname
            if tag in ['ol','ul']:
                stack=lists+[[tag,int(n.get('start','1'))]]
                for li in n:
                    assert li.tag==H+'li'
                    for child in li:blocks(child,stack)
            elif tag=='table':
                rows=[];alignments=[]
                for tr in n.find(H+'tbody'):
                    row=[]
                    for td in tr:
                        style=dict(v.split(':',1) for v in td.get('style','').split(';') if v)
                        assert style['white-space']=='pre-wrap';row.append(runs(td))
                    if not alignments:alignments=[dict(v.split(':',1) for v in td.get('style','').split(';') if v)['text-align'] for td in tr]
                    rows.append(row)
                projection.append({'kind':'table','rows':rows,'alignments':alignments})
            elif tag=='figure':
                image=n.find(H+'img');path=base+'/'+image.get('src');blob=z.read(path)
                assert blob==book.get_item_with_href(image.get('src')).content
                projection.append({'kind':'image','alt':image.get('alt'),'caption':label(n.find(H+'figcaption')),'hash':hashlib.sha256(blob).hexdigest(),'width':int(image.get('width')),'height':int(image.get('height'))})
            else:
                assert tag in ['p','h1','h2','h3','h4','h5','h6'];assert n.get('style')=='white-space:pre-wrap'
                projection.append({'kind':tag,'runs':runs(n),'lists':lists})
        for ident in spine:
            item=items[ident];assert item['media-type']=='application/xhtml+xml'
            href=item['href'];hrefs.append(href)
            document=xml(book.get_item_with_id(ident).content);title=label(document.find(H+'head/'+H+'title'));titles.append(title)
            for node in document.iter():
                tag=E.QName(node).localname
                assert tag not in ['script','form','iframe','object','embed','link','audio','video']
                assert not any(E.QName(k).localname.lower().startswith('on') for k in node.attrib)
                if 'src' in node.attrib:assert node.tag==H+'img' and node.get('src').startswith('media/')
            for node in document.find(H+'body'):blocks(node,[])
        assert projection==normalized(expected), 'captured semantic projection differs'
        navs=[v for v in items.values() if v.get('properties')=='nav'];assert len(navs)==1
        nav=xml(z.read(base+'/'+navs[0]['href']));toc=nav.find(H+'body/'+H+'nav');assert toc.get(EP+'type')=='toc'
        links=list(toc.iter(H+'a'));assert [a.get('href') for a in links]==hrefs;assert [label(a) for a in links]==titles
        assert [v.href for v in book.toc]==hrefs;assert [v.title for v in book.toc]==titles
        assert book.get_metadata('DC','title')[0][0]==titles[0]==metadata.find(DC+'title').text
        return {'chapters':len(spine),'blocks':len(projection),'images':sum(b['kind']=='image' for b in projection)}

def mutate(data,path,transform):
    source=zipfile.ZipFile(io.BytesIO(data));target=io.BytesIO()
    with zipfile.ZipFile(target,'w') as z:
        for info in source.infolist():
            b=source.read(info.filename)
            if info.filename==path:b=transform(b)
            z.writestr(info,b)
    return target.getvalue()
def main():
    results={}
    for name in ['supported','chapters','empty-title']:
        data=(out/f'export-{name}.epub').read_bytes();expected=json.loads((out/f'expected-{name}.json').read_text());results[name]=verify(data,expected)
    # Each mutation must fail the same structural + source-derived semantic oracle.
    data=(out/'export-supported.epub').read_bytes();expected=json.loads((out/'expected-supported.json').read_text())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        chapter=next(n for n in z.namelist() if n.startswith('EPUB/chapter-') and b'<strong>' in z.read(n))
        image=next(n for n in z.namelist() if n.endswith('.png'))
    mutations=[('text',chapter,lambda b:b.replace(b'cell A',b'cell X')),('mark',chapter,lambda b:b.replace(b'<strong>',b'<em>').replace(b'</strong>',b'</em>')),('spine','EPUB/package.opf',lambda b:b.replace(b'<itemref idref="c0"/><itemref idref="c1"/>',b'<itemref idref="c1"/><itemref idref="c0"/>')),('toc','EPUB/nav.xhtml',lambda b:b.replace(b'chapter-0.xhtml',b'chapter-99.xhtml')),('image',image,lambda b:b[:-1]+bytes([b[-1]^1])),('active',chapter,lambda b:b.replace(b'</body>',b'<script>evil()</script></body>')),('metadata','EPUB/package.opf',lambda b:b.replace(b'>und<',b'>en<')),('remote',chapter,lambda b:b.replace(b'src="media/',b'src="https://evil.test/')),('alt',chapter,lambda b:b.replace(b'alt="alt ',b'alt="changed '))]
    for name,path,transform in mutations:
        changed=mutate(data,path,transform);assert changed!=data,name
        try:verify(changed,expected)
        except (AssertionError,KeyError,E.XMLSyntaxError):pass
        else:raise AssertionError('mutation accepted:'+name)
    summary={'state':'passed','reader':{p:importlib.metadata.version(p) for p in ['EbookLib','lxml','six']},'fixtures':results,'negativeMutations':len(mutations),'mutations':[m[0] for m in mutations]}
    (out/'independent-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))

if __name__=='__main__': main()
