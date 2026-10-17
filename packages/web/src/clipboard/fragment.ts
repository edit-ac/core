import { inputTextDiagnostic, literalLineEndings } from '../input/characters.js';
import { errorMessage, rejected } from '../errors.js';
import type { CommitResult, EngineHandle, FragmentBlock, FragmentRun, PrepareRequest, ProjectedNode, Snapshot } from '@edit-ac/core';
import { PendingPaste } from './pending.js';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';
import { importHTML, exportHTML } from './html.js';
import { inlineMarks } from '../dom/marks.js';
import { EXTENSION_TRANSFER_MIME } from '@edit-ac/core/extensions';

export const FRAGMENT_MIME = 'application/x-edit-ac-fragment+json';
const LIMIT = 1024 * 1024;
const exceedsLimit = (text: string): boolean => new TextEncoder().encode(text).length > LIMIT;
const names = new Set<string>([...inlineMarks, 'link']);
export interface Fragment { version: 1; schema: string; blocks: readonly FragmentBlock[] }
export interface ClipboardData { getData(type: string): string; setData(type: string, value: string): void }
export interface ClipboardOutcome { disposition: 'committed' | 'handled' | 'rejected'; reason?: string }
export interface ClipboardCodec { mime: string; prepare(raw: string): readonly FragmentBlock[] }
export function validateClipboardCodecs(codecs:readonly ClipboardCodec[]):void {
      const mimes=new Set<string>();
      for(const codec of codecs){if(!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(codec.mime)||mimes.has(codec.mime)||[FRAGMENT_MIME,'text/plain','text/html','text/markdown','text/x-markdown'].includes(codec.mime))throw Error('clipboard-codec-mime');mimes.add(codec.mime);}
      if(codecs.length>16)throw Error('clipboard-codec-limit');
}
export function decodeFragment(raw: string, engine: EngineHandle): Fragment {
  if (exceedsLimit(raw)) throw Error('fragment-limit');
  // Preserve browser JSON syntax diagnostics; Rust owns the bounded shape check.
  const value: unknown = JSON.parse(raw);
  engine.validateFragment(raw);
  return value as Fragment;
}
function blockStyle(node: ProjectedNode): FragmentBlock['attributes'] {
  const tuple = node.blockAttributes;
  if (!Array.isArray(tuple)) throw Error('unsupported-fragment-style');
  const type = tuple[0];
  if (type === 'paragraph' || type === 'separator') return { type };
  if (type === 'heading' && typeof tuple[1] === 'number') return { type, level: tuple[1] };
  if (type === 'code' && typeof tuple[1] === 'string') return { type, language: tuple[1] };
  if (['module:editac.asset','module:editac.image','module:editac.table','module:editac.callout','module:editac.reference','module:editac.inert-extension'].includes(String(tuple[0]))) return { type: 'content', tuple };
  throw Error('unsupported-fragment-style');
}
function clipRuns(node: ProjectedNode, start: number, end: number): FragmentRun[] {
  let offset = 0;
  const result: FragmentRun[] = [];
  for (const run of node.runs) {
    const from = Math.max(0, start - offset), to = Math.min(run.text.length, end - offset); offset += run.text.length;
    if (from >= to) continue;
    const marks: { mark: FragmentRun['marks'][number]['mark']; href?: string }[] = [];
    const opaqueMarks: { key: string; value: unknown }[] = [];
    for (const [mark, value] of Object.entries(run.attributes)) {
      if (!names.has(mark)) { opaqueMarks.push({key: mark, value}); continue; }
      if (value === true) marks.push({ mark: mark as FragmentRun['marks'][number]['mark'] });
      else if (mark === 'link' && typeof value === 'string') marks.push({ mark: 'link', href: value });
      else throw Error('unsupported-fragment-mark');
    }
    result.push({ text: run.text.slice(from, to), marks, ...(opaqueMarks.length ? {opaqueMarks} : {}) });
  }
  return result;
}

/** Owns clipboard intents independently of keyboard events. Native menu paste,
 * beforeinput-only paste and noncancelable replacement share one mutation gate. */
export class ClipboardInput {
  readonly diagnostics: string[] = [];
  readonly recovery: { mime: string; raw: string; reason: string }[] = [];
  last: ClipboardOutcome = { disposition: 'handled' };
  #disposed = false;
  #pending: { type: 'paste' | 'cut' | 'drop'; phase: 'event' | 'beforeinput'; target?: RetainedSelection; text?: string; nodes: string[] } | undefined;
  #sequence = 0;
  #literalNext = false;
  #generation = 0;
  readonly #reads = new Set<() => void>();
  pendingPaste: PendingPaste | undefined;
  plainTextPolicy: 'literal' | 'markdown' = 'literal';
  contentCodecs: import('@edit-ac/core').MarkdownOptions = {};
  readonly #renderer: DOMRenderer;
  readonly #selection: DOMSelection;
  readonly #engine: EngineHandle;
  readonly #commit: (request: PrepareRequest) => CommitResult;
  readonly #blocked: () => boolean;
  readonly #codecs: readonly ClipboardCodec[];
  constructor(renderer: DOMRenderer, selection: DOMSelection, engine: EngineHandle,
    commit: (request: PrepareRequest) => CommitResult, blocked: () => boolean,
    codecs: readonly ClipboardCodec[] = []) {
    this.#renderer = renderer;
    this.#selection = selection;
    this.#engine = engine;
    this.#commit = commit;
    this.#blocked = blocked;
    this.#codecs = codecs;
      validateClipboardCodecs(codecs);
    }
  get ownsMutations(): boolean { return !!this.#pending; }
  #diagnose(reason: string): void { this.diagnostics.push(reason); if (this.diagnostics.length > 32) this.diagnostics.shift(); }
  #move(result: CommitResult): void {
    if (!result.caret) { this.#selection.restore(); return; }
    try { this.#selection.move(result.caret);
    } finally { this.#engine.releaseAnchor(result.caret); }
  }
  #apply(target: RetainedSelection, blocks: readonly FragmentBlock[]): ClipboardOutcome {
    if (this.#disposed || this.#blocked() || !target.active) return rejected('clipboard-unavailable');
    const request: PrepareRequest = { kind: 'fragment', origin: `clipboard:${++this.#sequence}`, range: target.range, blocks };
    try {
      // Preparation/capability failure has no history or journal effects.
      if (!this.#engine.can(request)) return rejected('clipboard-target');
      this.#engine.history({ type: 'explicit' });
      try { this.#move(this.#commit(request)); } finally { this.#engine.history({ type: 'boundary' }); }
      return { disposition: 'committed' };
    } catch (error) { return rejected(errorMessage(error)); }
  }
  paste(data: Pick<ClipboardData, 'getData'>, options: { literal?: boolean } = {}): ClipboardOutcome {
    if (this.#disposed || this.#blocked()) return this.last = rejected('clipboard-unavailable');
    const target=this.#selection.retain();
    if (!target) return this.last=rejected('clipboard-selection');
    try {
      const source=this.#captureData(data);
      return this.last=this.#apply(target,this.#prepareData(target,{getData:mime=>source[mime]??''},options));
    }
    catch(error) { return this.last=rejected(errorMessage(error)); }
    finally {target.dispose();}
  }
  #captureData(data: Pick<ClipboardData,'getData'>, bounded = false): Record<string,string> {
    const source: Record<string,string>={};
    const mimes=[FRAGMENT_MIME,EXTENSION_TRANSFER_MIME,'text/markdown','text/x-markdown','text/html',
      'text/rtf','application/rtf','text/tab-separated-values',...this.#codecs.map(codec=>codec.mime),'text/plain'];
    if(mimes.length>32) throw Error('clipboard-codec-limit');
    for(const mime of new Set(mimes)) {
      const raw=data.getData(mime);
      if(raw) {if(bounded&&exceedsLimit(raw))throw Error('clipboard-limit');source[mime]=raw;}
    }
    return source;
  }
  #prepareData(target: RetainedSelection, data: Pick<ClipboardData,'getData'>, options: {literal?:boolean}, snapshot: Snapshot = this.#engine.read()): readonly FragmentBlock[] {
      const a = this.#engine.resolve(target.range.anchor), b = this.#engine.resolve(target.range.focus);
      if (a.type !== 'position' || b.type !== 'position') throw Error('clipboard-target');
      const node = snapshot.visible.find(n => n.id === a.node);
      let runOffset = 0;
      const inlineCode = node?.runs.some(run => { const start = runOffset; runOffset += run.text.length; return run.attributes.code === true && a.offset >= start && a.offset < runOffset; });
      const literal = options.literal || (Array.isArray(node?.blockAttributes) && node.blockAttributes[0] === 'code') || inlineCode;
      let blocks: readonly FragmentBlock[] | undefined;
      if(!literal)for(const mime of ['text/rtf','application/rtf','text/tab-separated-values']){
        const raw=data.getData(mime);if(raw&&!this.#codecs.some(c=>c.mime===mime)&&!exceedsLimit(raw)){this.#diagnose(`${mime}-codec-unavailable`);this.#recoverSource(mime,raw,`${mime}-codec-unavailable`);}
      }
      if (!literal) {
        const raw = data.getData(FRAGMENT_MIME);
        if (raw) try {
          const candidate = decodeFragment(raw, this.#engine).blocks;
          if (!this.#engine.can({ kind: 'fragment', origin: `clipboard:${this.#sequence+1}`, range: target.range, blocks: candidate })) throw Error('fragment-semantics');
          blocks = candidate;
          if (candidate.some(b => b.attributes?.type === 'content' && Array.isArray(b.attributes.tuple) && b.attributes.tuple[0] === 'module:editac.inert-extension')) this.#diagnose('inert-extension-source-fallback');
        }
        catch (error) { const reason=errorMessage(error);this.#diagnose(reason);if(!exceedsLimit(raw))this.#recoverSource(FRAGMENT_MIME,raw,reason); }
      }
      if (!blocks && !literal) {
        const raw = data.getData(EXTENSION_TRANSFER_MIME), codec = this.#codecs.find(c => c.mime === EXTENSION_TRANSFER_MIME);
        // A registered structured extension offer is authoritative. Invalid data
        // must not silently flatten into an accompanying HTML/plain flavor.
        if (raw && codec) {
          if (exceedsLimit(raw)) throw Error('clipboard-limit');
          try {
            blocks = decodeFragment(JSON.stringify({ version: 1, schema: snapshot.identity.schema, blocks: codec.prepare(raw) }), this.#engine).blocks;
            if (!this.#engine.can({kind:'fragment',origin:`clipboard:${this.#sequence+1}`,range:target.range,blocks})) throw Error('extension-semantics');
          } catch (error) { const reason = errorMessage(error); this.#diagnose(reason); this.#recoverSource(EXTENSION_TRANSFER_MIME,raw,reason); throw error; }
        }
      }
      if (!blocks && !literal) {
        for (const mime of ['text/markdown', 'text/x-markdown', 'text/html', ...this.#codecs.map(c => c.mime)]) {
          const raw = data.getData(mime); if (!raw) continue;
          try {
            if (exceedsLimit(raw)) throw Error('clipboard-limit');
            const codec = this.#codecs.find(c => c.mime === mime);
            if (codec) blocks = codec.prepare(raw);
            else if (mime === 'text/html') blocks = importHTML(this.#renderer.root.ownerDocument, raw, this.#engine, code => { this.#diagnose(code); this.#recoverSource(mime, raw, code); });
            else if (mime === 'text/markdown' || mime === 'text/x-markdown') blocks = this.#markdown(raw, mime);
            else throw Error(`${mime}-importer-unavailable`);
            blocks = decodeFragment(JSON.stringify({ version: 1, schema: snapshot.identity.schema, blocks }), this.#engine).blocks;
            if (!this.#engine.can({ kind: 'fragment', origin: `clipboard:${this.#sequence+1}`, range: target.range, blocks })) throw Error(`${mime}-semantics`);
            break;
          } catch (error) {
            blocks = undefined;
            const reason = errorMessage(error); this.#diagnose(reason);
            if (!exceedsLimit(raw)) {
              this.recovery.push({ mime, raw, reason }); if (this.recovery.length > 4) this.recovery.shift();
            }
          }
        }
      }
      if (!blocks) {
        const text = this.#literal(data.getData('text/plain'));
        if (!text) throw Error('clipboard-empty');
        if (!literal && this.plainTextPolicy === 'markdown' && !this.#engine.markdownAvailable) {
          this.#diagnose('markdown-codec-unavailable'); this.#recoverSource('text/plain', text, 'markdown-codec-unavailable');
        }
        blocks = !literal && this.plainTextPolicy === 'markdown' && this.#engine.markdownAvailable ? this.#markdown(text, 'text/plain') : [{ runs: [{ text, marks: [] }], attributes: null }];
      }
      for (const block of blocks) for (const run of block.runs) {
        const diagnostic = inputTextDiagnostic(run.text);
        if (diagnostic) { this.#diagnose(diagnostic); this.#recoverSource('text/plain', run.text, diagnostic); throw Error(diagnostic); }
      }
      return blocks;
  }
  /** Explicit deferred preparation; target and clipboard values are captured once.
   * schedule is an optional host scheduler, never a provider/network transport. */
  pasteDeferred(data: Pick<ClipboardData,'getData'>, options: {literal?:boolean; schedule?:()=>Promise<void>} = {}): PendingPaste {
    this.pendingPaste?.cancel();
    const source=this.#captureData(data,true);
    const target=this.#selection.retain(), generation=this.#generation;
    let opening: {node: string; parent: string; version: unknown}[];
    try { opening=target?this.#targetContext(target,this.#engine.read()):[]; }
    catch (error) { target?.dispose(); throw error; }
    const job=new PendingPaste(this.#renderer.root.ownerDocument,source,async job=>{
      await (options.schedule?.()??new Promise<void>(resolve=>setTimeout(resolve,0)));
      if(!job.active||generation!==this.#generation||this.#disposed||this.#blocked()||!target?.active) return rejected('clipboard-canceled');
      // One fresh projection after the asynchronous gap; never reuse opening
      // state for current target admission or clipboard preparation.
      const snapshot=this.#engine.read();
      this.#revalidateTarget(target,opening,snapshot);
      const start=performance.now(), blocks=this.#prepareData(target,{getData:m=>source[m]??''},options,snapshot);job.timings.preparationMs=performance.now()-start;
      if(!job.active||generation!==this.#generation||this.#disposed||this.#blocked()||!target.active||!job.beginApply()) return rejected('clipboard-canceled');
      const current=this.#selection.retain(), applying=performance.now();
      try {return this.last=this.#apply(target,blocks);}
      finally {job.timings.applyMs=performance.now()-applying;if(current){this.#restore(current);current.dispose();}}
    },()=>target?.dispose());
    this.pendingPaste=job;
    void job.result.then(outcome=>{this.last=outcome;if(outcome.disposition!=='committed')for(const [mime,raw]of Object.entries(source))this.#recoverSource(mime,raw,outcome.reason??'clipboard-rejected');});
    return job;
  }
  #targetContext(target: RetainedSelection, snapshot: Snapshot) {
    return [target.range.anchor, target.range.focus].map(anchor => {
      const at = this.#engine.resolve(anchor);
      if (at.type !== 'position') throw Error('clipboard-target');
      const node = snapshot.visible.find(node => node.id === at.node);
      if (!node) throw Error('clipboard-target');
      return {node: at.node, parent: node.parent, version: node.editor?.version};
    });
  }
  #revalidateTarget(target: RetainedSelection, opening: readonly {node: string; parent: string; version: unknown}[], snapshot: Snapshot): void {
    const current = this.#targetContext(target, snapshot);
    if (current.some((node, i) => node.node !== opening[i]?.node || node.parent !== opening[i]?.parent || node.version !== opening[i]?.version)) throw Error('clipboard-target-changed');
  }
  #recoverSource(mime: string, raw: string, reason: string): void {
    if (!this.recovery.some(r => r.mime === mime && r.raw === raw)) {
      this.recovery.push({ mime, raw, reason }); if (this.recovery.length > 4) this.recovery.shift();
    }
  }
  #literal(raw: string): string {
    if (exceedsLimit(raw)) throw Error('clipboard-limit');
    const diagnostic = inputTextDiagnostic(raw);
    if (diagnostic) { this.#diagnose(diagnostic); this.#recoverSource('text/plain', raw, diagnostic); throw Error(diagnostic); }
    return literalLineEndings(raw);
  }
  #markdown(raw: string, mime: string): readonly FragmentBlock[] {
    const diagnostic = inputTextDiagnostic(raw);
    if (diagnostic) { this.#diagnose(diagnostic); this.#recoverSource(mime, raw, diagnostic); throw Error(diagnostic); }
    const prepared = this.#engine.importMarkdown(raw, this.contentCodecs);
    for (const diagnostic of prepared.diagnostics) this.#diagnose(diagnostic.code);
    if (prepared.diagnostics.length) {
      this.recovery.push({ mime, raw: prepared.source, reason: prepared.diagnostics.map(d => d.code).join(',') });
      if (this.recovery.length > 4) this.recovery.shift();
    }
    return prepared.blocks;
  }
  /** Explicit activated plain-paste command. Stable target is captured before
   * permission/OS work; late results cannot follow navigation or a new session. */
  async pastePlainText(read: () => Promise<string>, captured?: RetainedSelection): Promise<ClipboardOutcome> {
    if (this.#disposed || this.#blocked()) { captured?.dispose(); return this.last = rejected('clipboard-unavailable'); }
    const target = captured ?? this.#selection.retain(), generation = this.#generation;
    if (!target) return this.last = rejected('clipboard-selection');
    let cancel!: () => void;
    const cancellation = new Promise<never>((_, reject) => { cancel = () => reject(Error('clipboard-canceled')); });
    this.#reads.add(cancel);
    let source: string | undefined;
    try {
      const opening = this.#targetContext(target, this.#engine.read());
      const raw = await Promise.race([Promise.resolve().then(() => {
        if (generation !== this.#generation || this.#disposed) throw Error('clipboard-canceled'); return read();
      }), cancellation]);
      source = raw;
      if (generation !== this.#generation || this.#disposed || this.#blocked() || !target.active) throw Error('clipboard-canceled');
      this.#revalidateTarget(target, opening, this.#engine.read());
      const text = this.#literal(raw);
      if (!text) return this.last = rejected('clipboard-empty');
      // Preserve a user's later selection for an asynchronous result.
      const current = this.#selection.retain();
      try { return this.last = this.#apply(target, [{ runs: [{ text, marks: [] }], attributes: null }]); }
      finally { if (current) { this.#restore(current); current.dispose(); } }
    } catch (error) {
      const reason = errorMessage(error);
      if (source !== undefined && !exceedsLimit(source)) this.#recoverSource('text/plain', source, reason);
      return this.last = rejected(reason);
    }
    finally { this.#reads.delete(cancel); target.dispose(); }
  }
  #restore(target: RetainedSelection): void { this.#selection.restoreRetained(target); }
  cancel(): void { this.pendingPaste?.cancel(); this.#generation++; for (const cancel of this.#reads) cancel(); this.#reads.clear(); this.finish(); this.#literalNext = false; }
  copy(data: ClipboardData, cut = false): ClipboardOutcome {
    if (this.#disposed || (cut && this.#blocked())) return this.last = rejected('clipboard-unavailable');
    const target = this.#selection.retain(); if (!target) return this.last = rejected('clipboard-selection');
    try {
      const a = this.#engine.resolve(target.range.anchor), b = this.#engine.resolve(target.range.focus);
      if (a.type !== 'position' || b.type !== 'position') throw Error('clipboard-target');
      const snapshot = this.#engine.read(), nodes = snapshot.visible.filter(n => n.kind === 'block');
      const ai = nodes.findIndex(n => n.id === a.node), bi = nodes.findIndex(n => n.id === b.node);
      if (ai < 0 || bi < 0) throw Error('clipboard-target');
      const [first, last, from, to] = (ai < bi || ai === bi && a.offset <= b.offset) ? [ai, bi, a.offset, b.offset] : [bi, ai, b.offset, a.offset];
      if (first === last && from === to) return this.last = { disposition: 'handled' };
      const selected = nodes.slice(first, last + 1);
      const inert = selected.some(n => Array.isArray(n.blockAttributes) && n.blockAttributes[0] === 'module:editac.inert-extension');
      const clipped = selected.map((node, index) => ({ node, start: index === 0 ? from : 0, end: index === selected.length - 1 ? to : node.runs.reduce((n, r) => n + r.text.length, 0) }));
      const plain = clipped.map(({node, start, end}) => node.runs.map(run => run.text).join('').slice(start, end)).join('\n');
      const oversized = exceedsLimit(plain);
      // Copy can export the already admitted document as plain text. Import
      // and structured-fragment bounds still apply; an oversized cut cannot
      // promise a restorable fragment and must leave the document untouched.
      if (cut && oversized) throw Error('clipboard-limit');
      data.setData('text/plain', plain);
      if (cut && data.getData('text/plain') !== plain) throw Error('clipboard-write-failed');
      if (!oversized) try {
        const fragment: Fragment = { version: 1, schema: snapshot.identity.schema,
          blocks: clipped.map(({node, start, end}) => {
            const containers: NonNullable<FragmentBlock['containers']>[number][] = [];
            let parent = node.parent;
            while (parent !== '@root') {
              if (containers.length >= 16) throw Error('fragment-container-limit');
              const container = snapshot.visible.find(n => n.id === parent), tuple = container?.editor?.containerAttributes;
              if (!container || !Array.isArray(tuple)) throw Error('unsupported-fragment-container');
              let style: NonNullable<FragmentBlock['containers']>[number]['style'];
              if (tuple[0] === 'ordered' && typeof tuple[1] === 'number') style = { type: 'ordered', start: tuple[1] };
              else if (tuple[0] === 'unordered' || tuple[0] === 'checklist' || tuple[0] === 'quote') style = { type: tuple[0] };
              else throw Error('unsupported-fragment-container');
              containers.unshift({ key: container.id, style }); parent = container.parent;
            }
            const attributes = blockStyle(node);
            if (attributes?.type === 'content' && (start !== 0 || end !== node.runs.reduce((n,r)=>n+r.text.length,0))) throw Error('partial-atomic-fragment');
            return { runs: clipRuns(node, start, end), attributes, containers, checked: node.editor?.checked ?? null };
          }) };
        const raw = JSON.stringify(fragment); decodeFragment(raw, this.#engine); data.setData(FRAGMENT_MIME, raw);
        if (inert) this.#diagnose('inert-extension-source-fallback');
        if (fragment.blocks.some(b => b.runs.some(r => r.opaqueMarks?.length))) this.#diagnose('opaque-marks-internal-only');
        if (cut && data.getData(FRAGMENT_MIME) !== raw) throw Error('clipboard-write-failed');
        data.setData('text/html', exportHTML(fragment.blocks));
      } catch (error) { this.#diagnose(errorMessage(error)); if (cut) throw error; }
      // Never delete until both the interoperable text and lossless internal
      // flavors were written; rejected encoding must preserve the source.
      return this.last = cut ? this.#apply(target, [{ runs: [], attributes: null }]) : { disposition: 'handled' };
    } catch (error) { return this.last = rejected(errorMessage(error)); }
    finally { target.dispose(); }
  }
  handle(event: Event): boolean {
    if (event.type === 'keydown') {
      this.finish();
      const key = event as KeyboardEvent;
      const mac = /Mac|iPhone|iPad/.test(this.#renderer.root.ownerDocument.defaultView?.navigator.platform ?? '');
      const primary = mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey;
      this.#literalNext = !key.defaultPrevented && !key.isComposing && (mac || !key.altKey) && !key.getModifierState('AltGraph') && key.key.toLowerCase() === 'v' && key.shiftKey && primary;
      return false;
    }
    if (event.type === 'blur') this.#literalNext = false;
    const input = event as InputEvent;
    const type = input.inputType;
    const drop = event.type === 'drop';
    if (drop || event.type === 'copy' || event.type === 'cut' || event.type === 'paste') {
      // A nested owner or earlier listener has already disposed this drop.
      if (drop && event.defaultPrevented) return true;
      this.finish();
      if (drop && !event.cancelable) {
        this.last = rejected('drop-not-cancelable');
        this.#pending = { type: 'drop', phase: 'beforeinput', nodes: this.#renderer.textBlockIds() };
        for (const node of this.#pending.nodes) this.#renderer.hold(node);
        return true;
      }
      const data = drop ? (event as DragEvent).dataTransfer : (event as ClipboardEvent).clipboardData;
      if (event.cancelable) event.preventDefault();
      if (!data) { this.last = rejected('clipboard-data-unavailable'); return true; }
      this.last = drop || event.type === 'paste' ? this.paste(data, { literal: !drop && this.#literalNext }) : this.copy(data, event.type === 'cut');
      if (!drop) this.#literalNext = false;
      if (event.type !== 'copy') this.#pending = { type: drop ? 'drop' : event.type === 'cut' ? 'cut' : 'paste', phase: 'event', nodes: this.#renderer.textBlockIds() };
      return true;
    }
    if (event.type === 'beforeinput' && (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation' || type === 'insertFromDrop' || type === 'deleteByCut')) {
      if (event.cancelable) event.preventDefault();
      if (this.#pending?.phase === 'event' && ((type === 'insertFromDrop') === (this.#pending.type === 'drop'))) { this.#pending.phase = 'beforeinput'; return true; }
      this.finish();
      if (type === 'insertFromDrop') { this.last=rejected('drop-event-required'); return true; }
      if (type === 'deleteByCut') { this.last = rejected('clipboard-write-required'); return true; }
      const data = input.dataTransfer;
      const text = data?.getData('text/plain') || input.data;
      if (event.cancelable) {
        this.last = this.paste(data ?? { getData: flavor => flavor === 'text/plain' ? text ?? '' : '' }, { literal: this.#literalNext });
        this.#literalNext = false;
        this.#pending = { type: 'paste', phase: 'beforeinput', nodes: this.#renderer.textBlockIds() };
      } else {
        const target = this.#selection.retain();
        if (target && text && !this.#blocked() && !exceedsLimit(text)) {
          const nodes = this.#renderer.textBlockIds();
          this.#pending = { type: 'paste', phase: 'beforeinput', target, text, nodes };
          for (const node of nodes) this.#renderer.hold(node);
        } else { target?.dispose(); this.last = rejected('clipboard-data-unavailable'); }
      }
      return true;
    }
    if (event.type === 'input' && this.#pending) {
      const pending = this.#pending;
      if (pending.target && pending.text) this.last = this.#apply(pending.target, [{ runs: [{ text: pending.text, marks: [] }], attributes: null }]);
      this.finish(); return true;
    }
    if (this.#pending && !['selectionchange', 'keyup'].includes(event.type)) this.finish();
    return false;
  }
  finish(): void {
    const pending = this.#pending; if (!pending) return;
    // Keep ownership during renderer repair/observer draining to prevent echoes.
    pending.target?.dispose();
    for (const node of pending.nodes) this.#renderer.resume(node);
    // Repair replaces text nodes even for a canceled native echo. Reapply the
    // stable caret before another paste intent can capture a DOM boundary.
    this.#selection.restore();
    this.#pending = undefined;
  }
  dispose(): void { if (this.#disposed) return; this.cancel(); this.#disposed = true; }
}
