export { mountEditor, BrowserEditor } from './editor.js';
export type { EditorOptions, DestroyResult } from './editor.js';
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

export { referenceSuggestions, referenceBlock, ReferencePresenter } from './modules/references.js';
export type { ReferenceTarget, ReferenceQuery, ReferenceResolver, ReferenceFactory } from './modules/references.js';

export { reorderControls, ReorderPresenter } from './modules/reorder.js';
export type { ReorderContext, ReorderFactory } from './modules/reorder.js';

export { contentModules } from './modules/content.js';
export type { ContentFactory, ContentView, ContentContext, ImageMetadata, ContentOptions } from './modules/content.js';
