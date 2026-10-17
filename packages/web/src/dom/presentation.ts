/** Baseline presentation belongs to the view, including extension-free mounts.
 * Keep rules scoped; host controls and optional assistance retain their styling.
 */
const sheets = new WeakMap<Document, { element: HTMLStyleElement; users: number }>();
export function accessiblePresentation(root: HTMLElement): () => void {
  const doc = root.ownerDocument, previous = root.getAttribute('data-editac-surface');
  let sheet = sheets.get(doc);
  if (!sheet) {
    const element = doc.createElement('style'); element.dataset.editacPresentation = '';
    element.textContent = `
[data-editac-surface] { min-inline-size: 0; overflow-wrap: anywhere; }
[data-editac-surface] pre { max-inline-size: 100%; overflow-x: auto; overflow-wrap: normal; }
[data-editac-ui] { max-inline-size: 100%; overflow-wrap: anywhere; }
[data-editac-ui][role="dialog"] { display: flex; flex-wrap: wrap; gap: .5em; }
[data-editac-ui] input { max-inline-size: 100%; box-sizing: border-box; }
[data-editac-surface]:focus-visible, [data-editac-ui]:focus-visible,
[data-editac-ui] :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
@media (forced-colors: active) {
  [data-editac-surface]:focus-visible, [data-editac-ui]:focus-visible,
  [data-editac-ui] :focus-visible { outline-color: Highlight; }
  [data-editac-ui] [data-active="true"] { border: 2px solid Highlight; }
}
@media (prefers-reduced-motion: reduce) {
  [data-editac-surface], [data-editac-ui], [data-editac-ui] * { scroll-behavior: auto; animation: none; transition: none; }
}`;
    (doc.head ?? doc.documentElement).append(element);
    sheet = { element, users: 0 }; sheets.set(doc, sheet);
  }
  sheet.users++; root.setAttribute('data-editac-surface', '');
  let disposed = false;
  return () => {
    if (disposed) return; disposed = true;
    if (previous === null) root.removeAttribute('data-editac-surface'); else root.setAttribute('data-editac-surface', previous);
    if (--sheet.users === 0) { sheet.element.remove(); sheets.delete(doc); }
  };
}
