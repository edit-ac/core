export { mountEditor, BrowserEditor, CommandChain } from './editor.js';
export type { EditorOptions, DestroyResult, AttachSyncOptions, SyncAttachment } from './editor.js';
export { createEditor, taskPreset } from './sdk.js';
export type { TaskPresetOptions } from './sdk.js';
export { CheckpointStorage } from './storage/checkpoint.js';
export { mountEditorSurface } from './surface.js';
export type { EditorSurface, EditorSurfaceOptions } from './surface.js';
export type { EditorState, PreviewTag } from './lifecycle.js';
export type { ClipboardOutcome, ClipboardCodec } from './clipboard/fragment.js';
export type { PendingPaste } from './clipboard/pending.js';
export { ModuleRegistry, ModuleContractError } from './modules/registry.js';
export type { ModuleDefinition, ModulePresentation } from './modules/registry.js';

export { ModuleRuntime } from './modules/runtime.js';
export type { ModuleEvent, ModuleScope, ModuleRuntimeOptions, ModuleRuntimeError, ModuleViewContent, ModuleView, ModuleRenderer } from './modules/runtime.js';

export { slashCommands, SlashPresenter } from './modules/slash.js';
export type { SlashAction, SlashCommand, SlashContext, SlashFactory } from './modules/slash.js';

export { referenceSuggestions, referenceBlock, ReferencePresenter, ReferenceLookupSession, privateReferenceDisplay, PrivateReferenceView } from './modules/references.js';
export type { ReferenceTarget, ReferenceQuery, ReferenceResolver, ReferenceFactory, ReferencePermissionV1, ReferenceCatalogResultV1, ReferenceHostV1 } from './modules/references.js';

export { reorderControls, ReorderPresenter } from './modules/reorder.js';
export type { ReorderContext, ReorderFactory } from './modules/reorder.js';

export { contentModules } from './modules/content.js';
export type { ContentFactory, ContentView, ContentContext, ImageMetadata, ContentOptions } from './modules/content.js';

export type { MarkdownAdapter, TypingShortcutAdapter } from './input/shortcuts.js';

export { ChangeReview } from './review/view.js';
export { prepareReview, exportChangeModel, importChangeModel, DEFAULT_REVIEW_LIMITS } from './review/model.js';
export type { ChangeReviewOptions, ReviewSelection } from './review/view.js';
export type { ReviewInput, ReviewLayout, ReviewMode, ReviewLimits, ReviewModel, PortableChangeModel } from './review/model.js';
export { WebHistoryStore, HistoryRestorer, HistoryReview } from './review/history.js';
export type { HistoryScope, RevisionProvenance, HistoricalRevision, HistoryRead, HistoryAccess, HistoryLimits, HistoryHost, RestoreResult, RestorePreview, HistoryReviewOptions } from './review/history.js';

export { linkEnrichment } from './modules/links/enrichment.js';
export type { LinkEnrichmentOptions, LinkEnrichmentFactory } from './modules/links/enrichment.js';

export type { PrivateReferenceDisplayOptions } from './modules/references/display.js';
