/** Explicit optional browser integration; portable records share one owner. */
export * from '@edit-ac/core/links';
export { bindLinkActivation } from './activation.js';
export { LinkEnrichment, linkEnrichment } from './enrichment.js';
export type { LinkEnrichmentOptions, LinkEnrichmentFactory } from './enrichment.js';
export { referenceDisplay, PrivateReferenceView, privateReferenceDisplay } from '../references/display.js';
export type { ReferenceDisplayOptions, PrivateReferenceDisplayOptions } from '../references/display.js';
