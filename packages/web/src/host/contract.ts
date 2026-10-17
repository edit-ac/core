/** Optional host-app boundary. Authentication, MCP and durable editing remain host-owned. */
export const HOST_AGENT_VERSION = 1 as const;
export const HOST_AGENT_OPERATIONS = Object.freeze(['read', 'prepare', 'apply', 'receipt', 'observe'] as const);
export type HostAgentOperation = typeof HOST_AGENT_OPERATIONS[number];
export interface HostAgentAccess {
  actorId: string;
  documentId: string;
  epoch: string;
  permissions: readonly HostAgentOperation[];
  readOnly: boolean;
}
export interface HostAgentRequest {
  version: 1;
  documentId: string;
  [key: string]: unknown;
}
export interface HostAgentReceipt {
  requestId: string;
  outcome: 'committed' | 'pending' | 'unknown' | 'not-found' | 'expired' | 'rejected';
  revision: string | null;
  localDurability: 'durable' | 'pending' | 'unknown' | 'none';
  remoteDurability: 'confirmed' | 'pending' | 'unknown' | 'not-applicable';
}
export type HostAgentResult =
  | { version: 1; status: 'ok'; data: unknown }
  | { version: 1; status: 'error'; code: 'invalid-request' | 'denied' | 'unavailable' | 'unknown-outcome' };
export interface HostAgentService {
  /** Descriptive capability must be checked again by the serialized mutation owner. */
  available(access: HostAgentAccess): boolean;
  execute(request: Readonly<HostAgentRequest>, access: Readonly<HostAgentAccess>): Promise<unknown>;
}
export interface HostAgentOptions<Context> {
  /** Context comes from the embedding app's authenticated transport, never tool arguments. */
  authorize(context: Context, documentId: string): Promise<HostAgentAccess | null>;
  services: Partial<Record<HostAgentOperation, HostAgentService>>;
}

const string = { type: 'string', minLength: 1, maxLength: 512 } as const;
const revision = { ...string, description: 'Opaque shared revision token; never a wall clock.' };
const base = { version: { const: 1 }, documentId: string };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', additionalProperties: false, properties: { ...base, ...properties },
  required: ['version', 'documentId', ...required],
});
function freezeSchema<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}
/** JSON Schema accepted by the sample app MCP; no authority-bearing input fields. */
export const HOST_AGENT_INPUT_SCHEMAS = freezeSchema({
  read: object({ representation: { enum: ['markdown', 'source'] }, revision }, ['representation']),
  prepare: object({ expectedRevision: revision, sourceHash: string,
    candidateMarkdown: { type: 'string', maxLength: 65536 } }, ['expectedRevision', 'sourceHash', 'candidateMarkdown']),
  apply: object({ expectedRevision: revision, proposalId: string, requestId: string }, ['expectedRevision', 'proposalId', 'requestId']),
  receipt: object({ requestId: string }, ['requestId']),
  observe: object({ cursor: string }, []),
} as const);

export const HOST_AGENT_RECEIPT_SCHEMA = freezeSchema({
  type: 'object', additionalProperties: false,
  required: ['requestId', 'outcome', 'revision', 'localDurability', 'remoteDurability'],
  properties: {
    requestId: string,
    outcome: { enum: ['committed', 'pending', 'unknown', 'not-found', 'expired', 'rejected'] },
    revision: { anyOf: [revision, { type: 'null' }] },
    localDurability: { enum: ['durable', 'pending', 'unknown', 'none'] },
    remoteDurability: { enum: ['confirmed', 'pending', 'unknown', 'not-applicable'] },
  },
} as const);

/** Operation data is the shared owner's result; the adapter does not invent a second semantic model. */
export const HOST_AGENT_RESULT_SCHEMA = freezeSchema({
  type: 'object',
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['version', 'status', 'data'],
      properties: { version: { const: 1 }, status: { const: 'ok' }, data: {} } },
    { type: 'object', additionalProperties: false, required: ['version', 'status', 'code'],
      properties: { version: { const: 1 }, status: { const: 'error' },
        code: { enum: ['invalid-request', 'denied', 'unavailable', 'unknown-outcome'] } } },
  ],
} as const);

// Validate the small advertised schema subset even when an app MCP ignores schemas/annotations.
function matches(value: unknown, schema: Record<string, unknown>): boolean {
  if ('const' in schema) return value === schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(s => matches(value, s));
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string'
    && value.length >= (Number(schema.minLength) || 0) && value.length <= Number(schema.maxLength);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    return (schema.required as string[]).every(k => Object.hasOwn(record, k))
      && Object.keys(record).every(k => Object.hasOwn(properties, k) && matches(record[k], properties[k]!));
  }
  return false;
}

function validReceipt(value: unknown, requestId: unknown): boolean {
  if (!matches(value, HOST_AGENT_RECEIPT_SCHEMA)) return false;
  const r = value as HostAgentReceipt;
  return r.requestId === requestId
    && (r.outcome !== 'committed' || (r.localDurability === 'durable' && r.revision !== null))
    && (r.remoteDurability !== 'confirmed' || (r.outcome === 'committed' && r.localDurability === 'durable'))
    && (!['rejected', 'not-found', 'expired'].includes(r.outcome)
      || (r.localDurability === 'none' && r.remoteDurability === 'not-applicable'));
}

export function createHostAgent<Context>(options: HostAgentOptions<Context>) {
  // Freeze registration; services still evaluate live capabilities on every request.
  const services = { ...options.services };
  const permitted = (access: HostAgentAccess, op: HostAgentOperation) =>
    access.permissions.includes(op) && (op !== 'observe' || access.permissions.includes('read'))
    && !(access.readOnly && (op === 'apply' || op === 'prepare'));
  const resolve = async (context: Context, documentId: string) => {
    const access = await options.authorize(context, documentId);
    if (!access || !access.actorId || !access.epoch || access.documentId !== documentId) return null;
    return Object.freeze({ ...access, permissions: Object.freeze([...access.permissions]) });
  };
  return Object.freeze({
    async capabilities(context: Context, documentId: string): Promise<readonly HostAgentOperation[]> {
      try {
        const access = await resolve(context, documentId);
        return access ? HOST_AGENT_OPERATIONS.filter(op => permitted(access, op) && services[op]?.available(access)) : [];
      } catch { return []; }
    },
    async call(operation: string, input: unknown, context: Context): Promise<HostAgentResult> {
      const error = (code: Extract<HostAgentResult, { status: 'error' }>['code']): HostAgentResult =>
        ({ version: 1, status: 'error', code });
      if (!HOST_AGENT_OPERATIONS.includes(operation as HostAgentOperation)) return error('unavailable');
      const op = operation as HostAgentOperation;
      let request: HostAgentRequest;
      try {
        // Snapshot before async authorization, excluding mutable caller-owned arguments.
        request = structuredClone(input) as HostAgentRequest;
        if (!matches(request, HOST_AGENT_INPUT_SCHEMAS[op])) return error('invalid-request');
        if (new TextEncoder().encode(JSON.stringify(request)).length > 72 * 1024) return error('invalid-request');
      } catch { return error('invalid-request'); }
      let access: Readonly<HostAgentAccess> | null;
      try { access = await resolve(context, request.documentId); } catch { return error('denied'); }
      if (!access || !permitted(access, op)) return error('denied');
      const service = services[op];
      try { if (!service?.available(access)) return error('unavailable'); } catch { return error('unavailable'); }
      try {
        const data = await service.execute(Object.freeze(request), access);
        if (op === 'observe') {
          const current = await resolve(context, request.documentId);
          if (!current || !permitted(current, op) || !current.permissions.includes('read')
            || current.actorId !== access.actorId || current.epoch !== access.epoch) return error('denied');
        }
        if ((op === 'apply' || op === 'receipt') && !validReceipt(data, request.requestId)) return error('unknown-outcome');
        return { version: 1, status: 'ok', data };
      } catch {
        // An exception cannot establish whether a mutation committed. Retry via the same request identity.
        return error(op === 'apply' || op === 'receipt' ? 'unknown-outcome' : 'unavailable');
      }
    },
  });
}
