export const fixtureVersion = 1;
export const fixtureSizes = Object.freeze({ small: 5000, medium: 50000, large: 500000, 'large-structured': 500000, Task: 10240, Long: 1048576 });
const sentence = 'Planning notes: preserve selection, undo history, and offline edits. café 😀 日本語. ';

/** Exact UTF-16 text sizes, without random data or network fixtures. */
export function fixture(name) {
  if (name === 'Task' || name === 'Long') return supportedFixture(name);
  const size = fixtureSizes[name];
  if (!size) throw Error(`Unknown fixture: ${name}`);
  const structured = name === 'large-structured';
  const width = structured ? 2000 : name === 'large' ? 5000 : 1000;
  const blocks = [];
  for (let offset = 0, index = 0; offset < size; offset += width, index++) {
    const length = Math.min(width, size - offset);
    const text = sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
    const attributes = index % 13 === 1 ? { type: 'heading', level: 2 }
      : index % 13 === 2 ? { type: 'code', language: 'text' } : { type: 'paragraph' };
    const block = { runs: [{ text, marks: [] }], attributes };
    if (index % 13 >= 3 && index % 13 <= 6) {
      block.containers = [{ key: `list-${Math.floor(index / 13)}`, style: { type: 'unordered' } }];
      if (structured && index % 13 >= 5) block.containers.push({ key: `nested-${Math.floor(index / 13)}`, style: { type: 'unordered' } });
    }
    blocks.push(block);
  }
  return { version: fixtureVersion, name, chars: size, blocks };
}

export function fixtureText(document) {
  return document.blocks.map(block => block.runs.map(run => run.text).join('')).join('');
}

// Seeds and exact UTF-8 text allocations are part of the committed corpus.
export const supportedFixtures = Object.freeze({
  Task: { seed: 0x5441534b, blocks: 20, textBytes: 10 * 1024 },
  Long: { seed: 0x4c4f4e47, blocks: 2000, textBytes: 1024 * 1024 },
});
const encoder = new TextEncoder();
const vocabulary = ['planning', 'selection', 'undo', 'offline', 'café', '😀', '日本語', 'é', 'שלום', '👩‍💻'];
function supportedFixture(name) {
  const spec = supportedFixtures[name];
  let state = spec.seed;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const blocks = Array.from({ length: spec.blocks }, (_, index) => {
    const bytes = Math.floor(spec.textBytes / spec.blocks) + (index < spec.textBytes % spec.blocks ? 1 : 0);
    let text = '', used = 0;
    while (used < bytes) {
      const token = vocabulary[next() % vocabulary.length] + ' ';
      const length = encoder.encode(token).length;
      if (used + length > bytes) { text += '.'.repeat(bytes - used); break; }
      text += token; used += length;
    }
    const attributes = index % 13 === 1 ? { type: 'heading', level: 2 }
      : index % 13 === 2 ? { type: 'code', language: 'text' } : { type: 'paragraph' };
    const block = { runs: [{ text, marks: [] }], attributes };
    if (index % 13 >= 3 && index % 13 <= 6) block.containers = [{ key: `list-${Math.floor(index / 13)}`, style: { type: 'unordered' } }];
    return block;
  });
  return { version: fixtureVersion, generator: 'seeded-utf8-v1', name, seed: spec.seed,
    chars: blocks.reduce((sum, block) => sum + block.runs[0].text.length, 0), textBytes: spec.textBytes, blocks };
}

// Expected state comes from generator inputs, never from an engine readback.
export function expectedSemantics(document) {
  const groups = new Map();
  return document.blocks.map(block => {
    const container = block.containers?.[0];
    if (container && !groups.has(container.key)) groups.set(container.key, groups.size);
    const attributes = block.attributes;
    return { text: block.runs.map(run => run.text).join(''), runs: block.runs.map(run => ({ text: run.text, attributes: {} })),
      attributes: attributes.type === 'heading' ? ['heading', attributes.level] : attributes.type === 'code' ? ['code', attributes.language] : ['paragraph'],
      container: container ? { group: groups.get(container.key), style: [container.style.type] } : null };
  });
}

export function projectedSemantics(snapshot) {
  const groups = new Map(), nodes = new Map(snapshot.visible.map(node => [node.id, node]));
  return snapshot.visible.filter(node => node.kind === 'block').map(node => {
    // Container metadata belongs to the parent container, not the text block.
    const style = nodes.get(node.parent)?.editor?.containerAttributes;
    if (style && !groups.has(node.parent)) groups.set(node.parent, groups.size);
    return { text: node.runs.map(run => run.text).join(''), runs: node.runs.map(run => ({ text: run.text, attributes: run.attributes })), attributes: node.blockAttributes ?? ['paragraph'],
      container: style ? { group: groups.get(node.parent), style } : null };
  });
}

// Keep supported corpus bytes fixed while editing at the aggregate text bound.
// All supported sizes use the same replay; growth beyond the bound is separate.
export function overwriteTarget(text, position) {
  const requested = position === 'start' ? 0 : position === 'end' ? text.length - 1 : Math.floor(text.length / 2);
  for (let distance = 0; distance < text.length; distance++) {
    for (const at of [requested + distance, requested - distance]) {
      if (at >= 0 && at < text.length && /[A-Za-z]/.test(text[at])) return { at, original: text[at] };
    }
  }
  throw Error('Overwrite replay requires an existing ASCII letter');
}
