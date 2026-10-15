import type { LinkAction, LinkDisplay, LinkFreshness, LinkRequest, LinkResult, LinkState } from './contract.js';
/** Per-viewer transient display. Never serialize this record into shared content.
 * Asset handles require a host-vetted local asset adapter, never a remote URL. */
export interface LinkPresentation {
    state: LinkState;
    label: string;
    display?: Readonly<LinkDisplay>;
    freshness?: Readonly<LinkFreshness>;
    actions: readonly Readonly<LinkAction>[];
}
/** Headless presenter boundary shared by native/TUI adapters. It performs no IO,
 * retains no resolved metadata and never commits a label. Hosts supply the current
 * owning request on every read, rerender on revocation/expiry, and own focus/a11y. */
export declare class LinkPresenterSession {
    #private;
    private readonly signal?;
    readonly request: Readonly<LinkRequest>;
    constructor(request: Readonly<LinkRequest>, authoredLabel: string, signal?: AbortSignal | undefined);
    dispose(): void;
    present(result: Readonly<LinkResult>, current: Readonly<LinkRequest>, now: number): Readonly<LinkPresentation>;
}
