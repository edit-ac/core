// A host toolbar consuming the same production capture port as pointer controls.
// It has no text model, command implementation or optional assistance extension.
export function accessibilityHost(root, surface, engine) {
  const toolbar = document.createElement('div');
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-controls', root.id); toolbar.setAttribute('aria-label', 'Text formatting');
  toolbar.dataset.editacUi = '';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  status.id = 'format-status';
  let target;
  const buttons = ['bold', 'italic', 'code'].map(mark => {
    const button = document.createElement('button'); button.type = 'button'; button.tabIndex = 0;
    button.textContent = mark[0].toUpperCase() + mark.slice(1); button.dataset.mark = mark;
    button.addEventListener('click', () => {
      const result = target?.format(mark);
      status.textContent = result?.disposition === 'rejected' ? result.reason : `${button.textContent} applied`;
      refresh();
    });
    toolbar.append(button); return button;
  });
  const refresh = () => {
    for (const button of buttons) {
      const state = target?.state(button.dataset.mark) ?? 'disabled';
      button.setAttribute('aria-pressed', state === 'mixed' ? 'mixed' : String(state === 'on'));
      button.disabled = state === 'disabled';
    }
  };
  const capture = () => { const next = surface.captureToolbar(); if (next) { target?.dispose(); target = next; } refresh(); };
  const key = event => { if (event.key === 'Tab') capture(); };
  const selection = () => { if (document.activeElement === root) capture(); };
  root.addEventListener('keydown', key, true);
  root.addEventListener('pointerup', capture);
  root.addEventListener('focusout', capture);
  document.addEventListener('selectionchange', selection);
  toolbar.addEventListener('keydown', event => { if (event.key === 'Escape') { root.focus(); event.preventDefault(); } });
  const observer = new MutationObserver(refresh); observer.observe(root, {attributes: true, attributeFilter:['aria-readonly']});
  const subscription = engine.subscribe({type:'all'}, refresh);
  root.after(toolbar, status);
  const after = document.createElement('button'); after.id = 'after-editor'; after.textContent = 'Next control'; document.body.append(after);
  capture();
  return () => {
    target?.dispose(); subscription.dispose(); observer.disconnect();
    root.removeEventListener('keydown', key, true); root.removeEventListener('pointerup', capture); root.removeEventListener('focusout', capture);
    document.removeEventListener('selectionchange', selection); toolbar.remove(); status.remove(); after.remove();
  };
}
