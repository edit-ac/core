import { LinkActivation } from '@edit-ac/core';
import type { LinkRequest, LinkState } from '@edit-ac/core';
export { LinkActivation } from '@edit-ac/core';
export type { LinkActivationOptions, ValidatedLinkAction } from '@edit-ac/core';

/** Bind explicit native click/keyboard-generated click actions. Resolve the
 * stored mark/reference at the event, rather than a preview's displayed URL.
 * Return undefined for unrelated events, null for a matched but stale target.
 * Matching events suppress browser default navigation even when denied. */
export function bindLinkActivation(root: EventTarget, controller: LinkActivation,
  request: (event: Event) => Readonly<LinkRequest> | null | undefined,
  result: (state: LinkState) => void = () => {}): { dispose(): void } {
  const clicked = (event: Event): void => {
    try {
      const target = request(event);
      if (target === undefined) return;
      event.preventDefault();
      result(target === null ? 'stale' : controller.perform({ kind: 'activate', request: target }));
    } catch { event.preventDefault(); result('unavailable'); }
  };
  root.addEventListener('click', clicked, { capture: true });
  return { dispose() { root.removeEventListener('click', clicked, { capture: true }); } };
}
