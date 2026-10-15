# Link presenter conformance fixtures

`node --test tests/link-public-exports.test.mjs` packs core/web, installs them offline in an isolated consumer, checks declarations and inert imports, then executes `consumer.mjs` for every named profile in `platforms.json`. The same cases exercise public and private outcomes against the production engine WASM and require unchanged checkpoint bytes. The manifest identifies future host API wiring; all current execution is Node headless contract proof. No native controls, OS launch, device accessibility or deployed egress are qualified here.

Set `EDITAC_LINK_EXPORTS_OUTPUT` to an absolute evidence directory to preserve package tarballs, generated consumers, complete subprocess logs, execution counts and a consumer receipt. The outer runner must retain its own complete log and bind source/build hashes. Tests use prepared catalog outcomes and no provider or private endpoint.
