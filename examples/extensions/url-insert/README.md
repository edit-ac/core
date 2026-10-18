# Insert an authorized link from a URL

Copy [url-insert.ts](url-insert.ts). Its one public import is `@edit-ac/web`.
Explicitly selecting the recipe enables HTTPS recognition in local authored or
pasted text; there is no implicit global URL lookup.

```ts
import { createEditor } from '@edit-ac/web';
import { createUrlInsert, preparedUrlResolver } from './url-insert.js';
const UrlInsert = createUrlInsert({
  permission: () => ({ principal: 'demo', tenant: 'prepared', authority: 'urls',
    revision: 'allowlist-1', lookup: true, apply: true }),
  resolve: preparedUrlResolver,
  onStatus: status => { statusElement.textContent = status; },
});
const editor = createEditor(root, { ...localStorageOptions,
  extensions: [UrlInsert.configure({ paste: true, timeoutMs: 5000 })],
});
await editor.ready;
// Paste https://notes.example.test/one to retain that exact text and add
// a standard link to https://docs.example.test/notes/one after host authorization.
// On teardown: await editor.destroy({ policy: 'report' });
```

The sample resolver uses a hand-authored mapping, not a metadata service.
Unknown input returns `missing`; it never synthesizes a destination. Host callbacks
and credentials stay outside document data, logs and serializable options. Replace
only the resolver/permission callbacks with your authorized application integration;
there is no automatic public fetch, content upload or production provider fallback.
`statusElement` is an accessible host status element; editor root/local persistence
configuration comes from getting started.

Recognition is bounded to a 512 UTF-16-unit changed-range context, four matches,
one active request and four queued/cache entries per instance. A URL is at most
248 units (`https://` plus 240), separated by whitespace or parentheses; ambiguous
punctuation is deliberately left to the host resolver. This is not a generic URL
parser. Code, existing links, module runs, composition, remote/reopen/export and
literal actions are excluded by the existing matcher. `paste:false` disables
paste-triggered resolution. Input options validate before attachment.

Host permission scopes every request and application. The resolver must return a
found `{status:'available', href}`; missing/forbidden/unavailable/error/timeout
results preserve literal input and create no link/history edit. The shared matcher and strict
`safeLink` owner reject executable schemes, relative URLs, credentials, controls
and results over 2,048 UTF-16 units before preparing the standard link command. Host lookup
and egress authorization remain separate from syntax safety. No label replacement
or persistent reference is inferred from a found URL.

Pending text stays untouched. Stable anchors, current text/source, generation,
authority and readonly/focus/composition are revalidated before the one atomic link
application. Unrelated edits rebase; obsolete results do nothing. Current selection
and existing formatting survive. One undo removes the link; redo restores it.
History replay does not start another request. `subscribe` invalidates on a changed
catalog/policy/logout and returns its unsubscribe; `attached` exposes the managed
controller for optional host cancellation. Editor disposal aborts requests and
cleans subscriptions; late results cannot apply elsewhere.

Standard links need no custom presenter. For an explicit persistent custom-reference
representation, select `createUrlInsert({ ...host, representation: 'reference' })`
before `.configure()`. This admits `example.url-reference`, a data-defined inline
atom over unchanged engine semantics. The validated found URL and original source
label enter one prepared fragment; failed resolution inserts nothing. Its portable
fallback is the original URL text. The destination remains an opaque `href`
attribute; source, label and href survive checkpoint/reopen and internal clipboard
transfer when the receiving editor has no extension or presenter. This behavior is
verified with this exact recipe, not a substitute data fixture. Default `link`
mode admits no custom data definition. The reference variant intentionally has no
presenter and does not load metadata or create another reference store. Hosts can
add a renderer using the existing authoring API. This custom data is distinct from
the built-in reference extension; built-in reference/LNK qualification stays with
its owners.

`node scripts/test-extension-dx.mjs --group parsing` compiles both original recipes
against installed tarballs and uses production anchors/history plus prepared host
responses in three browsers. It reuses the EXT-1.16 matching and LNK safeLink ports,
not a second async command implementation. It proves prepared integration behavior,
not live resolver availability, OS input or performance/release qualification.
