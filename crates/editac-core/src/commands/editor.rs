//! Shared v4 primitives. Higher-level list/block/move/history policies have
//! separate acceptance gates; all plans here stage the entire batch first.
use super::text::{TextError, TextOrigin};
use crate::{
    document::{Document, DocumentError, DocumentIdentity, MAX_RESTORE_BYTES, ReplayUpdate},
    editor_mapping as m,
};
use std::collections::VecDeque;
use yrs::{Any, Map, ReadTxn, Transact, XmlTextPrelim};

#[derive(Clone, Debug)]
pub enum EditorCommand {
    /// Higher-level list policy expands only on the disposable prepared replica.
    List(super::lists::ListCommand),
    BlockCommand(super::blocks::BlockCommand),
    Move(super::r#move::MoveCommand),
    Text(super::text::TextCommand),
    Split {
        owner: String,
        at: crate::anchors::Anchor,
    },
    Join {
        first: String,
        second: String,
    },
    Create {
        id: String,
        kind: String,
        text: String,
        tuple: Any,
    },
    Place {
        target: String,
        parent: String,
        before: Option<String>,
    },
    Block {
        target: String,
        tuple: Any,
    },
    Container {
        target: String,
        tuple: Any,
    },
    Check {
        target: String,
        checked: bool,
    },
    Enable {
        target: String,
        enabled: bool,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditorError {
    UnsupportedProfile,
    UnsupportedTarget,
    /// Current v4 replay would invalidate existing ownership after metadata change.
    PresentationConflict,
    InvalidCommand,
    ResourceLimit,
    Move(super::r#move::MoveRejection),
    Text(TextError),
    Admission(DocumentError),
}
pub struct PreparedEditorEdit {
    identity: DocumentIdentity,
    writer: u32,
    revision: u64,
    baseline: Vec<u8>,
    update: Vec<u8>,
    origin: TextOrigin,
    next_operation: u32,
}
pub struct EditorCommit {
    pub revision: u64,
    pub origin: TextOrigin,
    pub update: ReplayUpdate,
}
fn error(e: &str) -> EditorError {
    match e {
        "resource-limit" => EditorError::ResourceLimit,
        "unsupported-target" => EditorError::UnsupportedTarget,
        _ => EditorError::InvalidCommand,
    }
}
fn tag(a: &Any) -> &str {
    match a {
        Any::Array(v) => match v.first() {
            Some(Any::String(s)) => s,
            _ => "",
        },
        _ => "",
    }
}
fn target(d: &yrs::Doc, stable: bool, id: &str) -> Result<m::Owner, EditorError> {
    crate::editor::view(d, stable)
        .map_err(error)?
        .owners
        .into_iter()
        .find(|o| o.id == id && !o.deleted)
        .ok_or(EditorError::UnsupportedTarget)
}
fn register(
    d: &yrs::Doc,
    writer: u32,
    id: &str,
    kind: &str,
    text: &str,
    tuple: &Any,
) -> Result<(), EditorError> {
    let prefix = if kind == "block" {
        "n"
    } else if matches!(kind, "list" | "quote") {
        "c"
    } else {
        return Err(EditorError::UnsupportedTarget);
    };
    let (w, counter) = m::id(id, prefix).map_err(error)?;
    let t = d.transact();
    let kinds = t.get_map(m::ROOTS[0]).unwrap();
    let max = kinds
        .keys(&t)
        .filter_map(|s| m::id(s, prefix).ok())
        .filter(|(w, _)| *w == writer)
        .map(|(_, c)| c)
        .max()
        .unwrap_or(0);
    if w != writer
        || counter <= max
        || kinds.contains_key(&t, id)
        || (prefix == "c" && !text.is_empty())
    {
        return Err(EditorError::InvalidCommand);
    }
    if (kind == "block" && !matches!(tag(tuple), "paragraph" | "heading" | "code" | "separator"))
        || (kind == "quote" && tag(tuple) != "quote")
        || (kind == "list" && !matches!(tag(tuple), "ordered" | "unordered" | "checklist"))
    {
        return Err(EditorError::UnsupportedTarget);
    }
    if kind == "block" && tag(tuple) == "separator" && !text.is_empty() {
        return Err(EditorError::InvalidCommand);
    }
    drop(t);
    let mut t = d.transact_mut_with("prepare:editor");
    t.get_map(m::ROOTS[0]).unwrap().insert(&mut t, id, kind);
    t.get_map(m::ROOTS[2]).unwrap().insert(
        &mut t,
        id,
        m::arr(vec![Any::from("@root"), Any::from(0u32)]),
    );
    if kind == "block" {
        t.get_map(m::ROOTS[1])
            .unwrap()
            .insert(&mut t, id, XmlTextPrelim::new(text));
        t.get_map(m::ROOTS[6]).unwrap().insert(&mut t, id, true);
    }
    t.get_map(m::ROOTS[if kind == "block" { 4 } else { 7 }])
        .unwrap()
        .insert(&mut t, id, tuple.clone());
    Ok(())
}
impl Document {
    /// Suggest the next retained namespace ID; reservation occurs only on commit.
    pub fn next_editor_id(&self, container: bool) -> Result<String, EditorError> {
        if !self.identity().has_editor() {
            return Err(EditorError::UnsupportedProfile);
        }
        let prefix = if container { "c" } else { "n" };
        let t = self.read();
        let max = t
            .get_map(m::ROOTS[0])
            .unwrap()
            .keys(&t)
            .filter_map(|s| m::id(s, prefix).ok())
            .filter(|(w, _)| *w == self.writer_id())
            .map(|(_, c)| c)
            .max()
            .unwrap_or(0);
        Ok(format!(
            "{prefix}:{}:{}",
            self.writer_id(),
            max.checked_add(1).ok_or(EditorError::ResourceLimit)?
        ))
    }
    pub fn can_editor(
        &self,
        commands: &[EditorCommand],
        origin: &TextOrigin,
    ) -> Result<(), EditorError> {
        self.prepare_editor(commands, origin).map(|_| ())
    }
    pub fn prepare_editor(
        &self,
        commands: &[EditorCommand],
        origin: &TextOrigin,
    ) -> Result<PreparedEditorEdit, EditorError> {
        if !self.identity().has_editor() {
            return Err(EditorError::UnsupportedProfile);
        }
        if commands.len() > 4096 {
            return Err(EditorError::ResourceLimit);
        }
        let stable = self.identity().has_stable_presentation();
        let baseline = self.checkpoint().bytes;
        let stage = m::replica(self.writer_id() as u64);
        m::apply(&stage, &baseline).map_err(error)?;
        let sv = stage.transact().state_vector();
        let mut counter = self.next_structure_counter;
        let mut last_separator = None;
        let mut pending: VecDeque<_> = commands.to_vec().into();
        let mut expanded = 0usize;
        while let Some(c) = pending.pop_front() {
            expanded += 1;
            if expanded > 16384 {
                return Err(EditorError::ResourceLimit);
            }
            match &c {
                EditorCommand::Move(command) => {
                    let step = super::r#move::expand(&stage, stable, command)?;
                    pending.push_front(step);
                }
                EditorCommand::List(command) => {
                    let steps =
                        super::lists::expand(&stage, self.identity(), self.writer_id(), command)?;
                    for step in steps.into_iter().rev() {
                        pending.push_front(step);
                    }
                }
                EditorCommand::BlockCommand(command) => {
                    let steps =
                        super::blocks::expand(&stage, self.identity(), self.writer_id(), command)?;
                    for step in steps.into_iter().rev() {
                        pending.push_front(step);
                    }
                }
                EditorCommand::Text(command) => {
                    // Reuse the exact text preparation path on disposable state. Its
                    // plans cannot notify live observers or reserve live identities.
                    let checkpoint = crate::document::InitializedCheckpoint {
                        identity: self.identity().clone(),
                        initialized: true,
                        writer_id: self.writer_id(),
                        bytes: m::bytes(&stage),
                    };
                    let text_stage = Document::restore(self.identity(), &checkpoint, &[])
                        .map_err(EditorError::Admission)?;
                    let plan = text_stage
                        .prepare_text(command, origin)
                        .map_err(EditorError::Text)?;
                    super::text::apply_prepared_to_stage(&stage, plan);
                }
                EditorCommand::Split { owner, at } => {
                    let snapshot =
                        crate::projection::ProjectionIndex::with_identity(&stage, self.identity())
                            .read()
                            .map_err(|_| EditorError::InvalidCommand)?;
                    let node = snapshot
                        .visible
                        .iter()
                        .find(|n| n.id == *owner)
                        .ok_or(EditorError::UnsupportedTarget)?;
                    if node.kind != "block"
                        || !matches!(
                            node.block_attributes,
                            Some(
                                crate::document::BlockAttributes::Paragraph
                                    | crate::document::BlockAttributes::Heading(_)
                                    | crate::document::BlockAttributes::Code(_)
                            )
                        )
                    {
                        return Err(EditorError::UnsupportedTarget);
                    }
                    let selected = crate::projection::Snapshot {
                        visible: vec![node.clone()],
                        ..Default::default()
                    };
                    let p = super::text::position(crate::anchors::resolve(
                        &stage.transact(),
                        self.identity(),
                        &selected,
                        at,
                    ))
                    .map_err(EditorError::Text)?;
                    let o = target(&stage, stable, owner)?;
                    let mut base = 0;
                    let mut candidates = vec![];
                    for (i, span) in o.spans.iter().enumerate() {
                        if span.source == p.source
                            && span.start <= p.source_offset.0
                            && p.source_offset.0 <= span.end
                            && base + p.source_offset.0 - span.start == p.offset.0
                        {
                            candidates.push(i);
                        }
                        base += span.end - span.start;
                    }
                    let index = if p.bias == crate::anchors::Bias::Left {
                        candidates.first()
                    } else {
                        candidates.last()
                    }
                    .ok_or(EditorError::InvalidCommand)?;
                    let op = format!("o:{}:{counter}", self.writer_id());
                    counter = counter.checked_add(1).ok_or(EditorError::ResourceLimit)?;
                    crate::editor::split(&stage, stable, &op, owner, *index, p.source_offset.0)
                        .map_err(error)?;
                }
                EditorCommand::Join { first, second } => {
                    let op = format!("o:{}:{counter}", self.writer_id());
                    counter = counter.checked_add(1).ok_or(EditorError::ResourceLimit)?;
                    for id in [first, second] {
                        let o = target(&stage, stable, id)?;
                        if o.kind != "block"
                            || !matches!(tag(&o.attrs), "paragraph" | "heading" | "code")
                        {
                            return Err(EditorError::UnsupportedTarget);
                        }
                    }
                    crate::editor::join(&stage, stable, &op, first, second).map_err(error)?;
                }
                EditorCommand::Create {
                    id,
                    kind,
                    text,
                    tuple,
                } => {
                    if text.len() > 1048576 {
                        return Err(EditorError::ResourceLimit);
                    }
                    register(&stage, self.writer_id(), id, kind, text, tuple)?;
                    if tag(tuple) == "separator" {
                        last_separator = Some(id.clone());
                    }
                }
                EditorCommand::Place {
                    target,
                    parent,
                    before,
                } => {
                    let op = format!("o:{}:{counter}", self.writer_id());
                    counter = counter.checked_add(1).ok_or(EditorError::ResourceLimit)?;
                    crate::editor::place(&stage, stable, &op, target, parent, before.as_deref())
                        .map_err(error)?;
                }
                EditorCommand::Block { target: id, tuple } => {
                    let o = target(&stage, stable, id)?;
                    if o.kind != "block"
                        || !matches!(
                            tag(&o.attrs),
                            "paragraph" | "heading" | "code" | "separator"
                        )
                        || !matches!(tag(tuple), "paragraph" | "heading" | "code" | "separator")
                    {
                        return Err(EditorError::UnsupportedTarget);
                    }
                    if tag(tuple) == "separator" && o.spans.iter().any(|s| s.end != s.start) {
                        return Err(EditorError::InvalidCommand);
                    }
                    m::set(&stage, 4, id, tuple.clone());
                    let after = target(&stage, stable, id)?;
                    // Presentation is metadata-only. Until the v4 contract can
                    // retain a join across compatibility changes, reject rather
                    // than silently exposing absorbed owners or changing spans.
                    if !stable
                        && (after.spans != o.spans
                            || after.version != o.version
                            || after.parent != o.parent)
                    {
                        return Err(EditorError::PresentationConflict);
                    }
                    if tag(tuple) == "separator" {
                        last_separator = Some(id.clone());
                    }
                }
                EditorCommand::Container { target: id, tuple } => {
                    let o = target(&stage, stable, id)?;
                    if !((o.kind == "quote" && tag(tuple) == "quote" && tag(&o.attrs) == "quote")
                        || (o.kind == "list"
                            && matches!(tag(&o.attrs), "unordered" | "ordered" | "checklist")
                            && matches!(tag(tuple), "unordered" | "ordered" | "checklist")))
                    {
                        return Err(EditorError::UnsupportedTarget);
                    }
                    m::set(&stage, 7, id, tuple.clone());
                }
                EditorCommand::Check {
                    target: id,
                    checked,
                } => {
                    let o = target(&stage, stable, id)?;
                    let p = target(&stage, stable, &o.parent)?;
                    if o.kind != "block"
                        || !matches!(tag(&o.attrs), "paragraph" | "heading" | "code")
                        || tag(&p.attrs) != "checklist"
                    {
                        return Err(EditorError::UnsupportedTarget);
                    }
                    m::set(
                        &stage,
                        8,
                        id,
                        m::arr(vec![Any::from("check"), Any::Bool(*checked)]),
                    );
                }
                EditorCommand::Enable {
                    target: id,
                    enabled,
                } => {
                    let t = stage.transact();
                    if !t.get_map(m::ROOTS[0]).unwrap().contains_key(&t, id)
                        && !t.get_map(m::ROOTS[5]).unwrap().contains_key(&t, id)
                    {
                        return Err(EditorError::UnsupportedTarget);
                    }
                    drop(t);
                    m::set(
                        &stage,
                        9,
                        id,
                        m::arr(vec![Any::from("enabled"), Any::Bool(*enabled)]),
                    );
                }
            }
            crate::editor::view(&stage, stable).map_err(error)?;
        }
        let view = crate::editor::view(&stage, stable).map_err(error)?;
        if let Some(last) = last_separator {
            if !view.owners.iter().any(|o| {
                !o.deleted
                    && o.kind == "block"
                    && matches!(tag(&o.attrs), "paragraph" | "heading" | "code")
            }) {
                let at = view
                    .owners
                    .iter()
                    .position(|o| o.id == last)
                    .ok_or(EditorError::UnsupportedTarget)?;
                let parent = &view.owners[at].parent;
                let before = view
                    .owners
                    .iter()
                    .skip(at + 1)
                    .find(|o| !o.deleted && o.parent == *parent)
                    .map(|o| o.id.as_str());
                let t = stage.transact();
                let max = t
                    .get_map(m::ROOTS[0])
                    .unwrap()
                    .keys(&t)
                    .filter_map(|s| m::id(s, "n").ok())
                    .filter(|(w, _)| *w == self.writer_id())
                    .map(|(_, c)| c)
                    .max()
                    .unwrap_or(0);
                drop(t);
                let id = format!(
                    "n:{}:{}",
                    self.writer_id(),
                    max.checked_add(1).ok_or(EditorError::ResourceLimit)?
                );
                register(
                    &stage,
                    self.writer_id(),
                    &id,
                    "block",
                    "",
                    &m::arr(vec![Any::from("paragraph")]),
                )?;
                let op = format!("o:{}:{counter}", self.writer_id());
                counter = counter.checked_add(1).ok_or(EditorError::ResourceLimit)?;
                crate::editor::place(&stage, stable, &op, &id, parent, before).map_err(error)?;
            }
        }
        crate::editor::view(&stage, stable).map_err(error)?;
        let hierarchy = crate::projection::ProjectionIndex::with_identity(&stage, self.identity())
            .read()
            .map_err(|_| EditorError::InvalidCommand)?;
        super::lists::validate_editor_hierarchy(&hierarchy, &[]).map_err(|e| {
            if matches!(
                e,
                super::lists::HierarchyError::ResourceLimit
                    | super::lists::HierarchyError::DepthLimit(_)
            ) {
                EditorError::ResourceLimit
            } else {
                EditorError::InvalidCommand
            }
        })?;
        crate::document::validate_immutable_structure(&self.doc, &stage, stable)
            .map_err(EditorError::Admission)?;
        if m::bytes(&stage).len() > MAX_RESTORE_BYTES {
            return Err(EditorError::ResourceLimit);
        }
        let update = stage.transact().encode_state_as_update_v1(&sv);
        Ok(PreparedEditorEdit {
            identity: self.identity().clone(),
            writer: self.writer_id(),
            revision: self.revision(),
            baseline,
            update,
            origin: origin.clone(),
            next_operation: counter,
        })
    }
    pub fn commit_editor(&mut self, plan: PreparedEditorEdit) -> Result<EditorCommit, EditorError> {
        if self.identity() != &plan.identity || self.writer_id() != plan.writer {
            return Err(EditorError::Text(TextError::WrongReplica));
        }
        if self.revision() != plan.revision || self.checkpoint().bytes != plan.baseline {
            return Err(EditorError::Text(TextError::StalePlan));
        }
        let revision = self
            .revision()
            .checked_add(1)
            .ok_or(EditorError::ResourceLimit)?;
        let update = crate::ownership::decode(&plan.update).map_err(error)?;
        let patch_before = self
            .patch_before()
            .map_err(|e| EditorError::Text(TextError::from(e)))?;
        self.history_begin(&plan.origin, false);
        self.doc
            .transact_mut_with(plan.origin.as_str())
            .apply_update(update)
            .expect("validated editor update");
        self.history_finish(plan.update.len());
        self.next_structure_counter = plan.next_operation;
        self.revision = revision;
        let commit = EditorCommit {
            revision,
            origin: plan.origin,
            update: ReplayUpdate {
                identity: self.identity().clone(),
                bytes: plan.update,
            },
        };
        self.patch_finish(
            patch_before,
            crate::patches::PatchOperation::Editor,
            commit.origin.as_str(),
            Some(commit.update.clone()),
        );
        Ok(commit)
    }
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use crate::document::{CreationPermit, InitialNode};
    use std::sync::{Arc, Mutex};
    use yrs::Origin;
    #[test]
    fn v4_whole_batch_preparation_is_silent_commit_is_one_origin_and_only_local_writer() {
        let identity = DocumentIdentity::v4(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa26",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb26",
        )
        .unwrap();
        let mut d = Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "".into(),
            }],
        )
        .unwrap();
        let id = d.snapshot().unwrap().visible[0].id.clone();
        let observed = Arc::new(Mutex::new(vec![]));
        let seen = observed.clone();
        d.doc
            .observe_update_v1("v4-origin", move |t, e| {
                seen.lock()
                    .unwrap()
                    .push((t.origin().cloned(), e.update.clone()))
            })
            .unwrap();
        let count = Arc::new(Mutex::new(0));
        let counted = count.clone();
        d.doc
            .observe_after_transaction("v4-count", move |_| *counted.lock().unwrap() += 1)
            .unwrap();
        *count.lock().unwrap() = 0;
        let origin = TextOrigin::new("v4:whole-batch").unwrap();
        let before = d.checkpoint().bytes;
        let invalid = [
            EditorCommand::Block {
                target: id.clone(),
                tuple: m::arr(vec![Any::from("separator")]),
            },
            EditorCommand::Block {
                target: "missing".into(),
                tuple: m::arr(vec![Any::from("paragraph")]),
            },
        ];
        assert!(d.prepare_editor(&invalid, &origin).is_err());
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        let p = d
            .prepare_editor(
                &[EditorCommand::Block {
                    target: id,
                    tuple: m::arr(vec![Any::from("separator")]),
                }],
                &origin,
            )
            .unwrap();
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        d.commit_editor(p).unwrap();
        assert_eq!(*count.lock().unwrap(), 1);
        let updates = observed.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, Some(Origin::from(origin.as_str())));
        assert_eq!(
            d.read()
                .state_vector()
                .iter()
                .map(|(id, _)| id.get() as u32)
                .collect::<Vec<_>>(),
            vec![d.writer_id()]
        );
    }
    #[test]
    fn v4_block_text_batch_is_silent_and_commits_once_with_only_local_writer() {
        let identity = DocumentIdentity::v4(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa27",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb27",
        )
        .unwrap();
        let mut d = Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "".into(),
            }],
        )
        .unwrap();
        let id = d.snapshot().unwrap().visible[0].id.clone();
        let observed = Arc::new(Mutex::new(vec![]));
        let seen = observed.clone();
        d.doc
            .observe_update_v1("v4-origin", move |t, e| {
                seen.lock()
                    .unwrap()
                    .push((t.origin().cloned(), e.update.clone()))
            })
            .unwrap();
        let count = Arc::new(Mutex::new(0));
        let counted = count.clone();
        d.doc
            .observe_after_transaction("v4-count", move |_| *counted.lock().unwrap() += 1)
            .unwrap();
        *count.lock().unwrap() = 0;
        let origin = TextOrigin::new("v4:whole-batch").unwrap();
        let before = d.checkpoint().bytes;
        let invalid = [
            EditorCommand::Block {
                target: id.clone(),
                tuple: m::arr(vec![Any::from("separator")]),
            },
            EditorCommand::Block {
                target: "missing".into(),
                tuple: m::arr(vec![Any::from("paragraph")]),
            },
        ];
        assert!(d.prepare_editor(&invalid, &origin).is_err());
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        let at = d
            .anchor(&id, crate::Utf16Offset(0), crate::anchors::Bias::Right)
            .unwrap();
        let p = d
            .prepare_blocks(
                &[
                    super::super::blocks::BlockCommand::SetCode {
                        owner: id.clone(),
                        language: "rust".into(),
                    },
                    super::super::blocks::BlockCommand::Text(
                        super::super::text::TextCommand::Insert {
                            at: at.clone(),
                            text: "literal".into(),
                        },
                    ),
                    super::super::blocks::BlockCommand::HardBreak { at },
                    super::super::blocks::BlockCommand::InsertSeparator {
                        beside: id,
                        side: super::super::blocks::Side::After,
                    },
                ],
                &origin,
            )
            .unwrap();
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        d.commit_editor(p).unwrap();
        assert_eq!(*count.lock().unwrap(), 1);
        let updates = observed.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, Some(Origin::from(origin.as_str())));
        assert_eq!(
            d.read()
                .state_vector()
                .iter()
                .map(|(id, _)| id.get() as u32)
                .collect::<Vec<_>>(),
            vec![d.writer_id()]
        );
    }
    #[test]
    fn v5_witnessed_cross_source_literal_conversion_is_silent_then_commits_once() {
        use super::super::blocks::BlockCommand;
        use super::super::text::TextCommand;
        use crate::Utf16Offset;
        use crate::anchors::{Bias, Selection};
        let identity = DocumentIdentity::v5(
            "cccccccc-cccc-4ccc-8ccc-cccccccccc55",
            "dddddddd-dddd-4ddd-8ddd-dddddddddd55",
        )
        .unwrap();
        let mut d = Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[
                InitialNode {
                    kind: "block".into(),
                    text: "ab".into(),
                },
                InitialNode {
                    kind: "block".into(),
                    text: "cd".into(),
                },
            ],
        )
        .unwrap();
        let snapshot = d.snapshot().unwrap();
        let a = snapshot.visible[0].id.clone();
        let b = snapshot.visible[1].id.clone();
        let selection = Selection {
            anchor: d.anchor(&a, Utf16Offset(1), Bias::Right).unwrap(),
            focus: d.anchor(&b, Utf16Offset(1), Bias::Left).unwrap(),
        };
        let origin = TextOrigin::new("v5:whole-witnessed-batch").unwrap();
        let observed = Arc::new(Mutex::new(vec![]));
        let seen = observed.clone();
        d.doc
            .observe_update_v1("v5-origin", move |t, e| {
                seen.lock()
                    .unwrap()
                    .push((t.origin().cloned(), e.update.clone()))
            })
            .unwrap();
        let count = Arc::new(Mutex::new(0));
        let counted = count.clone();
        d.doc
            .observe_after_transaction("v5-count", move |_| *counted.lock().unwrap() += 1)
            .unwrap();
        *count.lock().unwrap() = 0;
        let commands = [
            BlockCommand::SetCode {
                owner: a.clone(),
                language: "rs".into(),
            },
            BlockCommand::SetCode {
                owner: b.clone(),
                language: "rs".into(),
            },
            BlockCommand::Join {
                first: a.clone(),
                second: b,
            },
            BlockCommand::Text(TextCommand::Replace {
                selection,
                text: "\n\n".into(),
            }),
            BlockCommand::SetParagraph { owner: a.clone() },
        ];
        let before = d.checkpoint().bytes;
        let mut bad = commands.to_vec();
        bad.push(BlockCommand::SetCode {
            owner: a.clone(),
            language: "invalid space".into(),
        });
        assert!(d.prepare_blocks(&bad, &origin).is_err());
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        let plan = d.prepare_blocks(&commands, &origin).unwrap();
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(*count.lock().unwrap(), 0);
        assert!(observed.lock().unwrap().is_empty());
        d.commit_blocks(plan).unwrap();
        assert_eq!(*count.lock().unwrap(), 1);
        let updates = observed.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, Some(Origin::from(origin.as_str())));
        let n = d
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| n.id == a)
            .unwrap();
        assert_eq!(n.spans.len(), 2);
        assert_eq!(
            n.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
            "a\n\nd"
        );
        assert!(
            n.runs
                .iter()
                .filter(|r| r.text.contains('\n'))
                .all(|r| r.attributes.is_empty())
        );
        assert_eq!(
            d.read()
                .state_vector()
                .iter()
                .map(|(id, _)| id.get() as u32)
                .collect::<Vec<_>>(),
            vec![d.writer_id()]
        );
    }
}
