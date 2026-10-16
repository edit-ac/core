import type { HostAgentAccess, HostAgentService } from './contract.js';

/** The host retains this opaque target in its shared Session/EditService owner.
 * capture must prove the exact source/owner mapping; prepare must call that
 * owner's prepare_source (never import/replace the live document). Neither mutates.
 */
export interface HostMarkdownOwner<Target> {
  available(access: Readonly<HostAgentAccess>): boolean;
  capture(access: Readonly<HostAgentAccess>): Promise<{
    target: Target; source: string; revision: string; profile: string;
    diagnostics: readonly unknown[];
  }>;
  prepare(target: Target, candidate: string, access: Readonly<HostAgentAccess>): Promise<unknown>;
  /** Release retained owner handles on expiry, eviction, or disposal. */
  release(target: Target): void;
}
export class HostMarkdownError extends Error {
  constructor(public readonly code: 'denied' | 'limit' | 'invalid' | 'expired' | 'mismatch' | 'incomplete' | 'unavailable') {
    super(code); this.name = 'HostMarkdownError';
  }
}
export interface HostMarkdownLimits {
  maxSourceBytes: number; maxCandidateBytes: number; maxChunkBytes: number;
  maxChunks: number; maxBaselines: number; maxUploads: number; ttlMs: number;
}
const defaults: HostMarkdownLimits = {
  maxSourceBytes: 65536, maxCandidateBytes: 65536, maxChunkBytes: 8192,
  maxChunks: 64, maxBaselines: 32, maxUploads: 16, ttlMs: 300000,
};
const fail = (code: HostMarkdownError['code']): never => { throw new HostMarkdownError(code); };
const encoder = new TextEncoder();
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') return fail('invalid');
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) fail('invalid');
  }
  return encoder.encode(value);
}
export async function markdownChecksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes(value));
  return 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export interface MarkdownBase { expectedRevision: string; sourceHash: string }
export interface MarkdownUpload extends MarkdownBase { totalBytes: number; checksum: string }

/** Optional host-side service. Access objects MUST come from current host auth,
 * including for chunk calls; upload IDs and document prose grant no authority.
 * Fixed global counts and byte bounds also cap aggregate retained memory.
 */
export function createHostMarkdown<Target>(owner: HostMarkdownOwner<Target>, options: {
  limits?: Partial<HostMarkdownLimits>; now?: () => number;
} = {}) {
  const limits = Object.freeze({ ...defaults, ...options.limits });
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > defaults[key as keyof HostMarkdownLimits]) fail('limit');
  }
  const now = options.now ?? Date.now;
  const scope = (a: Readonly<HostAgentAccess>) => JSON.stringify([a.actorId, a.documentId, a.epoch]);
  type Baseline = { scope: string; target: Target; source: string; revision: string;
    sourceHash: string; profile: string; diagnostics: readonly unknown[]; expiresAt: number };
  type Upload = { scope: string; baseline: Baseline; totalBytes: number; checksum: string;
    chunks: string[]; size: number; expiresAt: number };
  const baselines: Baseline[] = [], uploads = new Map<string, Upload>();
  let disposed = false;
  // Serialize capture/hash/admission so concurrent awaits cannot bypass quotas,
  // expiry or complete the same upload twice.
  let queue = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  const sweep = () => {
    const time = now();
    for (const [id, u] of uploads) if (time >= u.expiresAt || time >= u.baseline.expiresAt) uploads.delete(id);
    for (let i = baselines.length - 1; i >= 0; i--) if (time >= baselines[i]!.expiresAt) {
      owner.release(baselines[i]!.target); baselines.splice(i, 1);
    }
  };
  const admit = (a: Readonly<HostAgentAccess>, write = true) => {
    sweep();
    if (disposed) fail('unavailable');
    if (!a.actorId || !a.documentId || !a.epoch || !a.permissions.includes(write ? 'prepare' : 'read') || (write && a.readOnly)) fail('denied');
    if (!owner.available(a)) fail('unavailable');
  };
  const baseline = (a: Readonly<HostAgentAccess>, base: MarkdownBase) => {
    const found = baselines.find(b => b.scope === scope(a) && b.revision === base.expectedRevision && b.sourceHash === base.sourceHash);
    if (!found) return fail('mismatch');
    return found;
  };
  const upload = (a: Readonly<HostAgentAccess>, id: string) => {
    const u = uploads.get(id);
    if (!u) return fail('expired');
    if (u.scope !== scope(a)) return fail('denied');
    return u;
  };
  const prepare = async (a: Readonly<HostAgentAccess>, b: Baseline, candidate: string) => {
    admit(a);
    if (!baselines.includes(b)) fail('expired');
    if (typeof candidate !== 'string' || candidate.length > limits.maxCandidateBytes || bytes(candidate).length > limits.maxCandidateBytes) fail('limit');
    return owner.prepare(b.target, candidate, a);
  };
  const api = {
    limits,
    read(a: Readonly<HostAgentAccess>, revision?: string) {
      const access = structuredClone(a);
      return serial(async () => {
        admit(access, false);
        if (baselines.length >= limits.maxBaselines) fail('limit');
        const captured = await owner.capture(access);
        try {
          if (typeof captured.source !== 'string' || captured.source.length > limits.maxSourceBytes || bytes(captured.source).length > limits.maxSourceBytes) fail('limit');
          if (typeof captured.revision !== 'string' || typeof captured.profile !== 'string'
            || !captured.revision || !captured.profile || captured.revision.length > 512 || captured.profile.length > 512
            || (revision !== undefined && revision !== captured.revision)) fail('mismatch');
          if (bytes(JSON.stringify(captured.diagnostics)).length > 8192) fail('limit');
          const sourceHash = await markdownChecksum(captured.source);
          admit(access, false);
          const b: Baseline = { ...captured, diagnostics: structuredClone(captured.diagnostics),
            scope: scope(access), sourceHash, expiresAt: now() + limits.ttlMs };
          // A v1 candidate identifies revision/hash, so never silently switch its
          // profile or invalidate an upload when the host reads the same source.
          const old = baselines.findIndex(x => x.scope === b.scope && x.revision === b.revision && x.sourceHash === b.sourceHash);
          if (old >= 0) {
            const previous = baselines[old]!;
            if (previous.profile !== b.profile) fail('mismatch');
            owner.release(captured.target);
            return { source: previous.source, profile: previous.profile, revision: previous.revision,
              sourceHash: previous.sourceHash, diagnostics: structuredClone(previous.diagnostics), expiresAt: previous.expiresAt };
          }
          baselines.push(b);
          return { source: b.source, profile: b.profile, revision: b.revision, sourceHash,
            diagnostics: structuredClone(b.diagnostics), expiresAt: b.expiresAt };
        } catch (error) { owner.release(captured.target); throw error; }
      });
    },
    prepare(a: Readonly<HostAgentAccess>, base: MarkdownBase, candidate: string) {
      const access = structuredClone(a), input = structuredClone(base);
      return serial(async () => { admit(access); return prepare(access, baseline(access, input), candidate); });
    },
    beginUpload(a: Readonly<HostAgentAccess>, input: MarkdownUpload) {
      const access = structuredClone(a), metadata = structuredClone(input);
      return serial(async () => {
        admit(access);
        if (uploads.size >= limits.maxUploads) fail('limit');
        if (!Number.isSafeInteger(metadata.totalBytes) || metadata.totalBytes < 0 || metadata.totalBytes > limits.maxCandidateBytes) fail('limit');
        if (!/^sha256:[0-9a-f]{64}$/.test(metadata.checksum)) fail('invalid');
        const b = baseline(access, metadata), id = crypto.randomUUID();
        uploads.set(id, { scope: scope(access), baseline: b, totalBytes: metadata.totalBytes,
          checksum: metadata.checksum, chunks: [], size: 0,
          expiresAt: Math.min(b.expiresAt, now() + limits.ttlMs) });
        return { uploadId: id, expiresAt: uploads.get(id)!.expiresAt };
      });
    },
    appendChunk(a: Readonly<HostAgentAccess>, id: string, index: number, text: string, checksum: string) {
      const access = structuredClone(a);
      return serial(async () => {
        admit(access); const u = upload(access, id);
        if (!Number.isSafeInteger(index) || index < 0 || index > u.chunks.length) fail('invalid');
        if (typeof text !== 'string' || text.length > limits.maxChunkBytes) fail('limit');
        const size = bytes(text).length;
        if (size === 0 || size > limits.maxChunkBytes) fail('limit');
        if (await markdownChecksum(text) !== checksum) fail('mismatch');
        admit(access); upload(access, id);
        if (index < u.chunks.length) {
          if (u.chunks[index] !== text) fail('mismatch');
          return { receivedBytes: u.size };
        }
        if (u.chunks.length >= limits.maxChunks || u.size + size > u.totalBytes) fail('limit');
        u.chunks.push(text); u.size += size;
        return { receivedBytes: u.size };
      });
    },
    finishUpload(a: Readonly<HostAgentAccess>, id: string) {
      const access = structuredClone(a);
      return serial(async () => {
        admit(access); const u = upload(access, id);
        if (u.size !== u.totalBytes) fail('incomplete');
        const candidate = u.chunks.join('');
        if (await markdownChecksum(candidate) !== u.checksum) { uploads.delete(id); fail('mismatch'); }
        admit(access); upload(access, id); uploads.delete(id);
        return prepare(access, u.baseline, candidate);
      });
    },
    cancelUpload(a: Readonly<HostAgentAccess>, id: string) {
      const access = structuredClone(a);
      return serial(async () => { admit(access); upload(access, id); uploads.delete(id); });
    },
    dispose() {
      return serial(async () => {
        disposed = true; uploads.clear();
        for (const b of baselines.splice(0)) owner.release(b.target);
      });
    },
  };
  const service = (write: boolean): HostAgentService => ({
    available: a => !disposed && owner.available(a),
    async execute(request, a) {
      try {
        return write ? await api.prepare(a, request as unknown as MarkdownBase, request.candidateMarkdown as string)
          : await api.read(a, request.revision as string | undefined);
      } catch (error) {
        if (error instanceof HostMarkdownError) return { status: 'rejected', code: error.code };
        throw error;
      }
    },
  });
  return Object.freeze({ ...api, services: Object.freeze({ read: service(false), prepare: service(true) }) });
}
