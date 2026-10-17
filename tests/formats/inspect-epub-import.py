"""Independent stdlib ZIP/XML oracle for the actual adapter input/projection."""
import copy,hashlib,json,posixpath,sys,zipfile
from pathlib import Path
from xml.etree import ElementTree as E
out=Path(sys.argv[1]);h='{http://www.w3.org/1999/xhtml}';o='{http://www.idpf.org/2007/opf}';c='{urn:oasis:names:tc:opendocument:xmlns:container}';e='{http://www.idpf.org/2007/ops}'
def label(n):
    result=n.text or ''
    for child in n:
        result+= ('\n' if child.tag==h+'br' else label(child))+(child.tail or '')
    return result
with zipfile.ZipFile(out/'supported.epub') as z:
    assert z.infolist()[0].filename=='mimetype' and z.infolist()[0].compress_type==0
    assert z.read('mimetype')==b'application/epub+zip'
    container=E.fromstring(z.read('META-INF/container.xml'));opf=container.find(c+'rootfiles/'+c+'rootfile').attrib['full-path'];package=E.fromstring(z.read(opf));base=posixpath.dirname(opf)
    entries={n.attrib['id']:n.attrib for n in package.find(o+'manifest')}
    spine=[entries[n.attrib['idref']]['href'] for n in package.find(o+'spine')]
    expected=[];chapters=[];images=0
    for href in spine:
        part=posixpath.normpath(base+'/'+href);root=E.fromstring(z.read(part));first=len(expected)
        for n in root.find(h+'body'):
            if n.tag in [h+'ol',h+'ul']:expected.extend(label(li) for li in n)
            elif (img:=n.find(h+'img')) is not None:
                expected.append(img.attrib['alt']);images+=1
                image=posixpath.normpath(posixpath.dirname(part)+'/'+img.attrib['src']);assert z.read(image).startswith(b'\x89PNG\r\n\x1a\n')
            else:expected.append(label(n))
        chapters.append({'part':part,'first':first,'count':len(expected)-first})
    nav=next(n['href'] for n in entries.values() if n.get('properties')=='nav');part=posixpath.normpath(base+'/'+nav);root=E.fromstring(z.read(part));toc=next(n for n in root.iter(h+'nav') if n.attrib.get(e+'type')=='toc');navigation=[]
    for a in toc.iter(h+'a'):
        href,fragment=a.attrib['href'].split('#');navigation.append({'label':label(a),'part':posixpath.normpath(posixpath.dirname(part)+'/'+href),'fragment':fragment})
projection=json.loads((out/'projection.json').read_text())
def verify(value):
    assert value['blocks']==expected,'semantic text/image order'
    assert value['chapters']==chapters,'chapter boundaries/provenance'
    assert value['navigation']==navigation,'navigation order/target/label'
verify(projection)
mutations=[]
m=copy.deepcopy(projection);m['blocks'][0]='corrupt';mutations.append(m)
m=copy.deepcopy(projection);m['blocks']=m['blocks'][6:]+m['blocks'][:6];mutations.append(m)
m=copy.deepcopy(projection);m['blocks'].pop(5);mutations.append(m)
m=copy.deepcopy(projection);m['chapters'][1]['first']=5;mutations.append(m)
m=copy.deepcopy(projection);m['navigation'].reverse();mutations.append(m)
for index,m in enumerate(mutations):
    try:verify(m)
    except AssertionError:continue
    raise AssertionError(f'negative mutation {index} accepted')
print(json.dumps({'state':'passed','images':images,'chapters':len(chapters),'blocks':len(expected),'negativeMutations':len(mutations),'sha256':hashlib.sha256((out/'supported.epub').read_bytes()).hexdigest(),'oracle':'independent Python stdlib ZIP/XML; no converter or live document'}))
