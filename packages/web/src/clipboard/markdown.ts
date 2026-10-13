import type { EngineHandle, PreparedMarkdown } from '@edit-ac/core';

/** The portable parser prepares inert data. The caller commits exactly once. */
export function importMarkdown(engine: EngineHandle, source: string, codecs: import('@edit-ac/core').MarkdownOptions = {}): PreparedMarkdown {
  return engine.importMarkdown(source, codecs);
}
