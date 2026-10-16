# Native change-review presenter prerequisite

DSK-1.18-P1 implements an internal detached AppKit read-only surface. The presenter
consumes the existing `editac-change-model-v1` export; it never compares snapshots,
rewinds a replica, interprets a label as an author, or applies source line ranges as
editor offsets. It retains exact unified wire/newline metadata, projected Markdown
normalization/serializer/dialect labels, full semantic before/after payloads,
independent facets and retained structure. Navigation selects UTF-16 ranges in the
review surface only. Full scope equality determines current/stale presentation;
a missing current scope retains the historical view with an explicit label.

The internal `fromSharedValidatedExport` entry requires prior shared Rust
validation. Its additional native checks protect display shape/bounds, and are
not a portable model validator. No public unvalidated-JSON API is exposed. Trusted
host evidence is supplied independently; portable attribution stays unknown.

Run `bash native/macos/scripts/check.sh change-review-presentation` with the pinned
toolchain. It runs the shared portable exporter/validator corpus, including actual
concurrent Yrs export, then native AppKit presentation cases. Model ingress and
revision scope are prepared: this is not canonical `change-review` qualification.
An actual SQLite Session non-mutation check is separate from missing immutable
revision/model validation integration. Both CPU builds do not imply x86_64 runtime
or platform/VoiceOver support.

P2 requires the qualified shared Session/FFI revision and portable-validation bridge;
P3 must compose it with this presenter and pass the original canonical suite. The
request is `architecture/evidence/macos/change-review-20261016/shared-request.json`.
DSK-1.18/I1/V1 remain unchecked. No native diff algorithm or second semantic store.
