/** Leave an editor, including its nested controls, in document focus order. */
export function leaveEditor(root: HTMLElement, backward: boolean): boolean {
  const doc = root.ownerDocument;
  const candidates = [...doc.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]')]
    .filter(el => el.tabIndex >= 0 && !el.closest('[inert]') && !el.matches(':disabled') && el.getClientRects().length > 0 && doc.defaultView?.getComputedStyle(el).visibility !== 'hidden');
  // Positive tabindex participates before ordinary document order.
  candidates.sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
  const inside = candidates.map((el, i) => root === el || root.contains(el) ? i : -1).filter(i => i >= 0);
  if (!inside.length) return false;
  const index = backward ? Math.min(...inside) - 1 : Math.max(...inside) + 1;
  const next = candidates[index];
  if (!next) {
    // Start native sequential navigation at the editor boundary so browser chrome
    // remains reachable even when the page has no other controls.
    const edge = doc.createElement('span'); edge.tabIndex = -1;
    if (backward) root.before(edge); else root.after(edge);
    edge.focus(); doc.defaultView?.setTimeout(() => edge.remove(), 0);
    return false;
  }
  next.focus();
  return doc.activeElement === next;
}
