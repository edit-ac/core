import { domFixture, selectText, blockElements } from './shared.mjs';
export async function mount(root, fixture) {
  root.contentEditable = 'true'; domFixture(root, fixture);
  return {
    text: () => blockElements(root).map(b => b.textContent).join(''),
    select: (index, offset) => selectText(blockElements(root)[index], offset),
    insert: text => { const s = document.getSelection(), r = s.getRangeAt(0); r.insertNode(document.createTextNode(text)); r.collapse(false); s.removeAllRanges(); s.addRange(r); },
    delete: () => { const s = document.getSelection(); s.modify('extend', 'backward', 'character'); s.deleteFromDocument(); },
    flush: async () => {}, destroy: async () => { root.replaceChildren(); root.contentEditable = 'false'; }
  };
}
