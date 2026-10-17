"""Generated output only: independent glyph identity, joining and zero-advance placement.
Reference is pinned standalone HarfBuzz, not exporter-reported lines or rustybuzz.
"""
import io,json,pathlib,sys,hashlib
from importlib.machinery import SourceFileLoader
import fitz,pypdf
from fontTools.ttLib import TTFont
from pypdf.generic import ContentStream,FloatObject
base=SourceFileLoader('text_oracle',str(pathlib.Path(__file__).with_name('inspect-pdf-export.py'))).load_module()

def glyphs(data, reference):
    reader=pypdf.PdfReader(io.BytesIO(data),strict=True)
    doc=fitz.open(stream=data,filetype='pdf')
    actual=[]
    for page_index,page in enumerate(doc):
        order=None
        for ref in reader.pages[page_index]['/Resources']['/Font'].values():
            font=ref.get_object()
            if 'NotoNaskhArabic' in font['/BaseFont']:
                descendant=font['/DescendantFonts'][0].get_object()
                assert descendant['/CIDToGIDMap']=='/Identity'
                embedded=TTFont(io.BytesIO(descendant['/FontDescriptor']['/FontFile2'].get_data()))
                order=embedded.getGlyphOrder()
        for span in page.get_texttrace():
            if 'NotoNaskhArabic' not in span['font']:continue
            assert abs(span['size']-reference['fontSizePt'])<0.01
            for _,gid,origin,_ in span['chars']:
                if gid>=0:actual.append((order[gid],origin)) # -1 is synthetic ToUnicode expansion, not another painted glyph
    expected=reference['glyphs']
    # Text drawing order is logical; compare actual painted identities/positions
    # to the independent visual shaping reference irrespective of paint order.
    scale=reference['fontSizePt']/reference['unitsPerEm']
    x0=min(g[1][0] for g in actual);y0=max(g[1][1] for g in actual)
    advance=0;zero=0;wanted=[]
    for g in expected:
        wanted.append((g['g'],(x0+(advance+g['dx'])*scale,y0-g['dy']*scale)))
        advance+=g['ax'];zero+=g['ax']==0
    assert sorted(g[0] for g in actual)==sorted(g[0] for g in wanted), 'Arabic painted glyph identities/joining changed'
    remaining=actual.copy()
    for name,(x,y) in wanted:
        matches=[(i,p) for i,(n,p) in enumerate(remaining) if n==name and abs(p[0]-x)<=reference['positionTolerancePt']]
        assert matches,'Arabic glyph horizontal placement changed'
        match=next(((i,p) for i,p in matches if abs(p[1]-y)<=reference['positionTolerancePt']),None)
        assert match is not None,'Arabic zero-advance mark placement changed'
        remaining.pop(match[0])
    assert zero>=3 and any(g['g'].endswith('.rlig') for g in expected)
    return {'paintedGlyphs':len(actual),'zeroAdvanceGlyphs':zero,'advancePt':advance*scale,'referenceTool':reference['referenceTool'],'positionTolerancePt':reference['positionTolerancePt']}

def main(root,reference_path):
    reference=json.loads(reference_path.read_text());data=(root/'text-publication.pdf').read_bytes()
    expected=json.loads(pathlib.Path('fixtures/formats/pdf/export/text.json').read_text())
    assert reference['text'] in expected
    assert hashlib.sha256(pathlib.Path('fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf').read_bytes()).hexdigest()==reference['fontSha256']
    doc=fitz.open(stream=data,filetype='pdf')
    copied=[line for page in doc for line in page.get_text().splitlines() if any('\u0600'<=c<='\u06ff' for c in line)]
    assert copied==[reference['text']], 'declared MuPDF reader Arabic copy text differs from source'
    word=doc[0].search_for('العربية');phrase=doc[0].search_for(reference['text'])
    assert word and phrase,'declared MuPDF reader Arabic word/phrase search failed'
    result={'inspection':glyphs(data,reference),'reader':{'name':'MuPDF','version':fitz.VersionBind,'copiedArabicLines':copied,'wordSearchRectangles':len(word),'phraseSearchRectangles':len(phrase),'scope':'exact fixture copy and search; other reader extraction behavior is not inferred'},'rejectedMutations':[],'reasons':{}}
    for mutation in ['arabic-painted-ligature-lost','arabic-zero-advance-mark-moved']:
        writer=pypdf.PdfWriter(clone_from=io.BytesIO(data));page=writer.pages[0]
        stream=ContentStream(page['/Contents'],writer);active=False;replacement=False;changed=False
        for i,(args,op) in enumerate(stream.operations):
            if op==b'Tf':active='NotoNaskhArabic' in page['/Resources']['/Font'][args[0]].get_object()['/BaseFont']
            if op==b'BDC':replacement=hasattr(args[1],'get') and '/ActualText' in args[1]
            if op==b'EMC':replacement=False
            if not active:continue
            if mutation.endswith('lost') and replacement and op in (b'Tj',b'TJ'):
                del stream.operations[i];changed=True;break
            if op==b'Tm':
                if mutation.endswith('moved') and abs(float(args[5])-114)>0.1:
                    args[5]=FloatObject(float(args[5])+5);changed=True;break
        assert changed,'missing mutation target';base.replace_stream(page,stream);changed_data=base.write(writer)
        (root/(mutation+'.pdf')).write_bytes(changed_data)
        base.logical(changed_data,expected) # exact logical text intentionally survives this paint corruption
        fitz.TOOLS.mupdf_warnings();probe=fitz.open(stream=changed_data,filetype='pdf')
        for page in probe:page.get_texttrace()
        warnings=fitz.TOOLS.mupdf_warnings()
        assert all('Actualtext with no position' in line or 'repeated' in line for line in warnings.splitlines()),warnings
        try:glyphs(changed_data,reference)
        except AssertionError as e:
            reason='Arabic painted glyph identities' if mutation.endswith('lost') else 'Arabic zero-advance mark placement'
            assert reason in str(e),(mutation,str(e));result['rejectedMutations'].append(mutation);result['reasons'][mutation]=str(e)
        else:raise AssertionError('glyph oracle accepted '+mutation)
    (root/'arabic-inspection.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':main(*map(pathlib.Path,sys.argv[1:]))
