#!/usr/bin/env node
/** Explicitly started test infrastructure; fixture files contain prepared tokens only. */
import { readFile } from 'node:fs/promises';
import { startReferenceRelay } from './relay.mjs';
const [databasePath, fixturePath] = process.argv.slice(2);
if (!databasePath || !fixturePath) throw new Error('Usage: node examples/sync-server/serve.mjs DATABASE PREPARED-GRANTS.json');
const grants = JSON.parse(await readFile(fixturePath, 'utf8'));
const relay = await startReferenceRelay({ databasePath, grants });
console.log(JSON.stringify({ testOnly: true, pid: process.pid, url: relay.url, databasePath }));
let closing = false;
async function stop() { if (closing) return; closing = true; await relay.close(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
