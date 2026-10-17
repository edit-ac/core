import type { CollaborationConfigurationV1 } from '../extensions/contract.js';
import type { AttachSyncOptions, SyncAttachment } from './attachment.js';

/** Common connector admission; each existing surface lifetime owns its abort/generation. */
export async function connectConfiguredCollaboration(policy: CollaborationConfigurationV1, context: {
  signal: AbortSignal; generation: number; current(): boolean; attach(options: AttachSyncOptions): Promise<SyncAttachment>;
}): Promise<void> {
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(Error('Collaboration cancelled'));
    if (context.signal.aborted) cancel(); else context.signal.addEventListener('abort', cancel, { once: true });
  });
  let options: AttachSyncOptions;
  try { options = await Promise.race([Promise.resolve().then(() => policy.connect({ signal: context.signal, generation: context.generation })), cancelled]); }
  finally { if (cancel) context.signal.removeEventListener('abort', cancel); }
  if (!context.current()) throw Error('Collaboration superseded');
  if (options.authorized !== true) throw Error('Collaboration authorization denied');
  const { presence: hostPresence, ...syncOptions } = options;
  if (policy.presence?.awareness && !hostPresence) throw Error('Configured awareness requires an explicit host presence transport and clientId');
  const attachment = await context.attach({ ...syncOptions,
    ...(policy.presence?.awareness ? { presence: { ...hostPresence!, peerCarets: policy.presence.peerCarets } } : {}) });
  if (!context.current()) { attachment.detach(); throw Error('Collaboration superseded'); }
}
