import { type TaskLinkHost } from './task-links.js';

/** Prepared catalog only. Production authorization and credentials stay host-owned. */
export const preparedTaskCatalog: TaskLinkHost = {
  permission: () => ({ principal: 'example-reader', tenant: 'example-team', authority: 'prepared-catalog',
    revision: '1', lookup: true, apply: true }),
  resolve: async request => request.text === 'ASD-123'
    ? { status: 'available', href: 'https://tasks.example.test/ASD-123' }
    : { status: 'missing' },
};
