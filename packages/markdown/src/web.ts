import type {MarkdownAdapter} from '@edit-ac/web';
import type {EngineHandle, PrepareRequest, CommitResult, MarkdownCodec} from '@edit-ac/core';
import {TypingShortcuts} from './shortcuts.js';
/** Dedicated managed entry. Importing the facade does not initialize the codec. */
export async function loadMarkdownAdapter(assetUrl = new URL('./wasm/editac_markdown_wasm_bg.wasm', import.meta.url).href): Promise<MarkdownAdapter> {
  const { initMarkdown } = await import('./index.js');
  return markdownExtension(await initMarkdown(assetUrl));
}
/** Already initialized, explicit opt-in; never fetches from a typing event. */
export function markdownExtension(codec: MarkdownCodec): MarkdownAdapter {
  return Object.freeze({codec, createShortcuts: (engine: EngineHandle, commit: (request: PrepareRequest) => CommitResult) => new TypingShortcuts(engine, commit)});
}
