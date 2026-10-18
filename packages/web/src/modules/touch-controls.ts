/** Presenter-local layout only. Native scrolling, selection and pinch zoom keep
 * their browser defaults; the owning EditorViewport positions visible panels. */
export function touchTarget(element: HTMLElement, row = false): void {
  element.style.minWidth = '44px';
  element.style.minHeight = '44px';
  element.style.boxSizing = 'border-box';
  if (row) {
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.whiteSpace = 'normal';
    element.style.overflowWrap = 'anywhere';
  }
}

export function touchPanel(element: HTMLElement): void {
  element.style.boxSizing = 'border-box';
  element.style.maxWidth = '100%';
  element.style.maxHeight = '40vh';
  element.style.overflowY = 'auto';
}
