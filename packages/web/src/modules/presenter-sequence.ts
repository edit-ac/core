/** View/request IDs stay unique across native ESM and bundled presenter copies.
 * Nothing reads browser globals at import; these IDs never enter document state.
 */
export function nextPresenterSequence(): string { return crypto.randomUUID(); }
