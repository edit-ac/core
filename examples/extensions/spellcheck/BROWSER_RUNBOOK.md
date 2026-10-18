# Browser and OS observation handoff for INT-1.14

This executable companion to the prepared recipe README supplies the actual-browser fixture. Canonical checks prove adapter semantics with prepared data; actual spelling menus, user dictionaries, IME and OS history remain INT-1.14 observations. No hosted checker or inference is used.

From the `core` repository, select `.node-version` (Node 24.19.0 / npm 11.17.0), build, then launch:

```sh
npm run build
node scripts/preview-spellcheck.mjs
```

The command packs and authenticates the same production engine/web packages as the canonical spellcheck suite, compiles the standalone public-import recipe and types, and prints a JSON record with the loopback URL, PID, port, workspace and evidence directory. Open that URL in the actual target browser's isolated profile. The launcher does not open or change ordinary browser sessions. Ctrl+C/SIGTERM closes the temporary host and removes its temporary installed consumer. Package/source hashes and request receipts remain in the printed evidence directory. `EDITAC_SPELLCHECK_PREVIEW_OUTPUT` chooses that directory.

For wiring verification without OS-support claims:

```sh
node scripts/preview-spellcheck.mjs --check
```

This launches one isolated headless Chromium controller, checks platform readiness, explicit overlap admission and a prepared custom correction, then closes the browser/listener/consumer. It supplements the canonical 53-case-per-browser spelling proof. The manual host is `tests/extension-dx/spellcheck-consumer/manual.html`; its editor/session, checker, loader and installed-package preparation are the canonical ones.

1. Record the printed receipt, package/runtime hashes, browser version, OS version, physical/virtual provenance, selected keyboard/locale and isolated profile's actual spelling/autocorrection preferences. Preserve the request log. An attribute requests behavior; it does not prove effective state.
2. The initial platform editor has no checker load. Add independent platform/off/custom editors with the controls and select inherit/on/off autocorrection. Blank language preserves inheritance; choose known/unavailable locales deliberately. Custom mode requires checking the explicit possible-overlap choice, unchecked by default. The controls change no global browser/OS setting.
3. In platform mode, use real typing, native spelling indicators/context menus and supported user dictionaries with the user's checker on and off. Accept a native correction away from the caret, including Unicode and formatting boundaries. Record content/marks/directional selection and one shared undo/redo through keyboard and native menu paths. Observe available/unavailable locales without inferring a dictionary from `lang` or an absent underline. Editing must remain usable without the service.
4. Repeat off and explicit custom mode. Prepared `en` recognizes only `teh`, `recieve`, decomposed `café` and `wrng`. A delimiter triggers analysis; `teh ` becomes `the ` only after explicit acceptance. Record any native/custom overlap despite requested `spellcheck=false`. Exercise readonly, stale targets, composition, code/link exclusions, foreign-field focus and history through actual browser/OS interactions where available. `window.spelling` exposes exact prepared request/status/effect counters; `window.spellingFixture` exposes the canonical helpers. Synthetic helpers alone cannot pass OS cells.
5. Record ENV-01–06 and correction ENV-07 for every claimed browser/OS profile, including inherited/explicit attributes, requested policy, observed/unknown/unsupported or coupled services and exceptions. Safari/mobile require actual Safari/mobile profiles; Playwright WebKit does not substitute. Missing mandatory observations stay open. Prepared results are not checker quality or live service evidence.
6. Restore isolated profile settings, close observation tabs and stop the host. Confirm the printed PID/listener have exited; retain receipts and screenshots/OS traces in the owning observation report. Native/device/DEL-1.7 qualification remains separate. Publication, provisioning and paid provider calls are not authorized.
