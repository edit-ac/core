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
export { referenceSuggestions, referenceBlock, ReferencePresenter, ReferenceLookupSession } from './references.js';
export type { ReferenceTarget, ReferenceQuery, ReferenceResolver, ReferenceFactory, ReferencePermissionV1, ReferenceCatalogResultV1, ReferenceHostV1, ReferenceLookupOptions } from './references.js';
export { reorderControls, ReorderPresenter } from './reorder.js';
export type { ReorderContext, ReorderFactory } from './reorder.js';
export { contentModules } from './content.js';
export type { ContentFactory, ContentView, ContentContext, ImageMetadata, ContentOptions } from './content.js';
// Heavy math renderer remains separately opt-in through @edit-ac/web/math.
export { canonicalSemanticJson, runDescriptorFixture, projectExtensionNodes } from './conformance.js';
export type { DescriptorFixture, DescriptorResult } from './conformance.js';

export { prepareModuleMigration, ModuleEvolutionError } from '@edit-ac/core/extensions';
export type { ModuleEvolution, PreparedModuleMigration } from '@edit-ac/core/extensions';
export { prepareExtensionSource } from './conformance.js';
export { ExtensionCommandSession } from './conformance.js';
export type { ExtensionCommandHost, ExtensionCommandResult } from './conformance.js';
export { PRESENTER_API_VERSION, PRESENTER_HOSTS, PRESENTER_CAPABILITIES, validatePresenterAdapters, ExtensionPresenterSession } from './presenters.js';
export type { PresenterHost, PresenterCapabilitiesV1, PresenterInputV1, PresenterUpdateV1, PresenterFocusV1, PresenterInputEventV1, PresenterAccessibilityV1, PresenterRepresentationV1, PresenterAdapterV1 } from './presenters.js';
export { EXTENSION_TRANSFER_VERSION, EXTENSION_TRANSFER_MIME, ExtensionTransferRegistry, ExtensionTransferError, exportExtensionTransfer, importExtensionTransfer, extensionTransferRequest } from '@edit-ac/core/extensions';
export type { ExtensionTransferDescriptor, ExtensionTransferEnvelope, ExtensionTransferCodec, PreparedExtensionTransfer, TransferMark } from '@edit-ac/core/extensions';

export { ServiceLifecycle, serviceScopeFailure } from '../services/lifecycle.js';
export type { ServiceScope, ServiceResult, ServiceFailure, ServiceLimits, ServiceRequest, ServiceClock } from '../services/lifecycle.js';
