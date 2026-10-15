import { safeLink } from '../../dom/links.js';
import type { ReferenceHostV1 } from '../references.js';
import { captureLinkRequest, linkIntentPermission, validLinkAction } from './contract.js';
import type { LinkAction, LinkHostContext, LinkRequest, LinkState, LinkTarget } from './contract.js';

/** Data only: native adapters pass these fields to platform APIs, never a shell. */
export type ValidatedLinkAction =
  | { kind: 'open-external'; locator: string; target: Readonly<LinkTarget> }
  | { kind: 'open-private'; locator: string; target: Readonly<LinkTarget> }
  | { kind: 'copy-locator'; locator: string; target: Readonly<LinkTarget> };
export interface LinkActivationOptions {
  context(): Readonly<LinkHostContext>;
  /** Read the owning node/mark now. Undefined means deleted/disposed. Never read metadata. */
  current(request: Readonly<LinkRequest>): Readonly<LinkRequest> | undefined;
  catalog: Pick<ReferenceHostV1, 'catalog'>;
  /** Configured catalog adapter supplies a credential-free app/ac/HTTPS locator.
   * It must preserve exact identity and never fetch or mint access tokens. */
  privateLocator(target: Readonly<Extract<LinkTarget, { kind: 'private' }>>): string | undefined;
  /** Synchronous dispatch to a host navigation/clipboard API. The host must check
   * actual launch authority again if it queues work beyond this call. */
  dispatch(action: Readonly<ValidatedLinkAction>): LinkState;
}
const secretKey = /(?:^|[_-])(?:token|key|authorization|auth|password|passwd|secret|signature|credential|bearer|code)(?:$|[_-])/iu;
function locator(value: unknown, external: boolean): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(k => secretKey.test(k))) return;
    if (external) return ['http:', 'https:'].includes(url.protocol) && safeLink(value, value) ? value : undefined;
    // Custom schemes are accepted only via the configured catalog port below.
    // Query/fragment payloads cannot smuggle credentials or commands into apps.
    if (['http:', 'https:'].includes(url.protocol)) return safeLink(value, value) ? value : undefined;
    if (!/^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) || ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
      || !url.hostname || url.search || url.hash || url.port) return;
    return value;
  } catch { return; }
}
function sameIdentity(a: Readonly<LinkRequest>, b: Readonly<LinkRequest>): boolean {
  return a.node === b.node && a.epoch === b.epoch && a.requestId === b.requestId && a.cancellationToken === b.cancellationToken
    && a.target.kind === b.target.kind && (a.target.kind === 'public'
      ? b.target.kind === 'public' && a.target.url === b.target.url
      : b.target.kind === 'private' && a.target.targetId === b.target.targetId && a.target.authority === b.target.authority);
}
/** Explicit user-action boundary. Construction/rendering performs no host work.
 * No resolver result, cached title, canonical URL or document write is consumed. */
export class LinkActivation {
  #disposed = false;
  constructor(private readonly options: LinkActivationOptions) {}
  dispose(): void { this.#disposed = true; }
  perform(action: Readonly<Extract<LinkAction, { kind: 'activate' }>>, signal?: AbortSignal): LinkState {
    return this.#run(action, false, signal);
  }
  /** Requires owning request identity as well as the portable copy intent, so
   * revoked private targets cannot disclose a locator through stale copy UI. */
  copy(request: Readonly<LinkRequest>, signal?: AbortSignal): LinkState {
    return this.#run({ kind: 'activate', request }, true, signal);
  }
  #run(action: Readonly<Extract<LinkAction, { kind: 'activate' }>>, copy: boolean, signal?: AbortSignal): LinkState {
    if (this.#disposed || signal?.aborted) return 'canceled';
    if (action?.kind !== 'activate' || !validLinkAction(action)) return 'unsupported';
    try {
      const request = captureLinkRequest(action.request);
      const check = (): LinkState => {
        if (this.#disposed || signal?.aborted) return 'canceled';
        const current = this.options.current(request);
        if (!current || !sameIdentity(request, current)) return 'stale';
        const host = this.options.context();
        // Copy is independent of navigation and document-write capabilities,
        // but retains current principal/tenant/permission/session validation.
        const expected = copy ? { ...request, host: { ...request.host, capabilities: { ...request.host.capabilities, activate: true } } } : request;
        const now = copy ? { ...host, capabilities: { ...host.capabilities, activate: true } } : host;
        const owningHost = copy ? { ...current.host, capabilities: { ...current.host.capabilities, activate: true } } : current.host;
        const owningState = linkIntentPermission(expected, owningHost, 'activate');
        return owningState === 'available' ? linkIntentPermission(expected, now, 'activate') : owningState;
      };
      let state = check(); if (state !== 'available') return state;
      let value: string | undefined;
      if (request.target.kind === 'public') value = locator(request.target.url, true);
      else {
        const entry = this.options.catalog.catalog(request.target.targetId);
        if (!entry || entry.targetId !== request.target.targetId) return 'unsupported';
        switch (entry.status) {
          case 'locked': return 'locked';
          case 'unauthorized': return 'forbidden';
          case 'unavailable': return 'unavailable';
          case 'incompatible': return 'unsupported';
          case 'local': case 'cached': case 'hosted': break;
          default: return 'unsupported';
        }
        value = locator(this.options.privateLocator(request.target), false);
      }
      if (!value) return 'unsupported';
      state = check(); if (state !== 'available') return state;
      const approved: Readonly<ValidatedLinkAction> = Object.freeze({ kind: copy ? 'copy-locator' : request.target.kind === 'public' ? 'open-external' : 'open-private', locator: value, target: request.target });
      const result = this.options.dispatch(approved);
      return ['available', 'unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'].includes(result) ? result : 'unsupported';
    } catch { return 'unavailable'; }
  }
}

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
