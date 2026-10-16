import { installHighlightWorker } from './worker.js';
// Separate explicit worker entry; importing the public modules starts no work.
installHighlightWorker(globalThis as unknown as Parameters<typeof installHighlightWorker>[0]);
