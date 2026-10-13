/** Public optional extension integration. Importing does not activate a presenter. */
export { EXTENSION_API_VERSION, ModuleRegistry, ModuleContractError } from '@edit-ac/core/extensions';
export type {
  ModuleDefinition, ModuleDefinitionV1, ModulePresentation, ExtensionCommandV1,
  PrepareRequest, CommitResult, EngineHandle, StableRange, FragmentBlock, FragmentRun,
  MarkdownCodecV1, MarkdownExtensionV1, MarkdownOptions, PreparedMarkdown, MarkdownExport,
} from '@edit-ac/core/extensions';
export { ModuleRuntime } from './runtime.js';
export type { ModuleEvent, ModuleScope, ModuleRuntimeOptions, ModuleRuntimeError, ModuleViewContent, ModuleView, ModuleRenderer } from './runtime.js';
export { slashCommands, SlashPresenter } from './slash.js';
export type { SlashAction, SlashCommand, SlashContext, SlashFactory } from './slash.js';
export { referenceSuggestions, referenceBlock, ReferencePresenter } from './references.js';
export type { ReferenceTarget, ReferenceQuery, ReferenceResolver, ReferenceFactory } from './references.js';
export { reorderControls, ReorderPresenter } from './reorder.js';
export type { ReorderContext, ReorderFactory } from './reorder.js';
export { contentModules } from './content.js';
export type { ContentFactory, ContentView, ContentContext, ImageMetadata, ContentOptions } from './content.js';
// Heavy math renderer remains separately opt-in through @edit-ac/web/math.
