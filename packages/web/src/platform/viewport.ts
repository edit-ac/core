/** CSS pixels in the owning document's client coordinate space. No DPR/scale
 * conversion and no inference of keyboard presence from viewport size. */
export interface ViewportRect { left: number; top: number; width: number; height: number }
export interface ViewportGeometry {
  visual: ViewportRect; scale: number;
  /** Host-observed occlusion, not an assumed bottom keyboard inset. */
  occlusions?: readonly ViewportRect[];
  safeArea?: { top: number; right: number; bottom: number; left: number };
}
export interface ViewportOptions {
  requestedMode?: 'resizes-content' | 'resizes-visual' | 'overlays-content';
  /** Shared host geometry port; all mounts in a window must use the same port.
   * Does not request permissions, alter meta viewport or lease a keyboard API. */
  geometry?: () => ViewportGeometry;
}
interface Snapshot extends ViewportGeometry { fallback: boolean }
interface Consumer { read(snapshot: Snapshot): () => void }
const owners = new WeakMap<Window, ViewportOwner>();
function valid(r: ViewportRect): boolean { return [r.left,r.top,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0; }
class ViewportOwner {
  readonly consumers = new Set<Consumer>();
  readonly leases = new Set<Consumer>();
  readonly occlusionSources = new Set<() => ViewportRect | undefined>();
  readonly sources = new Map<EventTarget, number>();
  frame: number | undefined;
  reads = 0; writes = 0;
  private visual: VisualViewport | null = null;
  constructor(readonly window: Window, readonly geometry: (() => ViewportGeometry) | undefined) {
    window.addEventListener('resize', this.invalidate, { passive: true });
    window.addEventListener('scroll', this.invalidate, { passive: true });
    try { this.visual = window.visualViewport; } catch { /* ordinary layout fallback */ }
    this.visual?.addEventListener('resize', this.invalidate, { passive: true });
    this.visual?.addEventListener('scroll', this.invalidate, { passive: true });
  }
  readonly invalidate = (): void => {
    if (this.frame !== undefined || !this.consumers.size) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = undefined; this.reads++;
      const snapshot = this.snapshot();
      // Complete all coordinate reads before any consumer writes.
      const writes = [...this.consumers].map(c => ({ c, write: c.read(snapshot) }));
      this.writes++;
      for (const {c,write} of writes) if (this.consumers.has(c)) write();
    });
  };
  snapshot(): Snapshot {
    try {
      const v = this.visual;
      const g = this.geometry ? this.geometry() : { visual: v ? { left:v.offsetLeft,top:v.offsetTop,width:v.width,height:v.height } : {left:0,top:0,width:this.window.innerWidth,height:this.window.innerHeight}, scale:v?.scale ?? 1 };
      if (!valid(g.visual) || !Number.isFinite(g.scale) || g.scale <= 0 || (g.occlusions && (g.occlusions.length>8 || g.occlusions.some(r => !valid(r)))) || (g.safeArea && [g.safeArea.top,g.safeArea.right,g.safeArea.bottom,g.safeArea.left].some(n=>!Number.isFinite(n)||n<0))) throw Error('Unusable viewport');
      const occlusions = [...(g.occlusions ?? [])];
      for (const source of this.occlusionSources) {
        try { const r = source(); if (r && valid(r) && occlusions.length < 8 && !occlusions.some(old => old.left===r.left && old.top===r.top && old.width===r.width && old.height===r.height)) occlusions.push({...r}); } catch { /* optional capability fallback */ }
      }
      return {visual:{...g.visual},scale:g.scale,...(g.occlusions || occlusions.length?{occlusions}:{}),...(g.safeArea?{safeArea:{...g.safeArea}}:{}),fallback: !this.geometry && !v};
    } catch { return { visual:{left:0,top:0,width:Math.max(1,this.window.innerWidth),height:Math.max(1,this.window.innerHeight)},scale:1,fallback:true }; }
  }
  source(target: EventTarget): () => void {
    const n = this.sources.get(target) ?? 0;
    if (!n) target.addEventListener('scroll',this.invalidate,{passive:true,capture:true});
    this.sources.set(target,n+1);
    return () => { const n=this.sources.get(target)!; if(n===1){target.removeEventListener('scroll',this.invalidate,true);this.sources.delete(target);}else this.sources.set(target,n-1); };
  }
  release(consumer: Consumer): void {
    this.consumers.delete(consumer); this.leases.delete(consumer);
    if (this.leases.size) return;
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
    this.frame=undefined;
    for(const target of [this.window,this.visual]) for(const type of ['resize','scroll']) target?.removeEventListener(type,this.invalidate);
    for(const target of this.sources.keys())target.removeEventListener('scroll',this.invalidate,true);
    this.sources.clear();owners.delete(this.window);
  }
}
function acquire(window: Window, options: ViewportOptions): ViewportOwner {
  let owner=owners.get(window);
  if(owner && owner.geometry!==options.geometry)throw Error('Conflicting owning-window viewport geometry port');
  if(!owner){owner=new ViewportOwner(window,options.geometry);owners.set(window,owner);}return owner;
}
/** Per-surface lease over one scheduled geometry owner per window. */
export class EditorViewport {
  private readonly owner: ViewportOwner;
  private readonly consumer: Consumer;
  private readonly releases: (()=>void)[]=[];
  private readonly controls=new Set<HTMLElement>();
  private readonly controlStyles=new Map<HTMLElement,string>();
  private follow=false;
  private disposed=false;
  private suspended=false;
  private previous: Snapshot | undefined;
  private snapshot: Snapshot | undefined;
  constructor(readonly root: HTMLElement, readonly options: ViewportOptions = {}, private readonly geometryChanged?: (recoverable:boolean)=>void) {
    this.owner=acquire(root.ownerDocument.defaultView!,options);
    this.consumer={read:s=>this.measure(s)};this.owner.leases.add(this.consumer);this.owner.consumers.add(this.consumer);
    // Capture scroll on actual nested roots, without accessing any parent window.
    this.releases.push(this.owner.source(root.ownerDocument));
    const focus=()=>this.requestCaret();
    root.addEventListener('focus',focus);this.releases.push(()=>root.removeEventListener('focus',focus));
    this.owner.invalidate();
  }
  get state() { return { requestedMode:this.options.requestedMode ?? 'resizes-content',observed:this.snapshot,readBatches:this.owner.reads,writePhases:this.owner.writes,pendingFrame:this.owner.frame!==undefined,consumers:this.owner.consumers.size,disposed:this.disposed,suspended:this.suspended }; }
  suspend(): void {
    if(this.disposed || this.suspended)return;
    this.suspended=true;this.follow=false;this.owner.consumers.delete(this.consumer);
    if(!this.owner.consumers.size && this.owner.frame!==undefined){this.owner.window.cancelAnimationFrame(this.owner.frame);this.owner.frame=undefined;}
  }
  resume(): void {
    if(this.disposed || !this.suspended)return;
    this.suspended=false;this.previous=undefined;this.owner.consumers.add(this.consumer);this.invalidate();
  }
  invalidate(): void { if(!this.disposed && !this.suspended)this.owner.invalidate(); }
  /** Optional host-leased geometry, merged once per owning-window read batch. */
  addOcclusionSource(source: () => ViewportRect | undefined): () => void {
    if (this.disposed) return () => {};
    this.owner.occlusionSources.add(source); this.invalidate();
    const release = () => { this.owner.occlusionSources.delete(source); this.invalidate(); };
    this.releases.push(release); return release;
  }
  /** Only explicit local edit/focus requests can scroll a caret. */
  requestCaret(): void { if(this.disposed || this.suspended)return;this.follow=true;this.owner.invalidate(); }
  addControls(element: HTMLElement): ()=>void {
    this.controlStyles.set(element,element.style.cssText);this.controls.add(element);this.invalidate();
    return ()=>{element.style.cssText=this.controlStyles.get(element)??'';this.controlStyles.delete(element);this.controls.delete(element);};
  }
  private measure(s: Snapshot): ()=>void {
    const old=this.previous;this.previous=s;
    const changed=!!old && JSON.stringify(old)!==JSON.stringify(s);
    const recoverable=!s.fallback && (!old || old.scale===s.scale) && this.root.isConnected;
    const v=s.visual,a=s.safeArea??{top:0,right:0,bottom:0,left:0};
    const visible={left:v.left+a.left,top:v.top+a.top,right:v.left+v.width-a.right,bottom:v.top+v.height-a.bottom};
    // Only full-width bottom occlusions reduce the available bottom. Floating
    // rectangles remain local obstacles rather than invented keyboard heights.
    for(const r of s.occlusions??[])if(r.left<=visible.left && r.left+r.width>=visible.right && r.top+r.height>=visible.bottom)visible.bottom=Math.min(visible.bottom,r.top);
    // Fit controls into a real unobstructed rectangle. Floating/split keyboard
    // geometry is not a full-width inset; choose the largest remaining region.
    let regions=[visible];
    for(const r of s.occlusions??[]) {
      const next: typeof regions=[];
      for(const b of regions) {
        if(r.left>=b.right||r.left+r.width<=b.left||r.top>=b.bottom||r.top+r.height<=b.top){next.push(b);continue;}
        next.push({...b,bottom:Math.min(b.bottom,r.top)}, {...b,top:Math.max(b.top,r.top+r.height)}, {...b,right:Math.min(b.right,r.left)}, {...b,left:Math.max(b.left,r.left+r.width)});
      }
      regions=next.filter(b=>b.right>b.left&&b.bottom>b.top).sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top)).slice(0,8);
    }
    const panel=regions.sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top))[0]??visible;
    const controlReads=[...this.controls].filter(e=>!e.hidden).map(e=>({e,rect:e.getBoundingClientRect()}));
    const doc=this.root.ownerDocument,native=doc.getSelection();
    let caret: DOMRect | undefined;
    const follow=this.follow;this.follow=false;
    if(follow && doc.activeElement===this.root && native?.focusNode && this.root.contains(native.focusNode)) {
      try{const range=doc.createRange();range.setStart(native.focusNode,native.focusOffset);range.collapse(true);caret=range.getBoundingClientRect();}catch{/* native scrolling remains available */}
    }
    const scrollers: {element:Element;top:number;bottom:number;left:number;right:number}[]=[];
    if(caret)for(let el:Element|null=this.root;el;el=el.parentElement)if(el.scrollHeight>el.clientHeight){const b=el===doc.scrollingElement?{top:0,bottom:this.owner.window.innerHeight,left:0,right:this.owner.window.innerWidth}:el.getBoundingClientRect();scrollers.push({element:el,top:b.top,bottom:b.bottom,left:b.left,right:b.right});}
    return ()=>{
      this.snapshot=s;
      if(changed)this.geometryChanged?.(recoverable);
      for(const {e,rect} of controlReads){
        // A bounded sheet remains scrollable even when the viewport is tiny.
        // This lease owns these layout properties; host meta/API policy is untouched.
        e.style.maxHeight=`${Math.max(1,panel.bottom-panel.top)}px`;e.style.overflowY='auto';e.style.maxWidth=`${Math.max(1,panel.right-panel.left)}px`;
        const outside=rect.bottom>visible.bottom||rect.top<visible.top||rect.left<visible.left||rect.right>visible.right||(s.occlusions??[]).some(r=>rect.left<r.left+r.width&&rect.right>r.left&&rect.top<r.top+r.height&&rect.bottom>r.top);
        if(outside){e.style.position='fixed';e.style.top=`${panel.top}px`;e.style.left=`${panel.left}px`;e.style.bottom='auto';e.style.maxWidth=`${Math.max(1,panel.right-panel.left)}px`;}
      }
      if(caret && caret.height>0){
        const top=visible.top;let bottom=visible.bottom,caretTop=caret.top,caretBottom=caret.bottom;
        for(const r of s.occlusions??[])if(caret.left>=r.left&&caret.left<=r.left+r.width&&caret.bottom>r.top&&caret.top<r.top+r.height)bottom=Math.min(bottom,r.top);
        for(const b of scrollers){const t=Math.max(top,b.top),end=Math.min(bottom,b.bottom);const dy=caretBottom>end?caretBottom-end:caretTop<t?caretTop-t:0;if(dy){const before=b.element.scrollTop;b.element.scrollTop+=dy;const moved=b.element.scrollTop-before;caretTop-=moved;caretBottom-=moved;}}
      }
    };
  }
  dispose(): void { if(this.disposed)return;this.disposed=true;for(const release of this.releases)release();for(const [e,css] of this.controlStyles)e.style.cssText=css;this.controlStyles.clear();this.controls.clear();this.owner.release(this.consumer); }
}
