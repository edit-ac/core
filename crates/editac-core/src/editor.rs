//! Profile dispatch to the exact qualified replay, without migration or repair.
use crate::{editor_mapping as v4, ownership as v3, stable_editor_mapping as v5};
use yrs::{Any, Doc, ReadTxn, Transact};

pub(crate) fn is_editor(d: &Doc) -> bool {
    d.transact().get_map(v4::ROOTS[9]).is_some()
}
pub(crate) fn project(d: &Doc, stable: bool) -> v3::Result<v3::View> {
    if !is_editor(d) {
        return v3::project(d);
    }
    Ok(ownership_view(view(d, stable)?))
}
fn inherited_owners(view: &v4::View) -> std::collections::BTreeMap<String, String> {
    view.retained
        .iter()
        .filter_map(|(id, value)| {
            let Any::Array(a) = value else { return None };
            if a.first() == Some(&Any::from("split"))
                && view.outcomes.get(id).is_some_and(|v| v == "applied")
            {
                if let Some(Any::String(left)) = a.get(1) {
                    return Some((id.clone(), left.to_string()));
                }
            }
            None
        })
        .collect()
}
fn ownership_view(view: v4::View) -> v3::View {
    let inherited = inherited_owners(&view);
    v3::View {
        owners: view
            .owners
            .into_iter()
            .map(|o| v3::Owner {
                id: o.id,
                version: o.version,
                spans: o
                    .spans
                    .into_iter()
                    .map(|s| v3::Span {
                        source: s.source,
                        start: s.start,
                        end: s.end,
                    })
                    .collect(),
                deleted: o.deleted,
                attrs: o.attrs,
            })
            .collect(),
        outcomes: view.outcomes,
        retained: view.retained,
        sources: view.sources,
        inherited,
    }
}
// Projection retains its structural view; copy only fields used by ownership.
fn borrowed_ownership_view(view: &v4::View) -> v3::View {
    let inherited = inherited_owners(view);
    v3::View {
        owners: view
            .owners
            .iter()
            .map(|o| v3::Owner {
                id: o.id.clone(),
                version: o.version.clone(),
                spans: o
                    .spans
                    .iter()
                    .map(|s| v3::Span {
                        source: s.source.clone(),
                        start: s.start,
                        end: s.end,
                    })
                    .collect(),
                deleted: o.deleted,
                attrs: o.attrs.clone(),
            })
            .collect(),
        outcomes: view.outcomes.clone(),
        retained: view.retained.clone(),
        sources: view.sources.clone(),
        inherited,
    }
}
/// One qualified replay supplies all projection representations. No writes can
/// occur between replay and serialization: the caller holds an immutable Doc.
pub(crate) fn projection(d: &Doc, stable: bool) -> v3::Result<(v3::View, Any, Option<v4::View>)> {
    if !is_editor(d) {
        return Ok((v3::project(d)?, v3::snapshot(d)?, None));
    }
    let (view, retained) = if stable {
        let view = v5::project(d)?;
        let retained = v5::snapshot_from_borrowed_view(d, &view)?;
        (stable_view(view), retained)
    } else {
        let view = v4::project(d)?;
        let retained = v4::snapshot_from_view(d, view.clone())?;
        (view, retained)
    };
    Ok((borrowed_ownership_view(&view), retained, Some(view)))
}
#[cfg(test)]
fn snapshot(d: &Doc, stable: bool) -> v3::Result<Any> {
    if is_editor(d) {
        if stable {
            v5::snapshot(d)
        } else {
            v4::snapshot(d)
        }
    } else {
        v3::snapshot(d)
    }
}

/// Dispatch only from the caller's admitted envelope. Roots do not encode v4/v5.
pub(crate) fn view(d: &Doc, stable: bool) -> v4::Result<v4::View> {
    if !stable {
        return v4::project(d);
    }
    Ok(stable_view(v5::project(d)?))
}
fn stable_view(v: v5::View) -> v4::View {
    v4::View {
        owners: v
            .owners
            .into_iter()
            .map(|o| v4::Owner {
                id: o.id,
                version: o.version,
                parent: o.parent,
                kind: o.kind,
                spans: o
                    .spans
                    .into_iter()
                    .map(|s| v4::Span {
                        source: s.source,
                        start: s.start,
                        end: s.end,
                    })
                    .collect(),
                deleted: o.deleted,
                attrs: o.attrs,
            })
            .collect(),
        outcomes: v.outcomes,
        retained: v.retained,
        sources: v.sources,
    }
}
pub(crate) fn split(
    d: &Doc,
    stable: bool,
    op: &str,
    left: &str,
    index: usize,
    offset: u32,
) -> v4::Result<()> {
    if stable {
        v5::split(d, op, left, index, offset)
    } else {
        v4::split(d, op, left, index, offset)
    }
}
pub(crate) fn join(d: &Doc, stable: bool, op: &str, left: &str, right: &str) -> v4::Result<()> {
    if stable {
        v5::join(d, op, left, right)
    } else {
        v4::join(d, op, left, right)
    }
}
pub(crate) fn place(
    d: &Doc,
    stable: bool,
    op: &str,
    target: &str,
    parent: &str,
    before: Option<&str>,
) -> v4::Result<()> {
    if stable {
        v5::place(d, op, target, parent, before)
    } else {
        v4::place(d, op, target, parent, before)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Map, Text};

    fn equivalent(d: &Doc, stable: bool) {
        let (owners, retained, structural) = projection(d, stable).unwrap();
        assert_eq!(owners, project(d, stable).unwrap());
        assert_eq!(retained, snapshot(d, stable).unwrap());
        assert_eq!(structural, Some(view(d, stable).unwrap()));
    }

    fn replay_equivalence(d: Doc, stable: bool) {
        // The independent qualified seed includes nested lists, ordered/check
        // metadata, unknown marks, Unicode, and non-text blocks.
        equivalent(&d, stable);
        let owner = view(&d, stable)
            .unwrap()
            .owners
            .into_iter()
            .find(|o| !o.deleted && !o.spans.is_empty())
            .unwrap();
        let source = &owner.spans[0].source;
        let text = v4::text(&d, source);
        {
            let mut txn = d.transact_mut();
            text.insert(&mut txn, 0, "😀");
        }
        equivalent(&d, stable);
        split(&d, stable, "o:91:1", &owner.id, 0, 2).unwrap();
        equivalent(&d, stable);
        let peer = if stable {
            v5::fork(&d, 92)
        } else {
            v4::fork(&d, 92)
        };
        equivalent(&peer, stable);
        // Invalid replay must still reject, with no partially admitted tuple.
        {
            let mut txn = peer.transact_mut();
            txn.get_map(v4::ROOTS[4])
                .unwrap()
                .insert(&mut txn, source.as_str(), Any::Null);
        }
        assert!(projection(&peer, stable).is_err());
        assert!(project(&peer, stable).is_err());
    }

    #[test]
    fn v4_single_replay_matches_qualified_representations() {
        replay_equivalence(v4::seed(), false);
    }

    #[test]
    fn v5_single_replay_matches_qualified_representations() {
        replay_equivalence(v5::seed(), true);
    }
}
