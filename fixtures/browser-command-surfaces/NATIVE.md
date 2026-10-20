# Native command observations

Build the core, web and optional Markdown packages using the pinned toolchain.
From `core`, set `EDITAC_NATIVE_COMMAND_OUTPUT` to a new absolute evidence
directory and run `node tests/browser/serve-native-commands.mjs`. Open its
loopback URL in the actual target browser with a unique `?run=<case-id>` value.
An optional `seed` query parameter sets the first block's fixture text.

Use the real browser Edit/context menus and OS replacement UI. Record a
checkpoint after each action. The receipt contains trusted input observations
and authoritative Session content, history, journal and revision state. The
visible Undo/Redo controls use captured shared commands; they are a comparison
route, not proof of an OS menu action. Verify stored document performs an actual
storage reopen. Reload with a new case ID afterward. Reusing a case ID reseeds an
existing database and is not a valid fresh-session protocol.

`native-session.mjs` uses the canonical `session.mjs` setup with only its database
name isolated per manual case. Neither fixture implements document semantics.
The server records the Git revision and hashes of every served fixture and build
artifact. SIGTERM/SIGINT closes the listener and records whether those bytes
stayed unchanged. Preserve unsuccessful observations alongside successful ones.

Native menu enablement, the focused owner, exact supplied replacement range,
one semantic history action, cancellation/permission behavior and recovery must
be checked independently. `isTrusted`, a successful UI dispatch, a toolbar action
or prepared browser events cannot substitute for observed native execution.
Close only the test browser window/tab and stop the server after the checks.
