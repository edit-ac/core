import type { HostAgentAccess, HostAgentReceipt, HostAgentRequest, HostAgentService } from './contract.js';

/** A host implementation must use its serialized shared EditService owner. The
 * owner reauthorizes inside admission, journals request identity with update
 * bytes, and releases bytes only on the ordinary collaboration channel. A tool
 * response/notification is never a patch, history event, or remote storage ack.
 */
export interface HostApplyOwner {
  available(access: Readonly<HostAgentAccess>, operation: 'apply' | 'receipt'): boolean;
  apply(request: Readonly<HostAgentRequest>, access: Readonly<HostAgentAccess>): Promise<HostAgentReceipt>;
  receipt(request: Readonly<HostAgentRequest>, access: Readonly<HostAgentAccess>): Promise<HostAgentReceipt>;
}

/** Optional MCP mapping, with no mutation retry or duplicate semantic engine.
 * Exceptions and revocation after admission remain unknown outcomes; callers
 * recover using the same authorized durable request identity.
 */
export function createHostApply(owner: HostApplyOwner): { apply: HostAgentService; receipt: HostAgentService } {
  const service = (operation: 'apply' | 'receipt'): HostAgentService => ({
    available: access => owner.available(access, operation),
    async execute(request, access) {
      const permitted = () => access.permissions.includes(operation)
        && !(operation === 'apply' && access.readOnly) && owner.available(access, operation);
      if (!permitted()) throw new Error('Host access unavailable');
      const result = await owner[operation](request, access);
      // Do not leak outcomes after in-flight revocation. A committed edit stays
      // recoverable in the owner; throwing cannot imply rollback.
      if (!permitted()) throw new Error('Host access revoked');
      return structuredClone(result);
    },
  });
  return { apply: service('apply'), receipt: service('receipt') };
}
