/** Shared optional-work identity; no IO or semantic mutations. */
export interface ServiceScope {
    document: string;
    session: string;
    revision: string;
    permission: string;
    authorized: boolean;
}
export type ServiceFailure = 'invalid' | 'resource-limit' | 'saturated' | 'cancelled' | 'disposed' | 'deadline' | 'stale-revision' | 'replaced-session' | 'permission-loss' | 'provider-failed';
export declare function validServiceScope(scope: Readonly<ServiceScope>): boolean;
/** Same rejection precedence as the portable session companion. */
export declare function serviceScopeFailure(expected: Readonly<ServiceScope>, current: Readonly<ServiceScope>): ServiceFailure | undefined;
