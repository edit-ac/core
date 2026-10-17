/** Browser hints describe host intent; they never report keyboard visibility or
 * change committed text/Enter semantics. Updates wait for native composition. */
export interface InputHints {
  profile: 'prose' | 'code' | 'search';
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
}
export class InputHintController {
  #composing = false;
  #pending: InputHints | undefined;
  #disposed = false;
  readonly #original = new Map<string, string | null>();
  readonly #written = new Map<string, string>();
  readonly #start = () => { this.#composing = true; };
  readonly #end = () => { this.#composing = false; if (this.#pending) this.set(this.#pending); };
  constructor(readonly root: HTMLElement) {
    root.addEventListener('compositionstart', this.#start);
    root.addEventListener('compositionend', this.#end); root.addEventListener('blur', this.#end);
  }
  set(hints: InputHints): void {
    if (this.#disposed) return;
    if (!['prose', 'code', 'search'].includes(hints.profile)) throw Error('Unknown input hint profile');
    this.#pending = { ...hints };
    if (this.#composing) return;
    const code = hints.profile === 'code';
    const attrs: Record<string, string> = { inputmode: hints.profile === 'search' ? 'search' : 'text',
      enterkeyhint: hints.enterKeyHint ?? (hints.profile === 'search' ? 'search' : 'enter'),
      autocapitalize: code ? 'off' : 'sentences', spellcheck: String(!code), autocorrect: code ? 'off' : 'on',
      ...(hints.lang !== undefined ? { lang: hints.lang } : {}), ...(hints.dir ? { dir: hints.dir } : {}) };
    for (const [name, value] of Object.entries(attrs)) {
      if (!this.#original.has(name)) this.#original.set(name, this.root.getAttribute(name));
      this.root.setAttribute(name, value); this.#written.set(name, value);
    }
    this.#pending = undefined;
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true; this.#pending = undefined;
    this.root.removeEventListener('compositionstart', this.#start); this.root.removeEventListener('compositionend', this.#end); this.root.removeEventListener('blur', this.#end);
    for (const [name, value] of this.#original) if (this.root.getAttribute(name) === this.#written.get(name)) {
      if (value === null) this.root.removeAttribute(name); else this.root.setAttribute(name, value);
    }
  }
}
