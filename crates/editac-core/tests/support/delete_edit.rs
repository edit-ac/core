//! FND-1.7 disposable policy, not a production schema or command API.
//!
//! Deletion is a permanent tombstone for this logical ID. Never remove its
//! registry text or placement: concurrent/stale-peer edits remain recoverable
//! with their original shared identity and marks. Recovery is an explicit read
//! of hidden content, not a visibility write. Undo/restoration/compaction policy
//! is deliberately not claimed by this probe.
#[path = "structure_registry.rs"]
#[allow(dead_code)]
pub(crate) mod registry;

use yrs::{Any, Doc, Map, Transact};

const BLOCK: &str = "block-1";
const TOMBSTONES: &str = "delete-probe-tombstones";

pub(crate) fn fixture() -> Doc {
    let doc = registry::fixture();
    doc.get_or_insert_map(TOMBSTONES);
    doc
}

pub(crate) fn deleted(doc: &Doc) -> bool {
    let tombstones = doc.get_or_insert_map(TOMBSTONES);
    let txn = doc.transact();
    match tombstones.get(&txn, BLOCK) {
        None => false,
        Some(yrs::Out::Any(Any::Bool(true))) => true,
        other => panic!("invalid probe tombstone: {other:?}"),
    }
}

pub(crate) fn delete(doc: &Doc) {
    if !deleted(doc) {
        doc.get_or_insert_map(TOMBSTONES).insert(
            &mut doc.transact_mut_with("fixture:delete"),
            BLOCK,
            true,
        );
    }
}

/// A command on a replica that knows deletion rejects before mutation. Updates
/// from an offline peer still merge into retained text through ordinary Yrs.
pub(crate) fn edit_visible(doc: &Doc) -> Result<(), &'static str> {
    if deleted(doc) {
        return Err("deleted target");
    }
    registry::edit(doc);
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub(crate) visible: Option<registry::Projection>,
    pub(crate) recovery: Option<registry::Projection>,
}

pub(crate) fn project(doc: &Doc) -> Projection {
    let retained = registry::project(doc);
    if deleted(doc) {
        Projection {
            visible: None,
            recovery: Some(retained),
        }
    } else {
        Projection {
            visible: Some(retained),
            recovery: None,
        }
    }
}
