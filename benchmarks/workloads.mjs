import { fixture, fixtureText, projectedSemantics } from './fixtures.mjs';
export const kinds = ['long-line', 'bidi', 'table-selection', 'images'];
export function workload(profile, scale, kind) {
  if (!profile.scales.includes(scale) || !kinds.includes(kind)) throw Error('Unknown workload');
  const limits = profile.limits, document = fixture(scale), paragraph = text => ({ runs: [{ text, marks: [] }], attributes: { type: 'paragraph' } });
  let blocks, dimensions;
  if (kind === 'long-line') {
    const text = fixtureText(document); blocks = [paragraph(text)];
    dimensions = { textBytes: new TextEncoder().encode(text).length, textUnits: text.length, logicalLines: 1 };
  } else if (kind === 'bidi') {
    // Group whole original blocks. Preserve every code point and exact corpus bytes.
    blocks = Array.from({ length: limits.bidiBlocks }, (_, index) => paragraph(document.blocks.slice(Math.floor(index * document.blocks.length / limits.bidiBlocks), Math.floor((index + 1) * document.blocks.length / limits.bidiBlocks)).map(b => b.runs.map(r => r.text).join('')).join('')));
    dimensions = { textBytes: new TextEncoder().encode(blocks.map(b => b.runs[0].text).join('')).length, textUnits: blocks.reduce((sum, b) => sum + b.runs[0].text.length, 0), bidiBlocks: blocks.length };
  } else if (kind === 'table-selection') {
    const rows = Array.from({ length: limits.tableRows[scale] }, (_, r) => Array.from({ length: limits.tableColumns }, (_, c) => [[(`r${r}c${c} שלום abc `).padEnd(limits.cellUnits, '.'), []]]));
    const data = { rows, alignments: Array(limits.tableColumns).fill('left'), source: rows.map(row => '| ' + row.map(cell => cell[0][0]).join(' | ') + ' |').join('\n') };
    const fallback = rows.map(row => row.map(cell => cell[0][0]).join('\t')).join('\n');
    blocks = [{ runs: [{ text: fallback, marks: [] }], attributes: { type: 'content', tuple: ['module:editac.table', 1, data] } }];
    dimensions = { rows: rows.length, columns: limits.tableColumns, cells: rows.length * limits.tableColumns, cellUnits: limits.cellUnits, textUnits: rows.length * limits.tableColumns * limits.cellUnits, sourceBytes: new TextEncoder().encode(data.source).length, fallbackUnits: fallback.length };
  } else {
    blocks = Array.from({ length: limits.images[scale] }, (_, index) => ({ runs: [], attributes: { type: 'content', tuple: ['module:editac.image', 1, { url: `https://assets.invalid/prepared-${index}.png`, alt: `Prepared image ${index} שלום`, title: 'Local deterministic PNG', source: `![Prepared image ${index} שלום](https://assets.invalid/prepared-${index}.png)` }] } }));
    dimensions = { images: blocks.length, width: limits.imageWidth, height: limits.imageHeight, pixels: blocks.length * limits.imageWidth * limits.imageHeight };
  }
  return { version: 1, scale, kind, blocks, dimensions };
}
// Independent input projection, never inferred from a runtime snapshot.
export function expectedWorkload(document) { const projection = document.blocks.map(block => ({ text: block.runs.map(r => r.text).join(''), runs: block.runs.map(r => ({ text: r.text, attributes: {} })), attributes: block.attributes.type === 'content' ? block.attributes.tuple : ['paragraph'], container: null }));
  // Public content insertion keeps empty editable blocks before and after opaque modules.
  const boundary = () => ({text: '', runs: [], attributes: ['paragraph'], container: null});
  return document.kind === 'images' || document.kind === 'table-selection' ? [boundary(), ...projection, boundary()] : projection;
}

// Object-key order is not semantic content. Preserve every value and array order.
export function canonicalWorkload(value) {
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(value));
}

// Yrs joins retain source run seams. Adjacent runs with identical complete mark
// maps are one semantic run; preserve text, mark maps and every distinct boundary.
export function projectedWorkload(snapshot) {
  return projectedSemantics(snapshot).map(node => {
    const runs = [];
    for (const run of node.runs) {
      const previous = runs.at(-1);
      if (previous && canonicalWorkload(previous.attributes) === canonicalWorkload(run.attributes)) previous.text += run.text;
      else runs.push({text: run.text, attributes: run.attributes});
    }
    return {...node, runs};
  });
}
