import type {MarkdownAdapter} from '@edit-ac/web';
import type {EngineHandle, PrepareRequest, CommitResult, MarkdownCodec} from '@edit-ac/core';
import {TypingShortcuts} from './shortcuts.js';
/** Already initialized, explicit opt-in; never fetches from a typing event. */
export function markdownExtension(codec: MarkdownCodec): MarkdownAdapter {
  return Object.freeze({codec, createShortcuts: (engine: EngineHandle, commit: (request: PrepareRequest) => CommitResult) => new TypingShortcuts(engine, commit)});
}
