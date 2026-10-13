# Native engine entry qualification

NAT-1.1 checks the portable Rust engine on the current native host. Run with
Python 3 and a new, absolute evidence directory:

```sh
python3 tests/native/portable-engine.py --output /absolute/path/to/nat-1.1-evidence
```

The harness selects Rust 1.97.1 and Node 24.19.0 explicitly, including the child
process PATH used by Rust/Yjs fixtures. It inventories Cargo metadata, checks the
native dependency closure for platform dependencies, and runs native compilation
before tests. The test command uses `--lib`, an explicit `--test NAME` for every
current integration target except `migration`, the native host target, and
`--locked`. The resolved command and complete selected/excluded target inventory
are in `receipt.json`; this is not an unfiltered whole-crate test run.

User-content migration is deferred until full application completion and
qualification. Its source/tests remain preserved and are not executed here.
Future non-deferred integration targets are selected automatically. A missing
command/anchor/patch suite, missing result, zero executed tests, failure, ignored
test or filtered test prevents a passing receipt.

Each invocation owns its build directory and every `EDITAC_*` fixture output
directory. Full Cargo logs, per-suite executed/passed/failed/skipped counts,
source/fixture hashes and host Swift/Kotlin/Android tool availability are retained.
Missing later platform tooling carries an installation/host unblock condition;
this portable qualification does not establish native input, SDK parity,
performance, packaging or device support. It uses existing deterministic fixtures
and no paid provider transport.

After the harness exits, its reproducible `build/` may be removed under the
workspace disk-hygiene rules. Preserve the receipt, logs and fixture bytes, and
record cleanup separately. Use a new evidence directory after a relevant repair
so previous failed logs survive.
