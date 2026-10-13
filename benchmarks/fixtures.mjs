export const fixtureVersion = 1;
export const fixtureSizes = Object.freeze({ small: 5000, medium: 50000, large: 500000, 'large-structured': 500000 });
const sentence = 'Planning notes: preserve selection, undo history, and offline edits. café 😀 日本語. ';

/** Exact UTF-16 text sizes, without random data or network fixtures. */
export function fixture(name) {
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
