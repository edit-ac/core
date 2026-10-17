import type { DOMRenderer } from './render.js';
import type { DOMSelection, ModelPoint } from './selection.js';

/** Native hit testing must resolve inside this editor, never a later caret. */
export function dropPoint(renderer: DOMRenderer, selection: DOMSelection, e: Pick<DragEvent, 'clientX' | 'clientY'>): ModelPoint | undefined {
    const doc=renderer.root.ownerDocument as Document & {caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
    const target=doc.elementFromPoint(e.clientX,e.clientY);
    if(!target||!renderer.root.contains(target)||target.closest('input,textarea,select,button,[data-content-module]'))return;
    const p=doc.caretPositionFromPoint?.(e.clientX,e.clientY),r=!p?doc.caretRangeFromPoint?.(e.clientX,e.clientY):undefined;
    return p?selection.toModel(p.offsetNode,p.offset):r?selection.toModel(r.startContainer,r.startOffset):undefined;
}
