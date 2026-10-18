/** One package-local ID source shared by synchronous and asynchronous presenters. */
let sequence = 0;
export function nextPresenterSequence(): number { return ++sequence; }
