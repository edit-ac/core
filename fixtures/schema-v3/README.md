# Disposable general ownership qualification

ENG-1.17's exact layout is in `architecture/specs/schema-v3.md` in the sibling checkout. `mapping.rs` and `mapping.mjs` independently implement that layout over real pinned Yrs/Yjs documents. They are fixture code; production integration is ENG-1.18.

From the core checkout:

```sh
PATH=/Users/bpstr/.nvm/versions/node/v24.19.0/bin:$PATH cargo test -p editac-core --test ownership_profile --locked
```

The Rust check runs the actual Node exchange, writes binary updates and semantic/recovery snapshots, and reimports Yjs outputs. Set `EDITAC_OWNERSHIP_EXCHANGE` to a fresh output directory to retain a separate receipt run. Default output is `../architecture/evidence/engine-ownership-profile/exchange`. All contents are deterministic fixtures; no providers or credentials are used. Existing failure logs belong to their receipt and should not be overwritten when capturing a new qualification run.

The receipt records source hashes, resource limits, alternatives, actual test counts and regressions. Functional bounds are not performance qualification. No new v1/v2 profile support, migration, publication or production v3 support follows from this fixture.
