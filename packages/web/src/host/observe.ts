import type { HostAgentAccess, HostAgentService } from './contract.js';

/** Reads the shared owner's current revision under current host authorization.
 * This is metadata only: it neither exports content nor releases sync bytes. */
export interface HostObserveOwner {
  available(access: Readonly<HostAgentAccess>): boolean;
  revision(access: Readonly<HostAgentAccess>): Promise<string>;
}

export interface HostObservation {
  revision: string;
  cursor: string;
  changed: boolean;
  resyncRequired: boolean;
  dataChannel: 'collaboration';
  durability: 'not-reported';
}

export function createHostObserve(owner: HostObserveOwner): HostAgentService {
  const permitted = (access: Readonly<HostAgentAccess>) => access.permissions.includes('read')
    && access.permissions.includes('observe') && owner.available(access);
  return {
    available: permitted,
    async execute(request, access): Promise<HostObservation> {
      if (!permitted(access) || request.documentId !== access.documentId) throw new Error('Observation unavailable');
      const revision = await owner.revision(access);
      if (!permitted(access)) throw new Error('Observation revoked');
      if (typeof revision !== 'string' || !revision.length || revision.length > 512) {
        throw new Error('Invalid shared revision');
      }
      const changed = request.cursor !== revision;
      return { revision, cursor: revision, changed, resyncRequired: changed,
        dataChannel: 'collaboration', durability: 'not-reported' };
    },
  };
}
