/** Existing configured catalog projections, shared with browser reference hosts. */
export interface ReferencePermissionV1 { revision: string; lookup: boolean; insert: boolean }
export interface ReferenceCatalogResultV1 {
  status: 'local' | 'cached' | 'hosted' | 'locked' | 'unavailable' | 'unauthorized' | 'incompatible';
  /** Exact admitted identifier, from the shared catalog, never a source path/token. */
  targetId: string;
}
