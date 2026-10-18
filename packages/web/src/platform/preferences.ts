import type { PlatformObservationV1, PlatformPreferencesV1 } from '../extensions/contract.js';

/** Per-surface requests, never a claim about effective browser/OS preferences. */
export class PlatformPreferenceController {
  readonly #original = new Map<string, string | null>();
  readonly #written = new Map<string, string>();
  readonly observation: PlatformObservationV1;
  #disposed = false;
  constructor(readonly root: HTMLElement, policy: PlatformPreferencesV1 = {}) {
    this.observation = Object.freeze({ requested: Object.freeze({ ...policy }), observed: 'unknown' });
    // Platform mode deliberately leaves explicit and inherited spelling alone.
    if ((policy.spellcheck === 'off' || policy.spellcheck === 'custom')) this.#set('spellcheck', 'false');
    if (policy.autocorrection && policy.autocorrection !== 'inherit') this.#set('autocorrect', policy.autocorrection);
    if (policy.locale !== undefined) this.#set('lang', policy.locale);
  }
  #set(name: string, value: string): void {
    this.#original.set(name, this.root.getAttribute(name));
    this.root.setAttribute(name, value); this.#written.set(name, value);
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    for (const [name, value] of this.#original) if (this.root.getAttribute(name) === this.#written.get(name)) {
      if (value === null) this.root.removeAttribute(name); else this.root.setAttribute(name, value);
    }
  }
}
