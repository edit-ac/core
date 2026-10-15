import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as links from '../packages/web/dist/modules/links/contract.js';
import { ReferenceLookupSession } from '../packages/web/dist/modules/references.js';
import { init } from '@edit-ac/core';

const targetId = 'ac://team/71000000-0000-4000-8000-000000000008';
function request(target, policy, origin) {
  return { requestId: 'request:1', cancellationToken: 'cancel:1', node: 'node:1', epoch: 'epoch:1', labelRevision: 'label:1',
    host: { principal: 'principal:1', tenant: 'tenant:1', authority: 'team',
      scope: { document: 'doc:1', session: 'session:1', revision: 'revision:1', permission: 'permission:1', authorized: true },
      policyRevision: 'policy:1', readonly: false,
      capabilities: { publicMetadata: true, privateLookup: true, title: true, icon: true, preview: true, activate: true, publishMetadata: true } },
    target: target === 'public' ? { kind: 'public', url: 'https://example.test/private?secret=redact' } : { kind: 'private', targetId, authority: 'team' }, policy, origin };
}
function change(r, mutation) {
  switch (mutation) {
    case 'principal': r.host.principal = 'principal:2'; break;
    case 'tenant': r.host.tenant = 'tenant:2'; break;
    case 'authority': r.host.authority = 'other'; break;
    case 'target-authority': r.target = { kind: 'private', targetId: targetId.replace('team/', 'other/'), authority: 'other' }; break;
    case 'permission': r.host.scope.permission = 'permission:2'; break;
    case 'unauthorized': r.host.scope.authorized = false; break;
    case 'no-public': r.host.capabilities.publicMetadata = false; break;
    case 'no-private': r.host.capabilities.privateLookup = false; break;
    case 'no-title': r.host.capabilities.title = false; break;
    case 'no-icon': r.host.capabilities.icon = false; break;
    case 'no-preview': case 'capability': r.host.capabilities.preview = false; break;
    case 'no-activate': r.host.capabilities.activate = false; break;
    case 'no-publish': r.host.capabilities.publishMetadata = false; break;
    case 'document': r.host.scope.document = 'doc:2'; break;
    case 'session': r.host.scope.session = 'session:2'; break;
    case 'revision': r.host.scope.revision = 'revision:2'; break;
    case 'policy': r.host.policyRevision = 'policy:2'; break;
    case 'empty-id': r.requestId = ''; break;
    case 'long-id': r.requestId = 'x'.repeat(513); break;
    case 'long-url': r.target = { kind: 'public', url: 'x'.repeat(8193) }; break;
    case 'control': r.node = 'node\u0085'; break;
    case 'unicode-id': r.requestId = '😀'.repeat(256); break;
    case 'unicode-long-id': r.requestId = '😀'.repeat(257); break;
    case 'readonly': r.host.readonly = true; break;
    case 'request-id': r.requestId = 'request:2'; break;
    case 'token': r.cancellationToken = 'cancel:2'; break;
    case 'node': r.node = 'node:2'; break;
    case 'epoch': r.epoch = 'epoch:2'; break;
    case 'label': r.labelRevision = 'label:2'; break;
    case 'target': r.target = { kind: 'public', url: 'https://example.test/other' }; break;
  }
}
function outcome(r, mutation) {
  if (['unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'].includes(mutation)) return { status: mutation };
  const display = { title: 'Prepared title', description: 'Prepared preview', iconAsset: 'asset_1' };
  switch (mutation) {
    case 'control-title': display.title = 'title\nsecret'; break;
    case 'long-title': display.title = 'x'.repeat(513); break;
    case 'long-description': display.description = 'x'.repeat(2049); break;
    case 'remote-icon': display.iconAsset = 'https://private.test/icon'; break;
  }
  const metadata = r.target.kind === 'private' || mutation === 'wrong-family'
    ? { kind: 'private', display, targetId: mutation === 'wrong-identity' ? targetId.replace('008', '009') : targetId }
    : { kind: 'public', display, provider: 'prepared', requestedUrl: r.target.url, canonicalUrl: 'https://example.test/advisory' };
  return { status: 'available', metadata, freshness: { fetchedAt: mutation === 'future' ? 101 : 90, expiresAt: mutation === 'expired' ? 100 : 110, policyRevision: mutation === 'freshness-policy' ? 'policy:2' : r.host.policyRevision } };
}
const corpus = readFileSync(new URL('../fixtures/links/contract.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
assert.equal(corpus.length, 76);
for (const row of corpus) {
  const [id, kind, target, policy, origin, mutation, expected] = row.split('\t');
  test(`contract: ${id}`, () => {
    const captured = request(target, policy, origin);
    if (mutation.startsWith('no-') || mutation === 'readonly' || (kind === 'admit' && ['empty-id', 'long-id', 'long-url', 'control', 'unicode-id', 'unicode-long-id', 'target-authority'].includes(mutation))) change(captured, mutation);
    const current = structuredClone(captured); change(current, mutation);
    let actual;
    switch (kind) {
      case 'admit': { const a = links.admitLinkRequest(captured, current.host, mutation === 'canceled'); actual = a.status === 'ready' ? a.port : a.status; break; }
      case 'result': actual = links.validateLinkResult({ request: captured, outcome: outcome(captured, mutation) }, current, 100); break;
      case 'activate': case 'publish': actual = links.linkIntentPermission(captured, current.host, kind === 'activate' ? 'activate' : 'commit-metadata'); break;
      case 'catalog': actual = links.referenceCatalogState({ targetId, status: mutation }); break;
      default: assert.fail('unknown fixture kind');
    }
    assert.equal(actual, expected);
  });
}

test('capture is immutable; malformed browser values are denied without diagnostics containing content', () => {
  const r = request('public', 'local-paste', 'local-paste'), captured = links.captureLinkRequest(r);
  r.target.url = 'https://example.test/changed'; r.host.capabilities.publicMetadata = false;
  assert(captured.target.url.includes('secret=redact')); assert(captured.host.capabilities.publicMetadata);
  assert.throws(() => { captured.host.scope.document = 'changed'; }, TypeError);
  for (const patch of [{ policy: 'unknown' }, { origin: 'unknown' }, { target: { kind: 'shell', url: 'exec' } }, { host: { ...captured.host, capabilities: {} } }]) {
    const bad = { ...captured, ...patch };
    assert.equal(links.admitLinkRequest(bad, captured.host).status, 'unsupported');
    assert.throws(() => links.captureLinkRequest(bad), { message: 'Invalid link request' });
  }
  assert(links.validLinkAction({ kind: 'lookup', request: captured, port: 'public' }));
  assert(links.validLinkAction({ kind: 'activate', request: captured }));
  assert(links.validLinkAction({ kind: 'copy-locator', target: captured.target }));
  assert(links.validLinkAction({ kind: 'commit-metadata', request: captured, sharedLabel: 'User-approved' }));
  assert(!links.validLinkAction({ kind: 'lookup', request: captured, port: 'private' }));
  assert(!links.validLinkAction({ kind: 'commit-metadata', request: captured, sharedLabel: 'x'.repeat(513) }));
  assert.equal(links.referenceCatalogState({ targetId, status: 'unexpected' }), 'unsupported');
  const invalidCurrent = structuredClone(captured); invalidCurrent.node = '';
  assert.equal(links.validateLinkResult({ request: captured, outcome: outcome(captured, 'none') }, invalidCurrent, 100), 'unsupported');
});

test('existing reference host projection and real engine edits do not call resolver ports', async () => {
  const wasm = readFileSync(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
  const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
  const engine = runtime.createEngine({ profile: 'v5', documentId: '71000000-0000-4000-8000-000000000008', epoch: '72000000-0000-4000-8000-000000000008', nodes: [{ text: 'Link label' }] });
  let resolves = 0, catalogs = 0, subscriptions = 0;
  const permission = { revision: 'host:1', lookup: false, insert: true };
  const host = { version: 1, permission: () => permission, catalog: () => { catalogs++; return { targetId, status: 'cached' }; },
    resolve: () => { resolves++; return []; }, subscribe: () => { subscriptions++; return { dispose() { subscriptions--; } }; } };
  const lookup = new ReferenceLookupSession(host);
  try {
    const r = request('private', 'local-paste', 'open');
    const scope = links.referencePermissionProjection(r.host.scope, permission);
    assert.equal(scope.authorized, false); assert.equal(scope.permission, 'host:1');
    assert.equal(await lookup.search({ query: 'secret', requestId: 1, signal: new AbortController().signal }).then(x => x.length), 0);
    const before = engine.checkpoint();
    for (const origin of ['open', 'render', 'remote', 'replay', 'history']) assert.equal(links.admitLinkRequest({ ...r, origin }, r.host).status, 'unavailable');
    assert.deepEqual(engine.checkpoint().bytes, before.bytes);
    const owner = engine.read().visible[0].id;
    engine.commit(engine.prepare({ kind: 'editor', origin: 'extension:link-contract', commands: [{ type: 'replaceAt', owner, from: 0, to: 4, text: 'Safe' }] }));
    assert.equal(engine.read().visible[0].runs.map(r => r.text).join(''), 'Safe label');
    assert.equal(resolves, 0); assert.equal(catalogs, 0);
  } finally { lookup.dispose(); engine.dispose(); }
  assert.equal(subscriptions, 0);
});
