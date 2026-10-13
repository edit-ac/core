import { readFile } from 'node:fs/promises';

export async function requireTestNode() {
  const expected = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim();
  if (process.versions.node !== expected) throw Error(`Expected Node ${expected}; found ${process.versions.node}. Select .node-version with your version manager (for example: nvm use) before running editor checks.`);
}
