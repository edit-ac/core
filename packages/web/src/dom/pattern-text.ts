import type { ProjectedNode } from '@edit-ac/core';

/** Read only a bounded committed projection. Oversized/ambiguous projections fail closed.
 * At most 128 runs are examined; no document read, DOM parsing or second source model. */
export function patternText(node: ProjectedNode, start: number, end: number, exclude = true): string | undefined {
  if (node.kind !== 'block' || node.runs.length > 128 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 4096) return;
  if (Array.isArray(node.blockAttributes) && node.blockAttributes[0] === 'code') return;
  if (node.blockAttributes && typeof node.blockAttributes === 'object' && !Array.isArray(node.blockAttributes) && node.blockAttributes.type === 'code') return;
  let offset = 0, text = '';
  for (const run of node.runs) {
    const next = offset + run.text.length;
    if (offset < end && next > start) {
      if (exclude) {
        if (run.attributes.code || run.attributes.link) return;
        let keys = 0; for (const key in run.attributes) if (++keys > 64 || key.startsWith('module:')) return;
      }
      text += run.text.slice(Math.max(0, start - offset), Math.min(run.text.length, end - offset));
    }
    offset = next;
  }
  return end <= offset ? text : undefined;
}
