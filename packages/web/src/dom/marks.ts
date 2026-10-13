import type { MarkCommand } from '@edit-ac/core';

/** Shared semantic mark names and safe presentation tags; no document state. */
export const inlineTags = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code' } as const;
export const inlineMarks = Object.keys(inlineTags) as (keyof typeof inlineTags)[];
export const htmlMarks: Readonly<Record<string, MarkCommand['mark']>> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', s: 'strike', del: 'strike', strike: 'strike', u: 'underline', code: 'code'
};
