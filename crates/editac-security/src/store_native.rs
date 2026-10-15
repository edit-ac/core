//! Native ciphertext host for the SEC-1.5 qualification wrapper. This is a real
//! SQLite transaction, not a plaintext NativeStore or a durable memory fake.
use crate::store::{Blob, BlobHost};
use editac_session::ports::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Boundary {
    BeforeWrite,
    BeforeCommit,
    AfterCommit,
}
pub(crate) type Observer = Arc<dyn Fn(Boundary) -> Result<(), PortError> + Send + Sync>;
pub(crate) struct SqliteHost {
    connection: Mutex<Connection>,
    observer: Option<Observer>,
}
fn sql_error(error: rusqlite::Error) -> PortError {
    use rusqlite::ErrorCode::*;
    match error {
        rusqlite::Error::SqliteFailure(e, _) => match e.code {
            DatabaseBusy | DatabaseLocked => PortError::Conflict,
            DiskFull => PortError::Quota,
            PermissionDenied | ReadOnly => PortError::Permission,
            _ => PortError::Integrity,
        },
        _ => PortError::Integrity,
    }
}
impl SqliteHost {
    pub(crate) fn open(path: &Path, observer: Option<Observer>) -> Result<Self, PortError> {
        let connection = Connection::open(path).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(sql_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS protected_blob (
                slot INTEGER PRIMARY KEY CHECK(slot=1),
                revision INTEGER NOT NULL CHECK(revision>0),
                ciphertext BLOB NOT NULL
            );",
            )
            .map_err(sql_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            observer,
        })
    }
    /// Explicit create-only restore of an authenticated protected backup. Caller
    /// has checked backup/key/document policy. Only ciphertext crosses this port;
    /// ProtectedStore verifies its inner context/revision before any replay.
    /// Does not establish freshness or resume MLS state. Never overwrite data.
    pub(crate) fn restore_protected_backup(&self, blob: Blob) -> Result<(), PortError> {
        if blob.revision == 0
            || blob.revision > i64::MAX as u64
            || blob.ciphertext.is_empty()
            || blob.ciphertext.len() > crate::store::MAX_BLOB
        {
            return Err(PortError::ResourceLimit);
        }
        let mut connection = self.connection.lock().map_err(|_| PortError::Unavailable)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let exists: bool = transaction
            .query_row("SELECT EXISTS(SELECT 1 FROM protected_blob)", [], |r| {
                r.get(0)
            })
            .map_err(sql_error)?;
        if exists {
            return Err(PortError::Conflict);
        }
        self.observe(Boundary::BeforeWrite)?;
        transaction
            .execute(
                "INSERT INTO protected_blob(slot, revision, ciphertext) VALUES(1, ?1, ?2)",
                params![blob.revision as i64, blob.ciphertext],
            )
            .map_err(sql_error)?;
        self.observe(Boundary::BeforeCommit)?;
        transaction.commit().map_err(sql_error)?;
        self.observe(Boundary::AfterCommit)
            .map_err(|_| PortError::CommitUnknown)
    }
    fn observe(&self, boundary: Boundary) -> Result<(), PortError> {
        if let Some(observer) = &self.observer {
            observer(boundary)?;
        }
        Ok(())
    }
}
impl BlobHost for SqliteHost {
    fn capabilities(&self) -> StoreCapabilities {
        StoreCapabilities {
            durability: Durability::ProcessCrash,
            atomic_transactions: true,
            serialized_writers: true,
        }
    }
    fn read(&self, limit: usize) -> Result<Option<Blob>, PortError> {
        let connection = self.connection.lock().map_err(|_| PortError::Unavailable)?;
        let row = connection
            .query_row(
                "SELECT revision,
            CASE WHEN length(ciphertext)<=?1 THEN ciphertext ELSE NULL END
            FROM protected_blob WHERE slot=1",
                [limit as i64],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        row.map(|(revision, bytes)| {
            if revision <= 0 {
                return Err(PortError::Integrity);
            }
            Ok(Blob {
                revision: revision as u64,
                ciphertext: bytes.ok_or(PortError::ResourceLimit)?,
            })
        })
        .transpose()
    }
    fn compare_exchange(&self, expected: Option<u64>, next: Blob) -> Result<(), PortError> {
        if next.revision > i64::MAX as u64
            || next.ciphertext.len() > crate::store::MAX_BLOB
            || expected.unwrap_or(0).checked_add(1) != Some(next.revision)
        {
            return Err(PortError::ResourceLimit);
        }
        let mut connection = self.connection.lock().map_err(|_| PortError::Unavailable)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let existing = transaction
            .query_row(
                "SELECT revision FROM protected_blob WHERE slot=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(sql_error)?;
        if existing.map(|n| n as u64) != expected {
            return Err(PortError::Conflict);
        }
        self.observe(Boundary::BeforeWrite)?;
        transaction.execute("INSERT INTO protected_blob(slot,revision,ciphertext) VALUES(1,?1,?2)
            ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext",
            params![next.revision as i64, next.ciphertext]).map_err(sql_error)?;
        self.observe(Boundary::BeforeCommit)?;
        transaction.commit().map_err(|_| PortError::CommitUnknown)?;
        self.observe(Boundary::AfterCommit)
            .map_err(|_| PortError::CommitUnknown)
    }
}
