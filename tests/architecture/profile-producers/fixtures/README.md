# Prepared producer admission fixtures

Every file in this directory is deterministic admission-contract data. No SDK was
built and no iOS/Android/desktop runtime was executed to create these files.
The receipt-shaped positive fixture tests the exact fields an owner must supply;
its `CONTRACT FIXTURE ONLY` runtime and `fixture.*` profile are never registered in
the production producer manifest. Fixture admission is not platform evidence.

Production tests separately adapt the original, hashed native preparation
receipts and retain their old source identities, scope and current input drift.
Those records remain pending SDK support regardless of fixture results.
