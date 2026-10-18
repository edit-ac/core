import {
  ASSISTIVE_VERSION, AssistiveRegistration,
  type AssistiveDescriptor, type AssistiveCommandApplicability, type AssistivePresenterStatus,
  type AssistiveTarget, type AssistiveResult, type AssistiveTransport,
  type AssistiveTransportSession, type AssistiveTransportEvent,
} from '@edit-ac/core/extensions';

const descriptor: AssistiveDescriptor = {
  version: ASSISTIVE_VERSION, enabled: true, capabilities: ['commands', 'status', 'host-transport'],
  limits: { textBytes: 64, statusBytes: 32, commands: 4, results: 8, sessions: 1, timeoutMs: 1000 },
  transport: { input: 'transcript', locality: 'unknown', permissionOwner: 'host', retention: 'none', cancellation: 'best-effort', canStop: true },
};
const applicability: AssistiveCommandApplicability = { commandId: 'undo', label: 'Undo', enabled: false, reason: 'unavailable' };
const status: AssistivePresenterStatus = { version: 1, state: 'idle', session: null, reason: null, message: 'Ready', provisional: '' };
const preparedTransport: AssistiveTransport = {
  start(request, signal, emit): AssistiveTransportSession {
    const final: AssistiveResult = { version: 1, session: request.session, sequence: 0, kind: 'final', text: 'Prepared' };
    const event: AssistiveTransportEvent = { type: 'result', result: final };
    return { stop() { if (!signal.aborted) emit(event); }, cancel() {}, dispose() {} };
  },
};
// Targets are existing engine-scoped stable anchors, never numerical caret offsets.
function targetHasAnchors(target: AssistiveTarget): string { return target.range.anchor; }
// @ts-expect-error Incompatible descriptor version.
const badVersion: AssistiveDescriptor['version'] = 2;
// @ts-expect-error No implicit recognition capability.
const badCapability: AssistiveDescriptor['capabilities'] = ['speech-service'];
// @ts-expect-error Processing locality must remain explicit.
const badLocality: NonNullable<AssistiveDescriptor['transport']>['locality'] = 'inferred-local';
// @ts-expect-error A raw numerical selection is not an engine anchor range.
const badTarget: AssistiveTarget['range'] = { anchor: 0, focus: 1 };
const registration = new AssistiveRegistration();
registration.register(descriptor); registration.validateCommands([applicability]); registration.validateStatus(status);
registration.dispose();
void [preparedTransport,targetHasAnchors,badVersion,badCapability,badLocality,badTarget];
