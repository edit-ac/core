/** Build-time qualification policy. This never migrates bytes or grants writes. */
const dimensions = ['semanticSchema', 'updateSync', 'protocolVersion', 'updateEncoding', 'offsets', 'extensionDescriptor', 'publicApi', 'nativeAbi'];
export function compatibilityDecision(policy, reader, offered) {
  if (policy.version !== 1 || !policy.endpoints?.[reader]) throw Error('Unknown compatibility reader');
  const expected = policy.endpoints[reader].versions;
  const differences = dimensions.filter(key => offered?.versions?.[key] !== expected[key]);
  if (!Object.values(policy.endpoints).some(record => record.revision === offered?.revision)) differences.push('implementationRevision');
  if (!differences.length) return Object.freeze({ outcome: 'recover', migration: 'none', export: 'owned-checkpoint-with-unknown-data' });
  return Object.freeze({ outcome: 'reject', differences, migration: 'unqualified-do-not-relabel',
    export: 'preserve-original-checkpoint-and-journal; reopen-with-matching-reader; explicitly-export-before-new-epoch' });
}
export function withCompatibleContract(policy, reader, offered, operation) {
  const decision = compatibilityDecision(policy, reader, offered);
  return decision.outcome === 'recover' ? { decision, value: operation() } : { decision };
}
