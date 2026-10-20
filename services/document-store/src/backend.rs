//! Low-level host database owner. This is not a client SessionStore replacement.
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::{fmt, path::Path, time::Duration};

pub const SCHEMA_VERSION: i64 = 1;
const APPLICATION_ID: i64 = 0x45444143;
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitState {
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retryability {
    Never,
    Backoff,
    Reconcile,
}

/// Sanitized: database paths, SQL and user content do not enter error display.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendError {
    InvalidPath,
    Incompatible,
    Integrity,
    Busy,
    Quota,
    Permission,
    Unavailable,
    Rejected,
    CommitUnknown,
}
impl BackendError {
    pub fn commit_state(self) -> CommitState {
        if self == Self::CommitUnknown {
            CommitState::Unknown
        } else {
            CommitState::Rejected
        }
    }
    pub fn retryability(self) -> Retryability {
        match self {
            Self::Busy | Self::Unavailable => Retryability::Backoff,
            Self::CommitUnknown => Retryability::Reconcile,
            _ => Retryability::Never,
        }
    }
}
impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for BackendError {}
impl From<rusqlite::Error> for BackendError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;
        match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Self::Busy,
            Some(ErrorCode::DiskFull | ErrorCode::TooBig) => Self::Quota,
            Some(ErrorCode::PermissionDenied | ErrorCode::ReadOnly) => Self::Permission,
            Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => Self::Integrity,
            Some(ErrorCode::ConstraintViolation) => Self::Rejected,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub backend: &'static str,
    pub sqlite_version: &'static str,
    pub schema_version: i64,
    pub journal_mode: &'static str,
    pub synchronous: &'static str,
    pub atomic_transactions: bool,
    pub serialized_writers: bool,
    pub process_crash: bool,
    pub host_loss: bool,
    pub replica_loss: bool,
    pub deployment_qualified: bool,
    pub remote_receipts: bool,
}

/// A single SQLite file on a host-owned local filesystem. No implicit memory DBs.
/// SQL access is for trusted host adapters, never untrusted request input.
pub struct SqliteBackend {
    connection: Connection,
}

impl SqliteBackend {
    pub fn open(path: &Path) -> Result<Self, BackendError> {
        if !path.is_absolute()
            || path.file_name().is_none()
            || path.to_str().is_none()
            || path.to_string_lossy().contains(['?', '#'])
        {
            return Err(BackendError::InvalidPath);
        }
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        let journal: String = connection.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
        if journal != "delete" {
            return Err(BackendError::Incompatible);
        }
        // Check the existing owner/version before changing persistent pragmas.
        {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let application_id: i64 =
                tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
            let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
            if application_id == 0 && version == 0 {
                let objects: i64 = tx.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )?;
                if objects != 0 {
                    return Err(BackendError::Incompatible);
                }
                tx.execute_batch(include_str!("../migrations/001-bootstrap.sql"))?;
            } else if application_id != APPLICATION_ID || version != SCHEMA_VERSION {
                return Err(BackendError::Incompatible);
            }
            let valid: i64 = tx.query_row(
                "SELECT count(*) FROM host_metadata WHERE singleton=1 AND backend='sqlite-bundled' AND schema_version=1",
                [], |r| r.get(0)).map_err(|_| BackendError::Integrity)?;
            if valid != 1 {
                return Err(BackendError::Integrity);
            }
            tx.commit()?;
        }
        // DELETE + FULL: bounded single-writer local reference, no WAL service.
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let sync: i64 = connection.pragma_query_value(None, "synchronous", |r| r.get(0))?;
        let foreign_keys: i64 =
            connection.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
        if sync != 2 || foreign_keys != 1 {
            return Err(BackendError::Incompatible);
        }
        Ok(Self { connection })
    }

    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            backend: "sqlite-bundled",
            sqlite_version: rusqlite::version(),
            schema_version: SCHEMA_VERSION,
            journal_mode: "delete",
            synchronous: "full",
            atomic_transactions: true,
            serialized_writers: true,
            process_crash: true,
            host_loss: false,
            replica_loss: false,
            deployment_qualified: false,
            remote_receipts: false,
        }
    }

    /// One immediate transaction. The callback must use bound SQL parameters,
    /// finish bounded local work and never perform network IO or emit a receipt.
    /// No result escapes until SQLite confirms commit. IO failure at commit is
    /// conservatively unknown; later ledger lookup must resolve it, not replay.
    pub fn transaction<T>(
        &mut self,
        apply: impl FnOnce(&Transaction<'_>) -> Result<T, BackendError>,
    ) -> Result<T, BackendError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = apply(&tx)?;
        tx.commit().map_err(|_| BackendError::CommitUnknown)?;
        Ok(result)
    }
}
