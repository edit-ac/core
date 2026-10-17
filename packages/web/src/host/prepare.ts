import type { HostAgentAccess } from './contract.js';
import { createHostMarkdown, HostMarkdownError, markdownChecksum } from './markdown.js';
import type { HostMarkdownLimits, HostMarkdownOwner } from './markdown.js';

/** Presentation from editac-diff; neither model is an executable edit. */
export interface HostChangeModel {
  version: 'editac-change-model-v1';
  input: Readonly<Record<string, unknown>>;
}
export type HostPrepareResult = {
  status: 'prepared'; proposalId: string; expectedRevision: string;
  sourceHash: string; candidateHash: string; profile: string;
  preview: unknown; sourceDiff: HostChangeModel; semanticDiff: HostChangeModel;
  affectedIds: readonly string[];
} | {
  status: 'conflict'; code: string; target: string | null;
  recovery: { base: string; proposed: string; current: unknown; currentRevision: string };
} | { status: 'rejected'; code: string };

/** The embedding host owns current authorization, serialized Session access and
 * opaque proposals. prepare MUST recheck actor/document/epoch, permission,
 * readonly, capability, revision and anchors at execution, retain the actual
 * immutable PreparedEdit, and derive both previews using editac-diff. A preview
 * or proposal ID grants no authority to apply. No apply service is installed.
 */
export interface HostPrepareOwner<Target> extends HostMarkdownOwner<Target, HostPrepareResult> {
  prepare(target: Target, candidate: string, access: Readonly<HostAgentAccess>): Promise<HostPrepareResult>;
}

/** Complete-candidate preparation shares the upload/baseline admission path.
 * Results are detached from owner state and bounded before returning to MCP.
 * The owner retains/releases plans under its own bounded expiry policy.
 */
export function createHostPrepare<Target>(owner: HostPrepareOwner<Target>, options: {
  limits?: Partial<HostMarkdownLimits>; now?: () => number; maxResultBytes?: number;
} = {}) {
  const max = options.maxResultBytes ?? 1048576;
  if (!Number.isSafeInteger(max) || max <= 0 || max > 1048576) throw new HostMarkdownError('limit');
  type Captured = { target: Target; source: string; revision: string; profile: string };
  const invalid = (): never => { throw new HostMarkdownError('invalid'); };
  return createHostMarkdown<Captured, HostPrepareResult>({
    available: a => owner.available(a),
    async capture(a) {
      const value = await owner.capture(a);
      return { ...value, target: { target: value.target, source: value.source,
        revision: value.revision, profile: value.profile } };
    },
    release: b => owner.release(b.target),
    async prepare(b, candidate, a) {
      // Hashing may yield: availability and the real owner admission follow it.
      const sourceHash = await markdownChecksum(b.source), candidateHash = await markdownChecksum(candidate);
      if (!owner.available(a)) throw new HostMarkdownError('unavailable');
      const result = await owner.prepare(b.target, candidate, a);
      // Revocation during the owner call must also withhold protected previews.
      if (!owner.available(a)) throw new HostMarkdownError('unavailable');
      const encoded = JSON.stringify(result);
      if (typeof encoded !== 'string') return invalid();
      if (new TextEncoder().encode(encoded).length > max) throw new HostMarkdownError('limit');
      const value = JSON.parse(encoded) as HostPrepareResult;
      if (!value || typeof value !== 'object') return invalid();
      if (value.status === 'prepared') {
        if (typeof value.proposalId !== 'string' || !value.proposalId || value.proposalId.length > 512
          || value.expectedRevision !== b.revision || value.profile !== b.profile
          || value.sourceHash !== sourceHash || value.candidateHash !== candidateHash
          || value.preview === undefined || !Array.isArray(value.affectedIds)
          || value.affectedIds.some(id => typeof id !== 'string' || !id || id.length > 512)
          || value.sourceDiff?.version !== 'editac-change-model-v1'
          || value.sourceDiff.input?.representation !== 'exact-source'
          || typeof value.sourceDiff.input.wire !== 'string'
          || value.semanticDiff?.version !== 'editac-change-model-v1'
          || value.semanticDiff.input?.representation !== 'semantic') return invalid();
      } else if (value.status === 'conflict') {
        if (!value.code || value.recovery?.base !== b.source || value.recovery.proposed !== candidate
          || typeof value.recovery.currentRevision !== 'string' || value.recovery.current === undefined
          || !(value.target === null || typeof value.target === 'string')) return invalid();
      } else if (value.status !== 'rejected' || typeof value.code !== 'string' || !value.code) return invalid();
      return value;
    },
  }, options);
}
