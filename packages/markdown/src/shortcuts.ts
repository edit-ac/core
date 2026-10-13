import type {EngineHandle, FragmentBlock, PrepareRequest, CommitResult, StableRange} from '@edit-ac/core';

/** Finite bounded rules. The input owner supplies proven direct-key eligibility;
 * this class never subscribes to remote updates or scans the document. */
export class TypingShortcuts {
  enabled = true;
  #reversal: {revision:number;node:string;offset:number}|undefined;
  #escaped = false;
  readonly #engine: EngineHandle;
  readonly #commit: (request:PrepareRequest)=>CommitResult;
  constructor(engine: EngineHandle, commit: (request:PrepareRequest)=>CommitResult) {
    this.#engine = engine;
    this.#commit = commit;}
  key(key:string): void {if(key==='Escape')this.#escaped=true;else if(key!=='Backspace')this.#reversal=undefined;}
  reverse(): {node:string;offset:number}|undefined {
    const previous=this.#reversal;this.#reversal=undefined;
    if(!previous||this.#engine.read().revision!==previous.revision)return;
    this.#engine.history({type:'undo'});return previous;
  }
  convert(range:StableRange,text:string,origin:string): CommitResult|undefined {
    if(!this.#engine.markdownAvailable||!this.enabled||this.#escaped){this.#escaped=false;return;}
    const a=this.#engine.resolve(range.anchor),b=this.#engine.resolve(range.focus);
    if(a.type!=='position'||b.type!=='position'||a.node!==b.node||a.offset!==b.offset)return;
    const node=this.#engine.read().visible.find(n=>n.id===a.node),before=node?.runs.map(r=>r.text).join('')??'';
    if(!node||(!Array.isArray(node.blockAttributes)||node.blockAttributes[0]!=='paragraph')||before.length>2048||a.offset!==before.length||node.runs.some(r=>Object.values(r.attributes).some(v=>v!==null&&v!==false)))return;
    const source=before+text;let blocks:readonly FragmentBlock[]|undefined;
    if(text===' '&&/^(#{1,6}|[-+*]|[1-9]\d{0,8}[.)]|>|[-+*] \[[ xX]\]) $/.test(source)){
      if(source.startsWith('#'))blocks=[{attributes:{type:'heading',level:source.trim().length},runs:[]}];
      else if(source.startsWith('>'))blocks=[{attributes:{type:'paragraph'},runs:[],containers:[{key:'typing-quote',style:{type:'quote'}}]}];
      else {const ordered=/^(\d+)[.)]/.exec(source),check=/^[-+*] \[([ xX])\]/.exec(source);blocks=[{attributes:{type:'paragraph'},runs:[],containers:[{key:'typing-list',style:ordered?{type:'ordered',start:Number(ordered[1])}:check?{type:'checklist'}:{type:'unordered'}}],...(check?{checked:check[1]!.toLowerCase()==='x'}:{})}];}
    }else if((text==='\n'||text===' ')&&/^```[a-zA-Z0-9+._-]{0,64}[\n ]$/.test(source))blocks=[{attributes:{type:'code',language:before.slice(3)},runs:[]}];
    else if(/[*_~`]$/.test(text)&&/(?:\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|`[^`]+`)$/.test(source)&&!source.includes('\\')){
      const prepared=this.#engine.importMarkdown(source);
      if(!prepared.diagnostics.length&&prepared.blocks.length===1&&prepared.blocks[0]!.runs.some(r=>r.marks.length))blocks=prepared.blocks;
    }
    if(!blocks)return;
    const anchor=this.#engine.anchor(a.node,0,'right'),focus=this.#engine.anchor(a.node,before.length,'left');
    try{
      const request:PrepareRequest={kind:'fragment',origin,range:{anchor,focus},blocks};
      if(!this.#engine.can(request))return;
      this.#engine.history({type:'boundary'});this.#engine.history({type:'explicit'});
      const result=this.#commit(request);this.#engine.history({type:'boundary'});
      this.#reversal={revision:this.#engine.read().revision,node:a.node,offset:before.length};return result;
    }finally{this.#engine.releaseAnchor(anchor);this.#engine.releaseAnchor(focus);}
  }
}
