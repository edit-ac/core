"""Independent marked-content/ToUnicode inspection of generated artifacts only.
Supports the writer's pinned Identity-H / bfchar subset; unknown mappings fail.
"""
import re
from pypdf.generic import ContentStream

def marked_text(reader):
    actual={};ordered=[]
    for page in reader.pages:
        stack=[];font=None;cmap={}
        for key,ref in page['/Resources'].get('/Font',{}).items():
            obj=ref.get_object()
            if '/ToUnicode' not in obj:continue
            mapping={}
            for block in re.findall(rb'beginbfchar(.*?)endbfchar',obj['/ToUnicode'].get_data(),re.S):
                for source,target in re.findall(rb'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>',block):
                    mapping[bytes.fromhex(source.decode())]=bytes.fromhex(target.decode()).decode('utf-16-be')
            cmap[key]=mapping
        def current():
            return next((props['key'] for props in reversed(stack) if props.get('key') is not None),None)
        def append(value):
            key=current()
            assert key is not None,'logical text without marked-content identity'
            actual[key]+=value
        for args,op in ContentStream(page['/Contents'],reader).operations:
            if op==b'Tf':font=args[0]
            if op in (b'BDC',b'BMC'):
                props=args[1] if op==b'BDC' and hasattr(args[1],'get') else {}
                key=(page.indirect_reference.idnum,int(props['/MCID'])) if '/MCID' in props else None
                if key is not None:
                    assert key not in actual,'duplicate marked-content identity'
                    actual[key]='';ordered.append(key)
                covered=any(item['covered'] for item in stack)
                stack.append({'key':key,'covered':covered or '/ActualText' in props,'lang':props.get('/Lang')})
                if '/ActualText' in props and not covered:append(str(props['/ActualText']))
            elif op==b'EMC':
                assert stack;stack.pop()
            elif op in (b'Tj',b'TJ') and current() is not None and not any(item['covered'] for item in stack):
                # Unreplaced Arabic clusters use the writer's CID ToUnicode map.
                assert any(item.get('lang')=='ar' for item in stack),'unexpected untagged replacement policy'
                strings=args[0] if op==b'TJ' else [args[0]]
                for part in strings:
                    if isinstance(part,(int,float)):continue
                    data=part.original_bytes if hasattr(part,'original_bytes') else bytes(part)
                    assert len(data)%2==0,'non Identity-H glyph encoding'
                    for i in range(0,len(data),2):
                        code=data[i:i+2];assert code in cmap[font],'missing CID Unicode mapping'
                        append(cmap[font][code])
        assert not stack,'unbalanced marked content'
    return [actual[key] for key in ordered],actual
