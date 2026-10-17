import type { ModuleRenderer, ModuleViewContent } from './runtime.js';

import { mathAtom } from './math-definition.js';
export { mathAtom, mathModuleDefinition } from './math-definition.js';
function source(content: ModuleViewContent): { latex: string; display: boolean } {
  const { latex, display } = content.attributes;
  if (content.type !== 'editac.math' || content.version !== 1 || content.kind !== 'inline-atom' ||
      typeof latex !== 'string' || typeof display !== 'boolean' || Object.keys(content.attributes).sort().join(',') !== 'display,latex' || content.text !== mathAtom(latex, display).text) throw Error('Invalid math atom');
  return { latex, display };
}
function safeInput(latex: string): boolean {
  // No user-defined/external macros or trusted HTML/URL commands in this bounded
  // example. Unknown commands still fail closed in KaTeX, never in the document.
  if (/\\(?:href|url|includegraphics|html\w*|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|csname|input|include|require)\b/iu.test(latex)) return false;
  let depth = 0;
  for (let i = 0; i < latex.length; i++) {
    if (latex[i] === '\\') { i++; continue; }
    if (latex[i] === '{' && ++depth > 64) return false;
    if (latex[i] === '}') depth--;
  }
  return true;
}
/** Optional renderer: mount triggers one local lazy import; disposal/updates
 * invalidate pending results. Source is adapter-owned and always remains visible. */
export function mathRenderer(): ModuleRenderer {
  let loaded: Promise<typeof import('./math-renderer.js')> | undefined;
  return { mount(element, initial) {
    const document = element.ownerDocument;
    const preview = document.createElement('span'); preview.dataset.mathPreview = '';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    element.dataset.mathModule = ''; element.append(preview, status);
    let generation = 0, disposed = false;
    function update(content: ModuleViewContent): void {
      const value = source(content), request = ++generation;
      preview.replaceChildren(); status.textContent = 'LaTeX source; math loading. '; element.dataset.mathState = 'loading';
      function fallback(): void { if (!disposed && request === generation) { preview.replaceChildren(); status.textContent = 'LaTeX source; math unavailable. '; element.dataset.mathState = 'source'; } }
      if (!safeInput(value.latex)) { fallback(); return; }
      loaded ??= import('./math-renderer.js');
      void loaded.then(renderer => {
        if (disposed || request !== generation) return;
        try {
          const math = renderer.renderMath(value.latex, value.display, document);
          preview.replaceChildren(math); status.textContent = 'LaTeX source with browser math preview. '; element.dataset.mathState = 'rendered';
        } catch { fallback(); }
      }, () => { loaded = undefined; fallback(); });
    }
    try { update(initial); } catch (error) { element.replaceChildren(); throw error; }
    return { update, dispose() { if (disposed) return; disposed = true; generation++; element.replaceChildren(); } };
  } };
}
