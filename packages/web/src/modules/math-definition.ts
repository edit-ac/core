import type { Json } from '@edit-ac/core';
import type { ModuleDefinition } from './registry.js';

const prefix = 'LaTeX source: ';
/** Existing portable inline-atom envelope; invalid LaTeX is retained as source. */
export const mathModuleDefinition: ModuleDefinition = Object.freeze({
  type: 'editac.math', version: 1, kind: 'inline-atom',
  attributes: Object.freeze({ latex: Object.freeze({ type: 'string', required: true, maxUtf16: 4096 }), display: Object.freeze({ type: 'boolean', required: true }) }),
  content: Object.freeze({ type: 'text', maxUtf16: 4110 }),
  fallback: Object.freeze({ type: 'text', source: 'content' }),
});
export function mathAtom(latex: string, display = false): { text: string; attributes: Record<string, Json> } {
  if (typeof latex !== 'string' || latex.length > 4096 || typeof display !== 'boolean' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(latex)) throw Error('Invalid bounded math source');
  return { text: prefix + latex, attributes: { 'module:editac.math': [1, { latex, display }] } };
}
