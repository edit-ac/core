import type {EngineHandle, PrepareRequest, CommitResult, StableRange, MarkdownCodec} from '@edit-ac/core';
export interface TypingShortcutAdapter {
  enabled: boolean;
  key(key: string): void;
  reverse(range: StableRange): {node: string; offset: number} | undefined;
  convert(range: StableRange, text: string, origin: string): CommitResult | undefined;
}
export interface MarkdownAdapter {
  readonly codec: MarkdownCodec;
  createShortcuts(engine: EngineHandle, commit: (request: PrepareRequest) => CommitResult): TypingShortcutAdapter;
}
/** Default input has no syntax rules or parser imports. */
export function literalShortcuts(): TypingShortcutAdapter {
  return {enabled: false, key() {}, reverse() {return undefined;}, convert() {return undefined;}};
}
