import { createHostAgent, HOST_AGENT_OPERATIONS } from '@edit-ac/web/host';
import { registerHostAgent } from './register.mjs';

/** Deterministic demonstration only. Never use this fake auth or fixture data in a real app. */
export function createPreparedApp() {
  const state = { revoked: false, readOnly: false, enabled: true, calls: [], authorizations: [] };
  const services = Object.fromEntries(HOST_AGENT_OPERATIONS.map(op => [op, {
    available: () => state.enabled,
    async execute(input, access) {
      state.calls.push({ op, input, access });
      if (op === 'apply' || op === 'receipt') return {
        requestId: input.requestId, outcome: 'committed', revision: 'revision-2',
        localDurability: 'durable', remoteDurability: 'unknown',
      };
      return { fixture: op };
    },
  }]));
  const host = createHostAgent({
    async authorize(context, documentId) {
      state.authorizations.push({ context, documentId });
      return context?.session === 'fake-host-session' && documentId === 'fixture-document' && !state.revoked ? {
        actorId: 'host-actor', documentId, epoch: 'host-epoch', readOnly: state.readOnly,
        permissions: [...HOST_AGENT_OPERATIONS],
      } : null;
    }, services,
  });
  let provider;
  registerHostAgent({ registerToolProvider(p) { provider = p; } }, host);
  const app = {
    list: (context, documentId) => provider.list(context, documentId),
    async call(operation, input, context) {
      return JSON.parse(JSON.stringify(await provider.call(`editac_v1_${operation}`,
        JSON.parse(JSON.stringify(input)), context)));
    },
  };
  return { host, state, services, context: { session: 'fake-host-session' }, app };
}
