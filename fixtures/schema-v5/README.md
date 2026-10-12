# Retained presentation qualification fixture

ENG-1.22 qualifies the controller's [schema-v5 contract](../../../architecture/specs/schema-v5.md) using Yrs 0.28.0/small-client, Yjs 13.6.33, y-protocols 1.0.7, Node 24.19.0 and Rust 1.97.1. This isolated fixture is not production v5 support; production creation/admission/commands remain ENG-1.23.

`profile.json` and `seed.json` describe the explicit v5 envelope and unchanged ten-root layout. `mapping.rs` and `mapping.mjs` validate the new seven-field split/join records, capture complete immutable preparation witnesses, and replay structural eligibility independently of current block presentation. Local command eligibility still uses the current presentation. Witness compatibility is an authored declaration, not inferred provenance. Version, ordering, hierarchy, tombstone, control and cut effects retain the v4 rules. The new files preserve the frozen v4 mapping and evidence.

`policy.rs` and `policy.mjs` stage complete mixed command batches, including cross-source literal replacement/deletion, before one explicit-origin live commit. They retain original rich-text identities and marks. `bounded_decoder.rs` preserves the binary/JSON resource ceilings. The Rust canonical harness runs the actual pinned Yjs counterpart, exchanges binary checkpoints/updates/relative anchors in both directions, and compares semantic projections including recovery and source identities.

Run from the core checkout with the installed pinned Node on PATH:

```sh
PATH=/Users/bpstr/.nvm/versions/node/v24.19.0/bin:$PATH cargo test -p editac-core --test retained_presentation_profile --locked
```

Set `EDITAC_RETAINED_EXCHANGE` to an isolated evidence directory to retain each execution independently. The durable receipt is `architecture/evidence/engine-retained-presentation-profile/receipt.json`; it records the exact canonical/regression commands, counts, hashes, criterion map and preserved failures. These deterministic fixtures establish representation qualification, not deployment, provider quality, performance qualification or migration support.
