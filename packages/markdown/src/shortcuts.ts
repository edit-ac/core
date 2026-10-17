import type {EngineHandle, FragmentBlock, PrepareRequest, CommitResult, StableRange} from '@edit-ac/core';

/** Public policy is intentionally finite and independent of paste parsing.
 * Block prefixes require one final space; fences require Enter. Inline rules
 * require a closing delimiter; safe URL/email recognition requires a space.
 * Only the input owner may establish direct-key eligibility. */
export const typingRulePolicy = Object.freeze({
  maximumPrefix: 2048,
  block: /^(#{1,6}|[-+*]|[0-9]{1,9}[.)]|>|[-+*] \[[ xX]\]) $/,
  fence: /^(`{3,}|~{3,})([a-zA-Z0-9+._-]{0,64})\n$/,
  linkPunctuation: /[。）、，！？；：…»”’〉》」』】]+$/u,
});

/** Require a complete delimiter run, rather than matching one star inside an
 * unfinished double-star run. The pinned parser still owns nesting/escaping. */
function closedInline(source:string):boolean {
  const delimiter=/(\*{1,3}|_{1,3}|~~|`{1,16})$/.exec(source)?.[1];
  if(!delimiter)return false;
  const body=source.slice(0,-delimiter.length),at=body.lastIndexOf(delimiter);
  if(at<0||body[at-1]===delimiter[0]||body[at-1]==='\\'||body[at+delimiter.length]===delimiter[0])return false;
  const content=body.slice(at+delimiter.length);
  return content.length>0&&(delimiter[0]==='`'||content.trim()===content);
}

/** Finite bounded rules. The input owner supplies proven direct-key eligibility;
 * this class never subscribes to remote updates or scans the document. */
export class TypingShortcuts {
  enabled = true;
  #reversal: {revision:number;node:string;offset:number;trigger:string;caret:{node:string;offset:number}}|undefined;
  #escaped = false;
  readonly #engine: EngineHandle;
  readonly #commit: (request:PrepareRequest)=>CommitResult;
  constructor(engine: EngineHandle, commit: (request:PrepareRequest)=>CommitResult) {
    this.#engine = engine;
    this.#commit = commit;}
  key(key:string): void {if(key==='Escape')this.#escaped=true;if(key!=='Backspace')this.#reversal=undefined;}
  reverse(range:StableRange): {node:string;offset:number}|undefined {
    const previous=this.#reversal;this.#reversal=undefined;
    if(!this.enabled||!previous||this.#engine.read().revision!==previous.revision)return;
    const a=this.#engine.resolve(range.anchor),b=this.#engine.resolve(range.focus);
    if(a.type!=='position'||b.type!=='position'||a.node!==previous.caret.node||a.offset!==previous.caret.offset||b.node!==a.node||b.offset!==a.offset)return;
    // Conversion is one atomic prepared edit. Undo restores the prefix; retain
    // the triggering character as ordinary typing in its own history boundary.
    if(this.#engine.history({type:'state'}).undoGroups===0)return;
    const undone=this.#engine.history({type:'undo'});
    if(undone.selection){this.#engine.releaseAnchor(undone.selection.anchor);this.#engine.releaseAnchor(undone.selection.focus);}
    const at=this.#engine.anchor(previous.node,previous.offset,'right');
    try {
      this.#engine.history({type:'boundary'});this.#engine.history({type:'explicit'});
      const result=this.#commit({kind:'text',origin:'typing-rule:restore-source',command:{type:'insert',at,text:previous.trigger}});
      if(result.caret)this.#engine.releaseAnchor(result.caret);
      if(result.selection){this.#engine.releaseAnchor(result.selection.anchor);this.#engine.releaseAnchor(result.selection.focus);}
      return {node:previous.node,offset:previous.offset+previous.trigger.length};
    } finally {this.#engine.history({type:'boundary'});this.#engine.releaseAnchor(at);}
  }
  convert(range:StableRange,text:string,origin:string): CommitResult|undefined {
    if(!this.#engine.markdownAvailable||!this.enabled||this.#escaped){this.#escaped=false;return;}
    const a=this.#engine.resolve(range.anchor),b=this.#engine.resolve(range.focus);
    if(a.type!=='position'||b.type!=='position'||a.node!==b.node||a.offset!==b.offset)return;
    const node=this.#engine.read().visible.find(n=>n.id===a.node),before=node?.runs.map(r=>r.text).join('')??'';
    if(!node||(!Array.isArray(node.blockAttributes)||node.blockAttributes[0]!=='paragraph')||before.length>typingRulePolicy.maximumPrefix||a.offset!==before.length||node.runs.some(r=>Object.values(r.attributes).some(v=>v!==null&&v!==false)))return;
    const source=before+text;let blocks:readonly FragmentBlock[]|undefined;
    if(text===' '&&typingRulePolicy.block.test(source)){
      if(source.startsWith('#'))blocks=[{attributes:{type:'heading',level:source.trim().length},runs:[]}];
      else if(source.startsWith('>'))blocks=[{attributes:{type:'paragraph'},runs:[],containers:[{key:'typing-quote',style:{type:'quote'}}]}];
      else {const ordered=/^(\d+)[.)]/.exec(source),check=/^[-+*] \[([ xX])\]/.exec(source);blocks=[{attributes:{type:'paragraph'},runs:[],containers:[{key:'typing-list',style:ordered?{type:'ordered',start:Number(ordered[1])}:check?{type:'checklist'}:{type:'unordered'}}],...(check?{checked:check[1]!.toLowerCase()==='x'}:{})}];}
    }else if(text==='\n'&&typingRulePolicy.fence.test(source))blocks=[{attributes:{type:'code',language:typingRulePolicy.fence.exec(source)![2]!},runs:[]}];
    else if(/[*_~`]$/.test(text)&&closedInline(source)){
      const prepared=this.#engine.importMarkdown(source);
      if(!prepared.diagnostics.length&&prepared.blocks.length===1&&prepared.blocks[0]!.runs.some(r=>r.marks.length))blocks=prepared.blocks;
    }
    else if(text===' '&&/(?:https?:\/\/|www\.|[\w.+-]+@)/.test(before)){
      const suffix=typingRulePolicy.linkPunctuation.exec(before)?.[0]??'',candidate=before.slice(0,before.length-suffix.length);
      const prepared=this.#engine.importMarkdown(candidate),block=prepared.blocks[0];
      // Parsing must not trim the just-authored separator or consume other syntax.
      if(!prepared.diagnostics.length&&prepared.blocks.length===1&&block?.attributes?.type==='paragraph'&&block.runs.map(r=>r.text).join('')===candidate&&block.runs.some(r=>r.marks.some(m=>m.mark==='link')))
        blocks=[{...block,runs:[...block.runs,{text:suffix+text,marks:[]}]}];
    }
    if(!blocks)return;
    const anchor=this.#engine.anchor(a.node,0,'right'),focus=this.#engine.anchor(a.node,before.length,'left');
    try{
      const request:PrepareRequest={kind:'fragment',origin,range:{anchor,focus},blocks};
      if(!this.#engine.can(request))return;
      this.#engine.history({type:'boundary'});this.#engine.history({type:'explicit'});
      const result=this.#commit(request);this.#engine.history({type:'boundary'});
      const caret=result.caret?this.#engine.resolve(result.caret):result.selection?this.#engine.resolve(result.selection.focus):undefined;
      if(caret?.type==='position')this.#reversal={revision:this.#engine.read().revision,node:a.node,offset:before.length,trigger:text,caret:{node:caret.node,offset:caret.offset}};return result;
    }finally{this.#engine.releaseAnchor(anchor);this.#engine.releaseAnchor(focus);}
  }
}
