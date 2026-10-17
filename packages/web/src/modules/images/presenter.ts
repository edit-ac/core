import type { ContentContext, ContentView, ImageMetadata } from '../content.js';
import { imageLimits, inspectImage, validateImagePayload, type ImageLimits } from './policy.js';
import { renderContentRuns } from '../transfer.js';
import { FRAGMENT_MIME, encodeContentFragment } from '../../clipboard/fragment.js';
/** Mirrors the owning Rust assets records; descriptive metadata never grants access. */
export interface ImageAssetIdentity { host: string; key: string }
export interface ImageAssetDescriptor { identity: ImageAssetIdentity; kind: 'image'; metadata: { alt: string; caption: string; filename: string; mediaType: string; byteLength: number | null; sha256: string | null; width: number | null; height: number | null; durationMs: number | null }; fallback: string; source: string }
export type ImageAvailability = 'local' | 'queued' | 'available' | 'failed' | 'missing' | 'revoked' | 'locked' | 'offline';
export interface ImageAssetRequest { version: 1; operationId: string; identity: ImageAssetIdentity; action: 'resolve-url'; byteLimit: number }
export interface ImageAssetResolution { state: ImageAvailability; grant?: { identity: ImageAssetIdentity; actions: readonly string[] }; resolution?: { identity: ImageAssetIdentity; operationId: string; url: string } }
export interface ImageAssetPort {
  /** Must reauthorize this exact reference. No ambient credentials or automatic retries. */
  resolve(request: Readonly<ImageAssetRequest>, signal: AbortSignal): Promise<ImageAssetResolution>;
  /** Read cancellation only. Host retains recovery bytes and global binary/refcount ownership. */
  cancel?(request: Readonly<ImageAssetRequest>): void;
}
export interface ImageOptions { imageUrl?: (metadata: Readonly<ImageMetadata>) => string | null; imageAssets?: ImageAssetPort; imageLimits?: Partial<ImageLimits> }
type Descriptor = ImageMetadata | ImageAssetDescriptor;
const identityEqual = (a: ImageAssetIdentity | undefined,b: ImageAssetIdentity) => a?.host === b.host && a?.key === b.key;
export function imageDescriptor(node: ContentContext['node']): Descriptor | undefined {
  const t=node.blockAttributes;
  if (!Array.isArray(t) || t.length!==3 || t[1]!==1 || !t[2] || typeof t[2] !== 'object' || Array.isArray(t[2])) return;
  const d=t[2] as unknown as Record<string,unknown>;
  if (t[0]==='module:editac.image' && Object.keys(d).length===4 && ['url','alt','title','source'].every(k=>typeof d[k]==='string') && String(d.url).length<=4096 && String(d.alt).length<=8192 && String(d.title).length<=8192 && new TextEncoder().encode(String(d.source)).length<=1048576) return d as unknown as ImageMetadata;
  if (t[0]==='module:editac.asset' && d.kind==='image' && d.identity && d.metadata && typeof d.source==='string' && typeof d.fallback==='string') return d as unknown as ImageAssetDescriptor;
}
function authorizedUrl(value: string, legacy: boolean): string {
  if (value.length>4096 || /[\u0000-\u0020\u007f-\u009f]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) throw Error('unauthorized');
  const url=new URL(value);
  if (url.username || url.password || !(legacy ? ['http:','https:'] : ['https:','blob:']).includes(url.protocol)) throw Error('unauthorized');
  return url.href;
}
const failures = new Set(['missing','offline','locked','queued','revoked','failed','unavailable','unauthorized','media-unsupported','animated-unsupported','png-profile-unsupported','decoder-unavailable','encoded-byte-limit','decoded-size-limit','decoded-size-mismatch','malformed','canceled']);
let operation=0;
/** One bounded pool per configured content factory. No pending queue or polling. */
export function imagePresenters(options: ImageOptions): (context: ContentContext) => ContentView | undefined {
  const limits=imageLimits(options.imageLimits); let active=0;
  return context => {
    const descriptor=imageDescriptor(context.node); if (!descriptor) return;
    const doc=context.element.ownerDocument, retry=doc.createElement('button'), element=doc.createElement('section'), image=doc.createElement('img'), status=doc.createElement('p'), alt=doc.createElement('p'), source=doc.createElement('textarea');
    const events=['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','copy','cut','paste','pointerdown','pointermove','pointerup','pointercancel','dragstart','dragover','drop','dragend'];
    const contain=(event:Event)=>event.stopPropagation();
    let current=context.node;
    const copy=(event:Event)=>{const e=event as ClipboardEvent;if(e.clipboardData){e.clipboardData.setData('text/plain',event.target===source?source.value.slice(source.selectionStart,source.selectionEnd):source.value);if(event.target!==source)try{e.clipboardData.setData(FRAGMENT_MIME,encodeContentFragment(context.engine,current));}catch{/* Oversized/unsupported copies retain only explicit source text. */}e.preventDefault();}};
    element.addEventListener('copy',copy);
    for(const type of events)element.addEventListener(type,contain);
    element.dataset.contentModule='image'; element.contentEditable='false'; status.setAttribute('role','status'); source.readOnly=true; source.setAttribute('aria-label','Image source'); image.hidden=true; retry.type='button';retry.textContent='Load image';element.append(image,alt,source,status,retry);
    let disposed=false, key='', stop=()=>{};
    const setState=(value:string)=>{element.dataset.imageState=value;retry.hidden=['ready','loading','disposed'].includes(value);status.textContent=`Image ${value}; source preserved.`;};
    function update(node: ContentContext['node']): boolean {
      const d=imageDescriptor(node); if (disposed || !d) return false;
      current=node;
      if (!('url' in d)) renderContentRuns(alt,node);
      const next=JSON.stringify(d); if (next===key) return true; key=next; stop();
      const legacy='url' in d;
      image.alt=legacy?d.alt:d.metadata.alt; image.title=legacy?d.title:d.metadata.caption; if(legacy)alt.textContent=image.alt || 'Image'; source.value=d.source;
      image.hidden=true;image.removeAttribute('src');
      if (legacy ? !options.imageUrl : !options.imageAssets) {setState('missing');return true;}
      if (active>=limits.concurrency) {setState('busy');return true;}
      active++;
      const controller=new AbortController(); let live=true, slot=true, ownedUrl:string|undefined, decoder:HTMLImageElement|undefined, request:ImageAssetRequest|undefined, timer:ReturnType<typeof setTimeout>|undefined;
      let rejectDecode:((reason:Error)=>void)|undefined;
      const release=()=>{if(!live)return;live=false;if(slot){slot=false;active--;}if(timer)clearTimeout(timer);controller.abort();rejectDecode?.(Error('canceled'));if(decoder){decoder.onload=null;decoder.onerror=null;decoder.removeAttribute('src');decoder=undefined;}image.removeAttribute('src');image.hidden=true;if(ownedUrl){URL.revokeObjectURL(ownedUrl);ownedUrl=undefined;}if(request)try{options.imageAssets?.cancel?.(request);}catch{/* Host failure cannot retain browser ownership. */}};
      stop=release;timer=setTimeout(()=>{release();if(!disposed)setState('timeout');},limits.timeoutMs);setState('loading');
      void (async()=>{
        try {
          let url:string;
          if (legacy) {const resolved=options.imageUrl!(Object.freeze({...d})); if(!resolved)throw Error('missing');url=authorizedUrl(resolved,true);}
          else {
            request=Object.freeze({version:1,operationId:`image-${++operation}`,identity:Object.freeze({...d.identity}),action:'resolve-url',byteLimit:limits.encodedBytes});
            const result=await options.imageAssets!.resolve(request,controller.signal);if(!live)return;
            if(!['available','local'].includes(result.state))throw Error(failures.has(result.state)?result.state:'failed');
            if(!identityEqual(result.grant?.identity,d.identity)||!Array.isArray(result.grant?.actions)||result.grant.actions.length>10||new Set(result.grant.actions).size!==result.grant.actions.length||!result.grant.actions.includes('resolve-url')||!result.grant.actions.includes('read')||!identityEqual(result.resolution?.identity,d.identity)||result.resolution?.operationId!==request.operationId)throw Error('unauthorized');
            url=authorizedUrl(result.resolution.url,false);
          }
          if(!live)return;
          const response=await fetch(url,{signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});
          if(!live)return;
          if(!response.ok || !response.body)throw Error('unavailable');
          const declared=Number(response.headers.get('content-length'));if(declared>limits.encodedBytes)throw Error('encoded-byte-limit');
          const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
          try {while(true){const part=await reader.read();if(!live)return;if(part.done)break;size+=part.value.length;if(size>limits.encodedBytes)throw Error('encoded-byte-limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
          const inspected=inspectImage(bytes,limits);await validateImagePayload(bytes,controller.signal);if(!live)return;
          ownedUrl=URL.createObjectURL(new Blob([bytes],{type:inspected.type}));decoder=image;
          await new Promise<void>((resolve,reject)=>{rejectDecode=reject;decoder!.onload=()=>resolve();decoder!.onerror=()=>reject(Error('malformed'));decoder!.src=ownedUrl!;});rejectDecode=undefined;
          if(!live)return;
          if(decoder.naturalWidth!==inspected.width||decoder.naturalHeight!==inspected.height)throw Error('decoded-size-mismatch');
          decoder.onload=null;decoder.onerror=null;decoder=undefined;
          image.hidden=false;setState('ready');if(timer)clearTimeout(timer);
          if(slot){slot=false;active--;} // Decode/request slot released; displayed URL is owned until disposal.
        }catch(error){if(live){release();if(!disposed)setState(error instanceof Error && failures.has(error.message)?error.message:'failed');}}
      })();
      return true;
    }
    const originalUpdate=update;
    retry.onclick=()=>{key='';originalUpdate(current);};
    update(context.node);
    return {element,update(node){current=node;return update(node);},setReadOnly(){},dispose(){if(disposed)return;disposed=true;retry.onclick=null;element.removeEventListener('copy',copy);for(const type of events)element.removeEventListener(type,contain);stop();image.removeAttribute('src');image.hidden=true;setState('disposed');}};
  };
}
