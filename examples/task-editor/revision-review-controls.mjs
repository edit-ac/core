// Focus belongs to this consumer. The public presenters still own their native
// controls, pagination, semantic rendering and restore admission.
export function reviewControls(root, prefix, current, listen, dismissComparison) {
  const element = id => root.querySelector(`#${prefix}${id}`);
  const history = element('revision-history');
  const comparison = element('revision-comparison');
  const detailClose = element('revision-close-detail');
  const compareClose = element('revision-close-compare');
  const cancel = element('revision-cancel-restore');
  let active = true, handle, detailInvoker, compareInvoker;
  const buttons = host => [...host.querySelectorAll('button')];
  const button = (host, text) => buttons(host).find(node => node.textContent === text);
  const focusRegion = region => { if (region) { region.tabIndex = -1; region.focus(); } };
  const inspectButton = () => {
    if (detailInvoker instanceof HTMLElement) return detailInvoker.isConnected ? detailInvoker : undefined;
    const index = current().store.list(current().access()).findIndex(item => item.handle === handle);
    return buttons(history).filter(node => node.textContent.startsWith('Inspect '))[index];
  };
  function inspectAgain() {
    if (handle && current().store.read(handle, current().access()).kind === 'available') {
      current().review.inspect(handle); return true;
    }
    handle = undefined; detailClose.hidden = true; return false;
  }
  function openDetail(selected, invoker) {
    handle = selected; detailInvoker = invoker;
    detailClose.hidden = false; cancel.disabled = true;
    focusRegion(history.querySelector('[aria-label="Readonly historical inspection"]'));
  }
  listen(history, 'click', event => {
    if (!active) return;
    const target = event.target.closest('button');
    if (!target) return;
    const label = target.textContent;
    if (label.startsWith('Inspect ')) {
      // The bounded list is rendered in store order by the public presenter.
      const index = buttons(history).filter(node => node.textContent.startsWith('Inspect ')).indexOf(target);
      openDetail(current().store.list(current().access())[index]?.handle, label);
    } else if (label === 'Preview restore as new edit') {
      cancel.disabled = !button(history, 'Apply restore as new edit');
      focusRegion(history.querySelector('[aria-label="Restore as new edit"]'));
    } else if (label === 'Apply restore as new edit') {
      restoreClosed();
    } else {
      // Presenters replace pagination controls; retain the keyboard's position.
      const replacement = button(history, label);
      if (replacement && !replacement.disabled) replacement.focus();
    }
  });
  listen(detailClose, 'click', () => {
    current().restorer.retire();
    current().resetReview();
    detailClose.hidden = true; cancel.disabled = true;
    const invoker = inspectButton(); handle = undefined;
    (invoker ?? element('revision-capture')).focus();
  });
  listen(compareClose, 'click', () => {
    dismissComparison(); compareClose.hidden = true;
    (compareInvoker?.isConnected ? compareInvoker : element('revision-compare')).focus();
  });
  listen(comparison, 'click', event => {
    const label = event.target.closest('button')?.textContent;
    if (!active || !label) return;
    const replacement = button(comparison, label);
    if (replacement && !replacement.disabled) replacement.focus();
  });
  function restoreClosed(returnFocus = true) {
    cancel.disabled = true;
    if (inspectAgain() && returnFocus) {
      (button(history, 'Preview restore as new edit') ?? inspectButton() ?? detailClose).focus();
    } else if (returnFocus) element('revision-capture').focus();
  }
  return {
    captured(selected) { openDetail(selected, element('revision-capture')); },
    openComparison() {
      compareInvoker = element('revision-compare'); compareClose.hidden = false;
      focusRegion(comparison.querySelector('section') ?? comparison.firstElementChild);
    },
    restoreClosed,
    dispose() { active = false; handle = undefined; detailClose.hidden = true; compareClose.hidden = true; cancel.disabled = true; },
  };
}
