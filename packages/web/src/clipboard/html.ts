import type { ContainerStyle, FragmentBlock, FragmentRun } from '@edit-ac/core';

/** Parse into an inert template and construct portable data from a whitelist.
 * No imported node, style, handler, script or resource enters the live document. */
export function importHTML(document: Document, raw: string, diagnose: (code: string) => void = () => {}): readonly FragmentBlock[] {
  if (new TextEncoder().encode(raw).length > 1024 * 1024) throw Error('html-limit');
  const warnings = new Set<string>();
  const warn = (code: string) => { if (!warnings.has(code)) { warnings.add(code); diagnose(code); } };
  const allowed = new Set(['p','div','span','li','ul','ol','blockquote','h1','h2','h3','h4','h5','h6','pre','br','b','strong','i','em','s','del','strike','u','code','a']);
  const url = (href: string): string | undefined => {
    if (href.length > 4096 || /[\x00-\x20\x7f\\]/.test(href) || /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(href)) return;
    try { const value = new URL(href); if (!['http:', 'https:', 'mailto:'].includes(value.protocol) || value.username || value.password) return; return href; } catch { return; }
  };
  const template = document.createElement('template'); template.innerHTML = raw;
  const blocks: FragmentBlock[] = [];
  let visits = 0, sequence = 0, bytes = 0, runs = 0;
  const walk = (node: Node, marks: FragmentRun['marks'], path: NonNullable<FragmentBlock['containers']>, depth: number,
    block: { runs: FragmentRun[]; attributes: FragmentBlock['attributes']; containers: NonNullable<FragmentBlock['containers']> }): void => {
    if (++visits > 4096 || depth > 32 || blocks.length > 128) throw Error('html-limit');
    if (node.nodeType === 3) { const text = node.textContent ?? ''; bytes += new TextEncoder().encode(text).length; if (bytes > 1024 * 1024 || ++runs > 1024) throw Error('html-limit'); if (text) block.runs.push({ text, marks }); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const element = node.nodeType === 1 ? node as HTMLElement : null;
    const tag = element?.tagName.toLowerCase() ?? '';
    if (element) for (const attr of element.attributes) {
      if (attr.value.length > 4096) throw Error('html-attribute-limit');
      if (!['href','start','style'].includes(attr.name)) warn('html-attribute-dropped');
    }
    if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'template'].includes(tag)) { warn('html-executable-dropped'); return; }
    if (tag && !allowed.has(tag)) warn('html-element-dropped');
    if (['table', 'img', 'video', 'audio', 'canvas', 'math', 'svg'].includes(tag)) throw Error(`html-${tag}-requires-extension-codec`);
    if (tag === 'br') { block.runs.push({ text: '\n', marks }); return; }
    let nextMarks = [...marks];
    const add = (mark: FragmentRun['marks'][number]['mark'], href?: string) => {
      nextMarks = nextMarks.filter(m => m.mark !== mark);
      nextMarks.push(href ? { mark, href } : { mark });
    };
    if (['b', 'strong'].includes(tag)) add('bold');
    if (['i', 'em'].includes(tag)) add('italic');
    if (['s', 'del', 'strike'].includes(tag)) add('strike');
    if (tag === 'u') add('underline');
    if (tag === 'code' && block.attributes?.type !== 'code') add('code');
    if (tag === 'a') {
      const href = element?.getAttribute('href');
      if (href) { const safe = url(href); if (safe) add('link', safe); else warn('html-url-dropped'); }
    }
    const css = element?.getAttribute('style') ?? '';
    if (css) warn('html-css-reduced-to-marks');
    if (/font-weight\s*:\s*(bold|[7-9]00)\b/i.test(css)) add('bold');
    if (/font-style\s*:\s*italic\b/i.test(css)) add('italic');
    if (/text-decoration[^:]*\s*:[^;]*\bunderline\b/i.test(css)) add('underline');
    if (/text-decoration[^:]*\s*:[^;]*\bline-through\b/i.test(css)) add('strike');
    if (['ul', 'ol', 'blockquote'].includes(tag)) {
      if (block.runs.length) { blocks.push({ ...block }); block.runs = []; }
      const style: ContainerStyle = tag === 'blockquote' ? { type: 'quote' } : tag === 'ol'
        ? { type: 'ordered', start: Math.max(1, Math.min(2147483647, Number(element?.getAttribute('start')) || 1)) } : { type: 'unordered' };
      const next = [...path, { key: `html-${++sequence}`, style }];
      const nested = { runs: [] as FragmentRun[], attributes: { type: 'paragraph' } as const, containers: next };
      for (const child of node.childNodes) walk(child, nextMarks, next, depth + 1, nested);
      if (nested.runs.length) blocks.push(nested);
      return;
    }
    if (/^(p|div|li|h[1-6]|pre)$/.test(tag)) {
      if (block.runs.length) { blocks.push({ ...block }); block.runs = []; }
      const attributes: FragmentBlock['attributes'] = /^h[1-6]$/.test(tag) ? { type: 'heading', level: Number(tag[1]) }
        : tag === 'pre' ? { type: 'code', language: '' } : { type: 'paragraph' };
      const next = { runs: [] as FragmentRun[], attributes, containers: path };
      for (const child of node.childNodes) walk(child, nextMarks, path, depth + 1, next);
      if (next.runs.length || !node.childNodes.length) blocks.push(next);
      return;
    }
    for (const child of node.childNodes) walk(child, nextMarks, path, depth + 1, block);
  };
  const root = { runs: [] as FragmentRun[], attributes: { type: 'paragraph' } as const, containers: [] };
  walk(template.content, [], [], 0, root);
  if (root.runs.length) blocks.push(root);
  if (!blocks.length) throw Error('html-empty');
  return blocks;
}
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function exportHTML(blocks: readonly FragmentBlock[]): string {
  const body = (block: FragmentBlock): string => {
    const content = block.runs.map(run => {
      let text = escape(run.text).replaceAll('\n', '<br>');
      for (const mark of run.marks) {
        if (mark.mark === 'link') text = `<a href="${escape(mark.href ?? '')}">${text}</a>`;
        else { const tag = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code' }[mark.mark]; text = `<${tag}>${text}</${tag}>`; }
      }
      return text;
    }).join('');
    const tag = block.attributes?.type === 'heading' ? `h${block.attributes.level}` : block.attributes?.type === 'code' ? 'pre' : 'p';
    return `<${tag}>${content}</${tag}>`;
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
