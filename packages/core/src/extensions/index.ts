/** Version of the public API contract, independent of each descriptor's data version. */
export const EXTENSION_API_VERSION = 1 as const;
export { ModuleRegistry, ModuleContractError } from './registry.js';
export type { ModuleDefinition, ModulePresentation } from './registry.js';
export type { ModuleDefinition as ModuleDefinitionV1 } from './registry.js';
// Aliases preserve the qualified engine and codec boundary; no parallel commands.
export type {
  EditorCommand as ExtensionCommandV1, PrepareRequest, CommitResult,
  EngineHandle, StableRange, FragmentBlock, FragmentRun,
  MarkdownCodec as MarkdownCodecV1, MarkdownExtension as MarkdownExtensionV1,
  MarkdownOptions, PreparedMarkdown, MarkdownExport, PatchSubscription,
} from '../engine.js';
