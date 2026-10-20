export const check = (condition, message) => { if (!condition) throw Error(message); };
export const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
export function selectText(element, offset, end = offset) {
  element.closest('[contenteditable=true]')?.focus();
  const point = at => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (at <= node.length) return [node, at];
      at -= node.length;
    }
    check(at === 0, 'Invalid selection offset'); return [element, element.childNodes.length];
  };
  const a = point(offset), b = point(end); document.getSelection().setBaseAndExtent(...a, ...b);
}
export function domFixture(root, fixture) {
  let list;
  for (const block of fixture.blocks) {
    if (block.type !== 'list') list = undefined;
    const element = document.createElement(block.type === 'heading' ? 'h2' : block.type === 'code' ? 'pre' : block.type === 'list' ? 'li' : 'p');
    element.textContent = block.text;
    if (block.type === 'list') { if (!list) { list = document.createElement('ul'); root.append(list); } list.append(element); }
    else root.append(element);
  }
}
export const blockElements = root => [...root.querySelectorAll('p,h2,pre,li')].filter(e => !e.querySelector('p,h2,pre,li'));
