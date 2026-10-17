// Literal simple-cell transfer. Quoting keeps tabs/quotes inside their cells;
// CR/LF inside cells remain outside the owning engine's simple-cell profile.
const MAX_BYTES = 1048576;
const MAX_CELLS = 128;
function bounded(text: string): void {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw Error('Clipboard limit');
}
function validate(matrix: string[][]): string[][] {
  const columns = matrix[0]?.length ?? 0;
  if (!columns || columns > 32 || matrix.length * columns > MAX_CELLS ||
      matrix.some(row => row.length !== columns || row.some(cell => /[\r\n]/u.test(cell)))) throw Error('Simple rectangle required');
  bounded(matrix.flat().join(''));
  return matrix;
}
export function encodeTableClipboard(doc: Document, cells: string[][]): Record<string, string> {
  validate(cells);
  const text = cells.map(row => row.map(cell => /[\t"]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join('\t')).join('\n');
  const table = doc.createElement('table');
  for (const row of cells) { const tr = table.insertRow(); for (const cell of row) tr.insertCell().textContent = cell; }
  const html = table.outerHTML;
  bounded(text); bounded(html);
  return { 'text/tab-separated-values': text, 'text/plain': text, 'text/html': html };
}
function decodeTsv(text: string): string[][] {
  bounded(text);
  const rows: string[][] = [[]];
  let cell = '', quoted = false, closed = false, count = 0;
  const push = () => {
    if (++count > MAX_CELLS) throw Error('Clipboard limit');
    rows[rows.length - 1]!.push(cell); cell = ''; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === '\t' || char === '\n' || (char === '\r' && text[i + 1] === '\n')) {
      push(); if (char !== '\t') { rows.push([]); if (char === '\r') i++; }
    } else {
      if (closed) throw Error('Invalid quoted field');
      if (char === '"' && !cell) quoted = true;
      else cell += char;
    }
  }
  if (quoted) throw Error('Unclosed field');
  push(); return validate(rows);
}
function decodeHtml(doc: Document, html: string): string[][] {
  bounded(html);
  const template = doc.createElement('template'); template.innerHTML = html;
  const significant = [...template.content.childNodes].filter(n => n.nodeType !== 3 || n.textContent!.trim());
  const table = template.content.querySelector('table');
  if (!table || significant.length !== 1 || significant[0] !== table) throw Error('One literal table required');
  for (const element of [table, ...table.querySelectorAll('*')]) {
    const tag = element.tagName, parent = element.parentElement?.tagName;
    if (!(element === table || (['TBODY', 'THEAD', 'TFOOT'].includes(tag) && parent === 'TABLE') ||
      (tag === 'TR' && ['TABLE', 'TBODY', 'THEAD', 'TFOOT'].includes(parent ?? '')) ||
      (['TD', 'TH'].includes(tag) && parent === 'TR'))) throw Error('Unsupported markup');
    if ([...element.attributes].some(a => !(['TD', 'TH'].includes(tag) && ['rowspan', 'colspan'].includes(a.name) && a.value === '1'))) throw Error('Unsupported attributes');
    if (!['TD', 'TH'].includes(tag) && [...element.childNodes].some(n => n.nodeType !== 1 && (n.nodeType !== 3 || n.textContent!.trim()))) throw Error('Discarded content');
  }
  return validate([...table.rows].map(row => [...row.cells].map(cell => cell.textContent ?? '')));
}
export function decodeTableClipboard(doc: Document, data: DataTransfer, literal = false): string[][] {
  // The explicit literal action ignores richer offers and cannot turn tabs
  // into a rectangle. Embedded breaks remain outside the admitted cell profile.
  if (literal) return validate([[data.getData('text/plain')]]);
  const html = data.getData('text/html');
  // Validate all offered HTML even when TSV is preferred: no fallback may hide
  // unsupported merges, nesting or rich markup by flattening them.
  const htmlCells = html ? decodeHtml(doc, html) : undefined;
  if (data.types.includes('text/tab-separated-values')) return decodeTsv(data.getData('text/tab-separated-values'));
  if (htmlCells) return htmlCells;
  if (!data.types.includes('text/plain')) throw Error('Literal clipboard required');
  return decodeTsv(data.getData('text/plain'));
}

/** Versioned, inert run matrix. Engine admission remains authoritative. */
export const TABLE_RICH_MIME = 'application/x-edit-ac-table-cells+json';
export type TableRun = [string, [string, ...string[]][]];
export interface TableCellBlock { style: [string, ...(string | number)[]]; runs: TableRun[] }
export interface TableRichCell { paragraphs: TableCellBlock[]; rowSpan: 1; columnSpan: 1; header: boolean }
export type RichCellMatrix = TableRun[][][] | TableRichCell[][];
function richMatrix(value: unknown, version = 1, maxCells = MAX_CELLS): RichCellMatrix {
  if (!Array.isArray(value) || !value.length || value.length > maxCells) throw Error('Invalid rich rectangle');
  const width = Array.isArray(value[0]) ? value[0].length : 0;
  if (!width || width > 32 || width * value.length > maxCells) throw Error('Rich rectangle limit');
  let count = 0, blocks = 0;
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== width) throw Error('Invalid rich row');
    for (const cell of row) {
      let lists: unknown[];
      if (version === 2) {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell) || Object.keys(cell).sort().join(',') !== 'columnSpan,header,paragraphs,rowSpan' || cell.rowSpan !== 1 || cell.columnSpan !== 1 || typeof cell.header !== 'boolean' || !Array.isArray(cell.paragraphs) || !cell.paragraphs.length) throw Error('Unsupported rich cell');
        lists = cell.paragraphs.map((block: any) => {
          if (++blocks > 1024 || !block || typeof block !== 'object' || Array.isArray(block) || Object.keys(block).sort().join(',') !== 'runs,style' || !Array.isArray(block.style) || !Array.isArray(block.runs)) throw Error('Invalid cell block');
          const a = block.style;
          if (!(a.length === 1 && a[0] === 'paragraph') && !(a.length === 2 && a[0] === 'heading' && Number.isInteger(a[1]) && a[1] >= 1 && a[1] <= 6) && !(a.length === 2 && a[0] === 'code' && typeof a[1] === 'string' && /^[a-zA-Z0-9+._-]{0,64}$/.test(a[1]))) throw Error('Unsupported cell style');
          return block.runs;
        });
      } else {
        if (!Array.isArray(cell)) throw Error('Invalid rich cell');
        lists = [cell];
      }
      for (const list of lists) for (const run of list as any[]) {
        if (++count > 1024 || !Array.isArray(run) || run.length !== 2 || typeof run[0] !== 'string' || /[\r\n]/u.test(run[0]) || !Array.isArray(run[1]) || run[1].length > 6) throw Error('Invalid rich run');
        const seen = new Set();
        for (const mark of run[1]) {
          if (!Array.isArray(mark) || !['bold','italic','underline','strike','code','link'].includes(mark[0]) || seen.has(mark[0])) throw Error('Invalid rich mark');
          seen.add(mark[0]);
          if (mark[0] === 'link') { if (mark.length !== 2 || typeof mark[1] !== 'string') throw Error('Invalid rich link'); }
          else if (mark.length !== 1) throw Error('Invalid rich mark value');
        }
        if (seen.has('code') && seen.size > 1) throw Error('Code excludes rich marks');
      }
    }
  }
  bounded(JSON.stringify(value));
  return value as RichCellMatrix;
}
export function validateRichTableCells(value: unknown, maxCells = MAX_CELLS): TableRichCell[][] { return richMatrix(value, 2, maxCells) as TableRichCell[][]; }
export function encodeRichTableClipboard(doc: Document, cells: RichCellMatrix): Record<string, string> {
  const version = Array.isArray(cells[0]?.[0]) ? 1 : 2;
  richMatrix(cells, version);
  const rich = JSON.stringify({ version, cells }); bounded(rich);
  const literal = cells.map(row => row.map(cell => Array.isArray(cell) ? cell.map(run => run[0]).join('') : cell.paragraphs.map(block => block.runs.map(run => run[0]).join('')).join('\n')));
  // Literal table profile has no embedded newlines. Keep the structured flavor
  // alone for multi-block cells rather than flattening their block boundaries.
  return { ...(literal.some(row => row.some(text => /[\r\n]/u.test(text))) ? {} : encodeTableClipboard(doc, literal)), [TABLE_RICH_MIME]: rich };
}
export function decodeRichTableClipboard(data: DataTransfer): RichCellMatrix | undefined {
  if (!data.types.includes(TABLE_RICH_MIME)) return;
  const raw = data.getData(TABLE_RICH_MIME); bounded(raw);
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'cells,version' || ![1,2].includes(value.version)) throw Error('Unsupported rich cells');
  return richMatrix(value.cells, value.version);
}
