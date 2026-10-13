import { startFixtureServer } from '../../tests/browser/fixture-server.mjs';
const server = await startFixtureServer({ fixtureDirectory: 'examples/task-editor' });
console.log(`Task editor: ${server.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
