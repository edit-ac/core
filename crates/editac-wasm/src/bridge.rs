//! Bounded JSON boundary shared by native fixture proofs and the compiled bridge.
//! Every fallible parse/translation/preparation precedes a live commit.
use editac_core::{
    Utf16Offset,
    anchors::{Anchor, Bias, Resolution, Selection},
    commands::{
        blocks::{BlockCommand, Side},
        editor::{EditorCommand, PreparedEditorEdit},
        format::{BlockFormatCommand, FormatAction, FormatCommand, Mark, PreparedFormatBatch},
        lists::{ContainerStyle, ListCommand},
        r#move::{MoveCommand, MoveTarget},
        text::{PreparedTextEdit, TextCommand, TextOrigin},
    },
    document::{
        BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode,
        InitializedCheckpoint, MAX_RESTORE_BYTES, ReplayUpdate,
    },
    history::{HistoryConfig, HistoryGroup},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yrs::Any;

const MAX_REQUEST: usize = 2 * 1024 * 1024;
const MAX_PLANS: usize = 128;
const MAX_ANCHORS: usize = 4096;
#[derive(Debug, Serialize)]
pub(crate) struct Error {
    pub code: &'static str,
    pub operation: &'static str,
    pub message: String,
}
type Result<T> = std::result::Result<T, Error>;
fn err(code: &'static str, operation: &'static str, message: impl Into<String>) -> Error {
    Error {
        code,
        operation,
        message: message.into(),
    }
}
fn kernel(operation: &'static str, e: impl std::fmt::Debug) -> Error {
    err("EngineRejected", operation, format!("{e:?}"))
}
fn parse<T: DeserializeOwned>(s: &str, op: &'static str) -> Result<T> {
    if s.len() > MAX_REQUEST {
        return Err(err("ResourceLimit", op, "request exceeds byte limit"));
    }
    serde_json::from_str(s).map_err(|e| err("InvalidInput", op, e.to_string()))
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Identity {
    profile: String,
    schema: String,
    protocol_version: u32,
    update_encoding: u32,
    offsets: String,
    document_id: String,
    epoch: String,
}
impl Identity {
    fn kernel(&self) -> DocumentIdentity {
        DocumentIdentity {
            profile: self.profile.clone(),
            schema: self.schema.clone(),
            protocol_version: self.protocol_version,
            update_encoding: self.update_encoding,
            offsets: self.offsets.clone(),
            document_id: self.document_id.clone(),
            epoch: self.epoch.clone(),
        }
    }
    fn admitted_v5(&self, op: &'static str) -> Result<DocumentIdentity> {
        let expected =
            DocumentIdentity::v5(&self.document_id, &self.epoch).map_err(|e| kernel(op, e))?;
        if self.kernel() != expected {
            return Err(err("EngineRejected", op, "unsupported identity envelope"));
        }
        Ok(expected)
    }
}
fn identity(i: &DocumentIdentity) -> Value {
    json!({"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,
        "protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding,"offsets":i.offsets})
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Restore {
    expected: Identity,
    identity: Identity,
    initialized: bool,
    writer_id: u32,
    journal: Vec<WireUpdate>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireUpdate {
    identity: Identity,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    profile: Profile,
    document_id: String,
    epoch: String,
    nodes: Vec<Node>,
}
#[derive(Deserialize)]
enum Profile {
    #[serde(rename = "v5")]
    V5,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Affinity {
    Left,
    Right,
}
impl Affinity {
    fn bias(&self) -> Bias {
        match self {
            Self::Left => Bias::Left,
            Self::Right => Bias::Right,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    node: String,
    offset: u32,
    bias: Affinity,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    anchor: String,
    focus: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Prepare {
    Text {
        origin: String,
        command: TextRequest,
    },
    Editor {
        origin: String,
        commands: Vec<Command>,
    },
    Format {
        origin: String,
        marks: Vec<MarkRequest>,
        blocks: Vec<BlockRequest>,
    },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum TextRequest {
    Insert { at: String, text: String },
    Delete { range: Range },
    Replace { range: Range, text: String },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Insert {
        at: String,
        text: String,
    },
    Delete {
        range: Range,
    },
    Replace {
        range: Range,
        text: String,
    },
    Split {
        owner: String,
        at: String,
    },
    Join {
        first: String,
        second: String,
    },
    Wrap {
        targets: Vec<String>,
        style: Style,
    },
    SetStyle {
        container: String,
        style: Style,
    },
    SetChecked {
        owner: String,
        checked: bool,
    },
    Enter {
        owner: String,
        at: String,
    },
    Backspace {
        owner: String,
        at: String,
    },
    Indent {
        owner: String,
    },
    Outdent {
        owner: String,
    },
    Move {
        target: Target,
        parent: Target,
        before: Option<Target>,
    },
    SetCode {
        owner: String,
        language: String,
    },
    SetParagraph {
        owner: String,
    },
    HardBreak {
        at: String,
    },
    ConvertSeparator {
        owner: String,
    },
    InsertSeparator {
        beside: String,
        side: Edge,
    },
    InsertParagraph {
        separator: String,
        side: Edge,
        text: String,
    },
    DeleteSeparator {
        owner: String,
    },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Style {
    Unordered {},
    Ordered { start: u32 },
    Checklist {},
    Quote {},
}
impl Style {
    fn native(self) -> ContainerStyle {
        match self {
            Self::Unordered {} => ContainerStyle::Unordered,
            Self::Ordered { start } => ContainerStyle::Ordered { start },
            Self::Checklist {} => ContainerStyle::Checklist,
            Self::Quote {} => ContainerStyle::Quote,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    id: String,
    version: String,
}
impl Target {
    fn native(self) -> MoveTarget {
        MoveTarget {
            id: self.id,
            version: self.version,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Edge {
    Before,
    After,
}
impl Edge {
    fn native(self) -> Side {
        match self {
            Self::Before => Side::Before,
            Self::After => Side::After,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MarkName {
    Bold,
    Italic,
    Strike,
    Underline,
    Code,
    Link,
}
impl MarkName {
    fn native(self) -> Mark {
        match self {
            Self::Bold => Mark::Bold,
            Self::Italic => Mark::Italic,
            Self::Strike => Mark::Strike,
            Self::Underline => Mark::Underline,
            Self::Code => Mark::Code,
            Self::Link => Mark::Link,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Apply,
    Remove,
    Toggle,
}
impl Action {
    fn native(self) -> FormatAction {
        match self {
            Self::Apply => FormatAction::Apply,
            Self::Remove => FormatAction::Remove,
            Self::Toggle => FormatAction::Toggle,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkRequest {
    range: Range,
    mark: MarkName,
    action: Action,
    href: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Attributes {
    Paragraph {},
    Heading { level: u8 },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockRequest {
    targets: Vec<String>,
    attributes: Attributes,
    action: Action,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum HistoryRequest {
    State {},
    Undo {},
    Redo {},
    Clear {},
    Boundary {},
    Explicit {},
    Typing { session: u32, time_ms: u32 },
    Composition { session: u32 },
}
enum Plan {
    Text(PreparedTextEdit),
    Editor(PreparedEditorEdit),
    Format(PreparedFormatBatch),
}

pub(crate) struct Bridge {
    doc: Document,
    plans: BTreeMap<String, Plan>,
    anchors: BTreeMap<String, Anchor>,
    counter: u32,
    patch_sequence: u64,
}
impl Bridge {
    pub fn create(input: &str) -> Result<Self> {
        let c: Create = parse(input, "create")?;
        let _ = c.profile;
        let identity =
            DocumentIdentity::v5(c.document_id, c.epoch).map_err(|e| kernel("create", e))?;
        // Validate the whole creation request before reserving an identity.
        if c.nodes.len() > 4096
            || c.nodes
                .iter()
                .any(|n| n.text.encode_utf16().count() > 262144)
            || c.nodes.iter().map(|n| n.text.len()).sum::<usize>() > 1048576
        {
            return Err(err(
                "ResourceLimit",
                "create",
                "invalid initial content bounds",
            ));
        }
        let permit = CreationPermit::authorize_new(identity).map_err(|e| kernel("create", e))?;
        let nodes = c
            .nodes
            .into_iter()
            .map(|n| InitialNode {
                kind: "block".into(),
                text: n.text,
            })
            .collect::<Vec<_>>();
        let mut doc = Document::create(permit, &nodes).map_err(|e| kernel("create", e))?;
        doc.enable_history(HistoryConfig::default())
            .map_err(|e| kernel("create", e))?;
        Ok(Self {
            doc,
            plans: BTreeMap::new(),
            anchors: BTreeMap::new(),
            counter: 0,
            patch_sequence: 0,
        })
    }
    pub fn restore(input: &str, bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_RESTORE_BYTES {
            return Err(err(
                "ResourceLimit",
                "restore",
                "checkpoint exceeds byte limit",
            ));
        }
        let r: Restore = parse(input, "restore")?;
        if r.journal.len() > 4096 {
            return Err(err(
                "ResourceLimit",
                "restore",
                "journal exceeds entry limit",
            ));
        }
        let expected = r.expected.admitted_v5("restore")?;
        let checkpoint = InitializedCheckpoint {
            identity: r.identity.kernel(),
            initialized: r.initialized,
            writer_id: r.writer_id,
            bytes: bytes.to_vec(),
        };
        let journal = r
            .journal
            .into_iter()
            .map(|u| ReplayUpdate {
                identity: u.identity.kernel(),
                bytes: u.bytes,
            })
            .collect::<Vec<_>>();
        let mut doc = Document::restore(&expected, &checkpoint, &journal)
            .map_err(|e| kernel("restore", e))?;
        doc.enable_history(HistoryConfig::default())
            .map_err(|e| kernel("restore", e))?;
        Ok(Self {
            doc,
            plans: BTreeMap::new(),
            anchors: BTreeMap::new(),
            counter: 0,
            patch_sequence: 0,
        })
    }
    pub fn checkpoint_metadata(&self) -> Value {
        json!({"identity":identity(self.doc.identity()),"initialized":true,"writerId":self.doc.writer_id()})
    }
    pub fn checkpoint_bytes(&self) -> Vec<u8> {
        self.doc.checkpoint().bytes
    }
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.state_vector_v1()
    }
    pub fn update(&self, vector: &[u8]) -> Result<Vec<u8>> {
        self.doc
            .update_v1(vector)
            .map_err(|e| kernel("encodeUpdate", e))
    }
    pub fn apply(&mut self, input: &str, bytes: &[u8]) -> Result<Value> {
        if bytes.len() > MAX_RESTORE_BYTES {
            return Err(err(
                "ResourceLimit",
                "applyUpdate",
                "update exceeds byte limit",
            ));
        }
        let i: Identity = parse(input, "applyUpdate")?;
        // Kernel stages/admit-validates the complete corpus before any live write.
        self.doc
            .apply_replay(&ReplayUpdate {
                identity: i.kernel(),
                bytes: bytes.to_vec(),
            })
            .map_err(|e| kernel("applyUpdate", e))?;
        Ok(json!({"revision":self.doc.revision()}))
    }
    pub fn take_patch(&mut self) -> Value {
        let Some(p) = self.doc.last_patch() else {
            return Value::Null;
        };
        if p.sequence <= self.patch_sequence {
            return Value::Null;
        }
        self.patch_sequence = p.sequence;
        use editac_core::patches::NodePatch;
        json!({"version":p.version,"sequence":p.sequence,"revision":p.revision,
            "identity":identity(&p.identity),"writerId":p.writer_id,"operation":format!("{:?}",p.operation),"origin":p.origin,
            "changedNodes":p.changed_nodes,"changedSources":p.changed_sources,
            "nodes":p.nodes.iter().map(|n|match n {
                NodePatch::Visible(n)=>json!({"type":"visible","node":node(n)}),
                NodePatch::Recovery(n)=>json!({"type":"recovery","node":node(n)}),
                NodePatch::Removed(id)=>json!({"type":"removed","id":id}),
            }).collect::<Vec<_>>(),
            "touchedRanges":p.touched_ranges.iter().map(|r|json!({"source":r.source,"start":r.start,"newStart":r.new_start,"oldEnd":r.old_end,"newEnd":r.new_end})).collect::<Vec<_>>(),
            "selectionChanged":p.selection_changed,
            "selection":p.resolved_selection.as_ref().map(|r|match r { Ok(s)=>json!({"anchor":resolution(&s.anchor),"focus":resolution(&s.focus)}),Err(e)=>json!({"error":format!("{e:?}")}) }),
            "update":p.update.as_ref().map(|u|json!({"identity":identity(&u.identity),"bytes":u.bytes})),
            "projectionError":p.projection_error.as_ref().map(|e|format!("{e:?}")) })
    }
    fn token(&mut self, kind: &str) -> Result<String> {
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| err("ResourceLimit", "handle", "token counter exhausted"))?;
        Ok(format!("{}:{kind}:{}", self.doc.writer_id(), self.counter))
    }
    fn anchor_value(&self, id: &str) -> Result<Anchor> {
        self.anchors.get(id).cloned().ok_or_else(|| {
            err(
                "InvalidHandle",
                "anchor",
                "anchor is released or belongs to another engine",
            )
        })
    }
    fn selection(&self, r: Range) -> Result<Selection> {
        Ok(Selection {
            anchor: self.anchor_value(&r.anchor)?,
            focus: self.anchor_value(&r.focus)?,
        })
    }
    pub fn capture(&mut self, input: &str) -> Result<Value> {
        if self.anchors.len() >= MAX_ANCHORS {
            return Err(err("ResourceLimit", "anchor", "release unused anchors"));
        }
        let c: Capture = parse(input, "anchor")?;
        let a = self
            .doc
            .anchor(&c.node, Utf16Offset(c.offset), c.bias.bias())
            .map_err(|e| kernel("anchor", e))?;
        let token = self.token("anchor")?;
        self.anchors.insert(token.clone(), a);
        Ok(json!({"token": token}))
    }
    pub fn resolve(&self, token: &str) -> Result<Value> {
        let a = self.anchor_value(token)?;
        let v = self
            .doc
            .resolve_anchor(&a)
            .map_err(|e| kernel("resolve", e))?;
        Ok(match v {
            Resolution::Position(p) => {
                json!({"type":"position", "node":p.node, "offset":p.offset.0, "source":p.source, "sourceOffset":p.source_offset.0, "bias":if p.bias == Bias::Left {"left"} else {"right"}})
            }
            Resolution::Deleted { source, owner } => {
                json!({"type":"deleted", "source":source, "owner":owner})
            }
            Resolution::Unresolvable(e) => {
                json!({"type":"unresolvable", "reason":format!("{e:?}")})
            }
        })
    }
    pub fn release_anchor(&mut self, token: &str) {
        self.anchors.remove(token);
    }
    fn command(&self, c: Command) -> Result<EditorCommand> {
        Ok(match c {
            Command::Insert { at, text } => EditorCommand::Text(TextCommand::Insert {
                at: self.anchor_value(&at)?,
                text,
            }),
            Command::Delete { range } => EditorCommand::Text(TextCommand::Delete {
                selection: self.selection(range)?,
            }),
            Command::Replace { range, text } => EditorCommand::Text(TextCommand::Replace {
                selection: self.selection(range)?,
                text,
            }),
            Command::Split { owner, at } => EditorCommand::Split {
                owner,
                at: self.anchor_value(&at)?,
            },
            Command::Join { first, second } => EditorCommand::Join { first, second },
            Command::Wrap { targets, style } => EditorCommand::List(ListCommand::Wrap {
                targets,
                style: style.native(),
            }),
            Command::SetStyle { container, style } => EditorCommand::List(ListCommand::SetStyle {
                container,
                style: style.native(),
            }),
            Command::SetChecked { owner, checked } => {
                EditorCommand::List(ListCommand::SetChecked { owner, checked })
            }
            Command::Enter { owner, at } => EditorCommand::List(ListCommand::Enter {
                owner,
                at: self.anchor_value(&at)?,
            }),
            Command::Backspace { owner, at } => EditorCommand::List(ListCommand::Backspace {
                owner,
                at: self.anchor_value(&at)?,
            }),
            Command::Indent { owner } => EditorCommand::List(ListCommand::Indent { owner }),
            Command::Outdent { owner } => EditorCommand::List(ListCommand::Outdent { owner }),
            Command::Move {
                target,
                parent,
                before,
            } => EditorCommand::Move(MoveCommand {
                target: target.native(),
                parent: parent.native(),
                before: before.map(Target::native),
            }),
            Command::SetCode { owner, language } => {
                EditorCommand::BlockCommand(BlockCommand::SetCode { owner, language })
            }
            Command::SetParagraph { owner } => {
                EditorCommand::BlockCommand(BlockCommand::SetParagraph { owner })
            }
            Command::HardBreak { at } => EditorCommand::BlockCommand(BlockCommand::HardBreak {
                at: self.anchor_value(&at)?,
            }),
            Command::ConvertSeparator { owner } => {
                EditorCommand::BlockCommand(BlockCommand::ConvertSeparator { owner })
            }
            Command::InsertSeparator { beside, side } => {
                EditorCommand::BlockCommand(BlockCommand::InsertSeparator {
                    beside,
                    side: side.native(),
                })
            }
            Command::InsertParagraph {
                separator,
                side,
                text,
            } => EditorCommand::BlockCommand(BlockCommand::InsertParagraph {
                separator,
                side: side.native(),
                text,
            }),
            Command::DeleteSeparator { owner } => {
                EditorCommand::BlockCommand(BlockCommand::DeleteSeparator { owner })
            }
        })
    }
    pub fn prepare(&mut self, input: &str) -> Result<Value> {
        if self.plans.len() >= MAX_PLANS {
            return Err(err("ResourceLimit", "prepare", "release unused plans"));
        }
        let r: Prepare = parse(input, "prepare")?;
        let plan = match r {
            Prepare::Text { origin, command } => {
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let command = match command {
                    TextRequest::Insert { at, text } => TextCommand::Insert {
                        at: self.anchor_value(&at)?,
                        text,
                    },
                    TextRequest::Delete { range } => TextCommand::Delete {
                        selection: self.selection(range)?,
                    },
                    TextRequest::Replace { range, text } => TextCommand::Replace {
                        selection: self.selection(range)?,
                        text,
                    },
                };
                Plan::Text(
                    self.doc
                        .prepare_text(&command, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                )
            }
            Prepare::Editor { origin, commands } => {
                if commands.len() > 128 {
                    return Err(err("ResourceLimit", "prepare", "too many commands"));
                }
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let commands = commands
                    .into_iter()
                    .map(|c| self.command(c))
                    .collect::<Result<Vec<_>>>()?;
                Plan::Editor(
                    self.doc
                        .prepare_editor(&commands, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                )
            }
            Prepare::Format {
                origin,
                marks,
                blocks,
            } => {
                if marks.len().saturating_add(blocks.len()) > 128 {
                    return Err(err("ResourceLimit", "prepare", "too many format commands"));
                }
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let marks = marks
                    .into_iter()
                    .map(|m| {
                        Ok(FormatCommand {
                            selection: self.selection(m.range)?,
                            mark: m.mark.native(),
                            action: m.action.native(),
                            href: m.href,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let blocks = blocks
                    .into_iter()
                    .map(|b| BlockFormatCommand {
                        targets: b.targets,
                        attributes: match b.attributes {
                            Attributes::Paragraph {} => BlockAttributes::Paragraph,
                            Attributes::Heading { level } => BlockAttributes::Heading(level),
                        },
                        action: b.action.native(),
                    })
                    .collect::<Vec<_>>();
                Plan::Format(
                    self.doc
                        .prepare_format_batch(&marks, &blocks, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                )
            }
        };
        let token = self.token("plan")?;
        self.plans.insert(token.clone(), plan);
        Ok(json!({"token":token, "revision": self.doc.revision()}))
    }
    pub fn release_plan(&mut self, token: &str) {
        self.plans.remove(token);
    }
    pub fn commit(&mut self, token: &str) -> Result<Value> {
        let plan = self.plans.remove(token).ok_or_else(|| {
            err(
                "InvalidHandle",
                "commit",
                "plan is consumed, released or belongs to another engine",
            )
        })?;
        match plan {
            Plan::Text(p) => {
                self.doc.commit_text(p).map_err(|e| kernel("commit", e))?;
            }
            Plan::Editor(p) => {
                self.doc.commit_editor(p).map_err(|e| kernel("commit", e))?;
            }
            Plan::Format(p) => {
                self.doc.commit_format(p).map_err(|e| kernel("commit", e))?;
            }
        }
        Ok(json!({"revision":self.doc.revision()}))
    }
    pub fn history(&mut self, input: &str) -> Result<Value> {
        match parse::<HistoryRequest>(input, "history")? {
            HistoryRequest::State {} => {}
            HistoryRequest::Undo {} => {
                self.doc.undo().map_err(|e| kernel("history", e))?;
            }
            HistoryRequest::Redo {} => {
                self.doc.redo().map_err(|e| kernel("history", e))?;
            }
            HistoryRequest::Clear {} => self.doc.clear_history(),
            HistoryRequest::Boundary {} => self.doc.reset_history_group(),
            HistoryRequest::Explicit {} => self.doc.set_history_group(HistoryGroup::Explicit),
            HistoryRequest::Typing { session, time_ms } => {
                self.doc.set_history_group(HistoryGroup::Typing {
                    session: session.into(),
                    time_ms: time_ms.into(),
                })
            }
            HistoryRequest::Composition { session } => {
                self.doc.set_history_group(HistoryGroup::Composition {
                    session: session.into(),
                })
            }
        }
        let h = self.doc.history_state();
        Ok(
            json!({"revision":self.doc.revision(), "undoGroups":h.undo_groups, "redoGroups":h.redo_groups, "retainedUpdateBytes":h.retained_update_bytes}),
        )
    }
    #[cfg(test)]
    pub(super) fn doc_state(&self) -> (Vec<u8>, u64, editac_core::history::HistoryState) {
        (
            self.doc.checkpoint().bytes,
            self.doc.revision(),
            self.doc.history_state(),
        )
    }
    pub fn read(&self) -> Result<Value> {
        let s = self.doc.snapshot().map_err(|e| kernel("read", e))?;
        let i = self.doc.identity();
        Ok(
            json!({"revision":self.doc.revision(), "identity":{"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,"protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding,"offsets":i.offsets},
            "visible":s.visible.iter().map(|n|node(n)).collect::<Vec<_>>(), "recovery":s.recovery.iter().map(|n|node(n)).collect::<Vec<_>>(),
            "retainedStructure":s.retained_structure.as_ref().map(value),
            "changedNodes":s.changed_nodes, "touchedRanges":s.touched_ranges.iter().map(|r|json!({"source":r.source,"start":r.start,"newStart":r.new_start,"oldEnd":r.old_end,"newEnd":r.new_end})).collect::<Vec<_>>() }),
        )
    }
}
fn node(n: &editac_core::projection::ProjectedNode) -> Value {
    json!({
        "id":n.id, "kind":n.kind, "parent":n.parent, "order":n.order,
        "spans":n.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity,"start":s.start,"end":s.end})).collect::<Vec<_>>(),
        "runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),value(v))).collect::<BTreeMap<_,_>>()})).collect::<Vec<_>>(),
        "blockAttributes":n.block_attributes.as_ref().map(|b|value(&b.tuple())),
        "editor":n.editor.as_ref().map(|e|json!({"version":e.version,"containerAttributes":e.container_attributes.as_ref().map(value),"checked":e.checked,"number":e.number})),
    })
}

fn resolution(v: &Resolution) -> Value {
    match v {
        Resolution::Position(p) => {
            json!({"type":"position","node":p.node,"offset":p.offset.0,"source":p.source,"sourceOffset":p.source_offset.0,"bias":if p.bias==Bias::Left {"left"} else {"right"}})
        }
        Resolution::Deleted { source, owner } => {
            json!({"type":"deleted","source":source,"owner":owner})
        }
        Resolution::Unresolvable(e) => json!({"type":"unresolvable","reason":format!("{e:?}")}),
    }
}
fn value(a: &Any) -> Value {
    match a {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => json!(b),
        Any::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!(i)
            } else {
                json!(n)
            }
        }
        Any::String(s) => json!(s.as_ref()),
        Any::Array(a) => Value::Array(a.iter().map(value).collect()),
        Any::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), value(v))).collect()),
        Any::Buffer(b) => json!(b.as_ref()),
    }
}
