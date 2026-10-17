import { inputTextDiagnostic } from '../input/characters.js';
import type { EngineHandle, FragmentBlock, HTMLNode } from '@edit-ac/core';
import { inlineTags } from '../dom/marks.js';

/** Inert HTML5 tokenization only. Rust owns the whitelist and semantic mapping. */
export function importHTML(document: Document, raw: string, engine: EngineHandle, diagnose: (code: string) => void): readonly FragmentBlock[] {
  if (new TextEncoder().encode(raw).length > 1048576) throw Error('html-limit');
  // HTML parsing replaces NUL/unpaired surrogates; reject before tokenization.
  const diagnostic = inputTextDiagnostic(raw);
  if (diagnostic) throw Error(diagnostic);
  const template = document.createElement('template'); template.innerHTML = raw;
  let visits = 0;
  const tokenize = (node: Node, depth: number): HTMLNode => {
    if (++visits > 4096 || depth > 32) throw Error('html-limit');
    if (node.nodeType === 3) return { kind: 'text', text: node.textContent ?? '' };
    if (node.nodeType !== 1) return { kind: 'inert' };
    const element = node as Element;
    return { kind: 'element', tag: element.localName, attributes: Array.from(element.attributes, a => {
      if (a.value.length > 4096) throw Error('html-attribute-limit');
      return { name: a.localName, value: a.value, namespaced: a.namespaceURI !== null };
    }), children: Array.from(node.childNodes, c => tokenize(c, depth + 1)) };
  };
  const imported = engine.importHTML(Array.from(template.content.childNodes, n => tokenize(n, 1)));
  for (const code of imported.diagnostics) diagnose(code);
  return imported.blocks;
}

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function exportHTML(blocks: readonly FragmentBlock[]): string {
  const body = (block: FragmentBlock): string => {
    const content = block.runs.map(run => {
      let text = escape(run.text).replaceAll('\n', '<br>');
      for (const mark of run.marks) {
        if (mark.mark === 'link') text = `<a href="${escape(mark.href ?? '')}">${text}</a>`;
        else { const tag = inlineTags[mark.mark]; text = `<${tag}>${text}</${tag}>`; }
      }
      return text;
    }).join('');
    const tag = block.attributes?.type === 'heading' ? `h${block.attributes.level}` : block.attributes?.type === 'code' ? 'pre' : 'p';
    return `<${tag} style="white-space:${tag === 'pre' ? 'pre' : 'break-spaces'}">${content}</${tag}>`;
  };
  type Piece = { html: string; container: boolean };
  const children = (selected: readonly FragmentBlock[], depth: number): Piece[] => {
    const result: Piece[] = [];
    for (let first = 0; first < selected.length;) {
      const block = selected[first]!, container = block.containers?.[depth];
      if (!container) { result.push({ html: body(block), container: false }); first++; continue; }
      let end = first + 1;
      while (end < selected.length && selected[end]?.containers?.[depth]?.key === container.key) end++;
      const nested = children(selected.slice(first, end), depth + 1), style = container.style;
      let html: string;
      if (style.type === 'quote') html = `<blockquote>${nested.map(p => p.html).join('')}</blockquote>`;
      else {
        const items: string[] = [];
        for (const piece of nested) {
          if (piece.container && items.length) items[items.length - 1] += piece.html;
          else items.push(piece.html);
        }
        const tag = style.type === 'ordered' ? 'ol' : 'ul', start = style.type === 'ordered' ? ` start="${style.start}"` : '';
        html = `<${tag}${start}>${items.map(item => `<li>${item}</li>`).join('')}</${tag}>`;
      }
      result.push({ html, container: true }); first = end;
    }
    return result;
  };
  return children(blocks, 0).map(p => p.html).join('');
}
