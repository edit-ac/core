/** Shared optional-work identity; no IO or semantic mutations. */
export interface ServiceScope {
  document: string;
  session: string;
  revision: string;
  permission: string;
  authorized: boolean;
}
export type ServiceFailure = 'invalid' | 'resource-limit' | 'saturated' | 'cancelled' | 'disposed' | 'deadline' | 'stale-revision' | 'replaced-session' | 'permission-loss' | 'provider-failed';
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function validServiceScope(scope: Readonly<ServiceScope>): boolean {
  return !!scope && [scope.document, scope.session, scope.revision, scope.permission].every(identity) && typeof scope.authorized === 'boolean';
}
/** Same rejection precedence as the portable session companion. */
export function serviceScopeFailure(expected: Readonly<ServiceScope>, current: Readonly<ServiceScope>): ServiceFailure | undefined {
  if (!validServiceScope(expected) || !validServiceScope(current)) return 'invalid';
  if (current.document !== expected.document || current.session !== expected.session) return 'replaced-session';
  if (!expected.authorized || !current.authorized || current.permission !== expected.permission) return 'permission-loss';
  if (current.revision !== expected.revision) return 'stale-revision';
  return undefined;
}
