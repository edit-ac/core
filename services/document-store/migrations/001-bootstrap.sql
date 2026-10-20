-- Adapter metadata only. Catalog, updates, assets and ledger have later owners.
CREATE TABLE host_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    backend TEXT NOT NULL CHECK (backend = 'sqlite-bundled'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;
INSERT INTO host_metadata VALUES (1, 'sqlite-bundled', 1);
PRAGMA application_id = 1162101059; -- 0x45444143 (EDAC)
PRAGMA user_version = 1;
