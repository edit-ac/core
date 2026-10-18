# Native review consumer qualification

`change-review-contract.json` registers the original DSK-1.18 acceptance predicates,
their exact XCTest cases, SwiftPM targets and canonical dispatcher filter. It maps
the original read-only unified/semantic view, profile labels, trusted/unknown
attribution, stale content, accessible native range navigation, shared contracts
and live replica/history isolation to the existing implementation. It adds no
semantic, diff, revision, storage or attribution owner.

The actual consumer is `NativeChangeReviewController`, using the existing
`NativeSessionExecutor`, generated Swift interface and Rust Session/SQLite owner.
The canonical `bash native/macos/scripts/check.sh change-review` executes 24
presentation cases and eight actual consumer cases. Presentation cases include
prepared portable exports; the consumer cases capture/read/compare real revisions.
The separate presentation-only command and its historical P1 receipt remain
prepared-ingress evidence. Their historical open-gate fields are not rewritten.

The NRC-1.2 owning delivery is
`architecture/evidence/native-review-consumer/nrc-1.2-20261018/delivery.json` in
the sibling architecture repository. It records the original-criterion proof,
exact source/package/interface/fixture/binary pins and retained native receipt.
Verify applicability without rebuilding unchanged native binaries, from core:

```sh
xcrun swift package --package-path native/macos dump-package > /tmp/editac-review-package.json
python3 native/macos/scripts/verify_change_review.py \
  --evidence ../architecture/evidence/native-review-consumer/nrc-1.1-20261018 \
  --package /tmp/editac-review-package.json --output /tmp/editac-review-integrity.json
python3 -m unittest discover -s native/macos/tests -p test_change_review_contract.py
```

Integrity checks reject changed source/binaries, missing/duplicate/failed native
cases, zero/skipped counts, prepared-only ingress, missing original predicates,
failed build/runtime command receipts and interface/package registration drift.
Integrity assertions and prepared admission tests are not additional native cases.
If a pinned implementation input changes, qualify it through a fresh canonical
native run before making a new delivery; do not repin an old runtime result.

The qualified scope is ARM64 macOS OS-host development; x86_64 was built only.
Native labels, read-only accessibility writes and text geometry were exercised;
no VoiceOver/AT, IME, physical-device, performance, universal-runtime or release
qualification follows. Revisions are process-local: reopening retains the SQLite
document and reports old revision handles missing. Host evidence remains separate;
names/key-profile labels are not authentication. Broader native capability and
resource profiles stay pending until their own complete gates pass.
