import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateSuite, validateRecipe } from '../../../architecture/scripts/validate-editing-suite.mjs';

export interface Position { block: string; offset: number }
export interface Selection { anchor: Position; focus: Position; affinity: 'forward' | 'backward' }
export interface State {
  blocks: { id: string; kind: 'paragraph' | 'code' | 'separator'; text: string; hardBreaks: number[]; marks: { from: number; to: number; type: string }[] }[];
  selection: Selection; pendingMarks: null | string[];
}
export interface Action {
  type: string; text?: string; newBlockId?: string; selection?: Selection; clockMs?: number;
  [key: string]: unknown;
}
export interface Expected { outcome: string; state: State; effects: { localCommits: number; remoteCommits: number } }
export interface Recipe {
  schemaVersion: 1; id: string; layer: string; covers: string[]; requires: string[];
  context: { document: string; editor: string; epoch: number }; initial: State;
  steps: { id: string; action: Action; expect: Expected }[];
}
export const architectureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../architecture');
export const groups = Object.freeze({
  fixtures: ['SEQ-01', 'SEQ-02'],
  semantic: ['SEQ-01', 'SEQ-02', 'SEQ-03', 'SEQ-04', 'SEQ-05', 'SEQ-06', 'SEQ-07', 'SEQ-11', 'SEQ-12', 'SEQ-13', 'SEQ-14'],
  history: ['SEQ-03', 'SEQ-08'], input: ['SEQ-10'], failures: ['SEQ-09'],
});
export type Group = keyof typeof groups;
export function groupIds(group: string): readonly string[] {
  if (!Object.hasOwn(groups, group)) throw new Error(`Unknown/unimplemented editing group: ${group}`);
  return groups[group as Group];
}
export function assertRecipe(recipe: Recipe, catalogIds: Set<string>): void {
  const errors = validateRecipe(recipe, { catalogIds });
  if (errors.length) throw new Error(errors.join('\n'));
}
export interface CatalogRow {
  id: string; path: string; owners: string[]; heading: string; variantRequirement: string;
  declaredPlatforms: string[]; declaredProfileConstraints: string[];
  variants: { id: string; requirement: string; status: 'planned' }[]; status: 'planned';
}
export function loadSuite(root = architectureRoot) {
  const report = validateSuite({ root });
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  const hashes: Record<string, string> = {};
  const read = (path: string) => {
    const bytes = readFileSync(resolve(root, path));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    return bytes.toString('utf8');
  };
  const manifest = JSON.parse(read('tests/editing-suite/suite.json'));
  const catalogs: CatalogRow[] = [];
  const variantPolicies: Record<string, string[]> = {};
  for (const catalog of manifest.catalogs) {
    let heading = ''; let owners: string[] = [];
    const source = read(catalog.path);
    variantPolicies[catalog.path] = source.split(/\r?\n/).filter((line: string) => /^(Risk dimensions:|Each row binds|Common oracle:|Full Cartesian)/.test(line));
    for (const line of source.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line)) { heading = line; owners = line.match(/\b[A-Z][A-Z0-9]*-\d+\.\d+\b/g) ?? []; }
      const id = line.match(/^\|\s*([A-Z][A-Z0-9]*-[A-Z]?\d{2,})\s*\|/)?.[1];
      if (id) {
        const cells = line.split('|').slice(1, -1).map((cell: string) => cell.trim());
        const setup = cells[2];
        const declaredPlatforms = [...new Set(line.match(/\b(Android|Apple|AppKit|Linux|Windows|iOS|macOS|Safari)\b/g) ?? [])];
        const declaredProfileConstraints = [...new Set(line.match(/[^.;|]*(?:profile|preset|baseline|backend|configuration)[^.;|]*/gi) ?? [])].map(s => s.trim());
        // Enumerate source-authored semicolon clauses only. These requirements
        // are metadata; they neither invent a Cartesian matrix nor claim execution.
        const variants = setup.split(';').map((requirement: string, i: number) => ({ id: `${id}:source-${i + 1}`, requirement: requirement.trim(), status: 'planned' as const }));
        catalogs.push({ id, path: catalog.path, owners: [...owners], heading, variantRequirement: line, declaredPlatforms, declaredProfileConstraints, variants, status: 'planned' });
      }
    }
  }
  const catalogIds = new Set(catalogs.map(row => row.id));
  const recipes: Recipe[] = manifest.recipes.map((path: string) => JSON.parse(read(path)));
  for (const recipe of recipes) assertRecipe(recipe, catalogIds);
  return { manifest, catalogs, variantPolicies, catalogIds, recipes, hashes, binding: 'corpus-only' as const };
}
export function capabilityBinding(recipe: Recipe, capabilities: ReadonlySet<string>, supportedActions: ReadonlySet<string>) {
  const missing = recipe.requires.filter(cap => !capabilities.has(cap));
  const actions = [...new Set(recipe.steps.map(step => step.action.type))].filter(action => !supportedActions.has(action));
  return { id: recipe.id, status: missing.length || actions.length ? 'unsupported' : 'implemented-unexecuted', missingCapabilities: missing, missingActions: actions };
}
