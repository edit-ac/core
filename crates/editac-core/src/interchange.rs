//! Bounded semantic fragment JSON interchange. No parser or writable document.
use crate::{
    anchors::{Bias, Resolution},
    document::DocumentIdentity,
};
use crate::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
        lists::ContainerStyle,
    },
    document::BlockAttributes,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yrs::Any;
const MAX_REQUEST: usize = 2 * 1024 * 1024;
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub operation: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Error>;
#[inline(never)]
pub fn err(code: &'static str, operation: &'static str, message: impl Into<String>) -> Error {
    Error {
        code,
        operation,
        message: message.into(),
    }
}
pub fn kernel(operation: &'static str, e: impl std::fmt::Debug) -> Error {
    err("EngineRejected", operation, format!("{e:?}"))
}
pub fn parse<T: DeserializeOwned>(s: &str, op: &'static str) -> Result<T> {
    if s.len() > MAX_REQUEST {
        return Err(err("ResourceLimit", op, "request exceeds byte limit"));
    }
    serde_json::from_str(s).map_err(|e| err("InvalidInput", op, e.to_string()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferBlock {
    runs: Vec<TransferRun>,
    attributes: Option<TransferAttributes>,
    #[serde(default)]
    containers: Vec<TransferContainer>,
    checked: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferContainer {
    key: String,
    style: Style,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferRun {
    text: String,
    marks: Vec<TransferMark>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferMark {
    mark: MarkName,
    href: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum TransferAttributes {
    Paragraph {},
    Heading { level: u8 },
    Code { language: String },
    Separator {},
    Content { tuple: Value },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Style {
    Unordered {},
    Ordered { start: u32 },
    Checklist {},
    Quote {},
}
impl Style {
    pub fn native(self) -> ContainerStyle {
        match self {
            Self::Unordered {} => ContainerStyle::Unordered,
            Self::Ordered { start } => ContainerStyle::Ordered { start },
            Self::Checklist {} => ContainerStyle::Checklist,
            Self::Quote {} => ContainerStyle::Quote,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkName {
    Bold,
    Italic,
    Strike,
    Underline,
    Code,
    Link,
}
impl MarkName {
    pub fn native(self) -> Mark {
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
pub fn transfer_blocks(blocks: Vec<TransferBlock>) -> Result<Vec<FragmentBlock>> {
    if blocks.len() > 128
        || blocks.iter().map(|b| b.runs.len()).sum::<usize>() > 1024
        || blocks
            .iter()
            .flat_map(|b| &b.runs)
            .map(|r| r.text.len())
            .sum::<usize>()
            > 1024 * 1024
        || blocks
            .iter()
            .any(|b| b.containers.len() > 16 || b.runs.iter().any(|r| r.marks.len() > 6))
    {
        return Err(err("ResourceLimit", "markdown", "fragment exceeds limits"));
    }
    let converted = blocks
        .into_iter()
        .map(|b| {
            Ok(FragmentBlock {
                containers: b
                    .containers
                    .into_iter()
                    .map(|c| (c.key, c.style.native()))
                    .collect(),
                checked: b.checked,
                runs: b
                    .runs
                    .into_iter()
                    .map(|r| FragmentRun {
                        text: r.text,
                        marks: r
                            .marks
                            .into_iter()
                            .map(|m| (m.mark.native(), m.href))
                            .collect(),
                    })
                    .collect(),
                attributes: b
                    .attributes
                    .map(|a| match a {
                        TransferAttributes::Paragraph {} => Ok(BlockAttributes::Paragraph),
                        TransferAttributes::Heading { level } => {
                            Ok(BlockAttributes::Heading(level))
                        }
                        TransferAttributes::Code { language } => {
                            Ok(BlockAttributes::Code(language))
                        }
                        TransferAttributes::Separator {} => Ok(BlockAttributes::Separator),
                        TransferAttributes::Content { tuple } => {
                            let a = Any::from_json(&tuple.to_string())
                                .map_err(|e| kernel("markdown", e))?;
                            let content = crate::modules::content::Content::from_tuple(&a)
                                .map_err(|e| kernel("markdown", e))?;
                            if content.is_none() {
                                return Err(err(
                                    "InvalidInput",
                                    "markdown",
                                    "unregistered content",
                                ));
                            }
                            Ok(BlockAttributes::Unknown(a))
                        }
                    })
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    crate::commands::fragment::validate(&converted).map_err(|e| kernel("markdown", e))?;
    Ok(converted)
}
pub fn transfer_value(b: &FragmentBlock) -> Value {
    let attributes = match &b.attributes {
        None => Value::Null,
        Some(BlockAttributes::Paragraph) => json!({"type":"paragraph"}),
        Some(BlockAttributes::Heading(level)) => json!({"type":"heading","level":level}),
        Some(BlockAttributes::Code(language)) => json!({"type":"code","language":language}),
        Some(BlockAttributes::Separator) => json!({"type":"separator"}),
        Some(BlockAttributes::Unknown(tuple)) => json!({"type":"content","tuple":value(tuple)}),
    };
    json!({"attributes":attributes,"checked":b.checked,
        "containers":b.containers.iter().map(|(key,style)| {
            let style=match style {ContainerStyle::Unordered=>json!({"type":"unordered"}),ContainerStyle::Checklist=>json!({"type":"checklist"}),ContainerStyle::Quote=>json!({"type":"quote"}),ContainerStyle::Ordered{start}=>json!({"type":"ordered","start":start})};
            json!({"key":key,"style":style})
        }).collect::<Vec<_>>(),
        "runs":b.runs.iter().map(|r|json!({"text":r.text,"marks":r.marks.iter().map(|(m,href)|{
            let name=match m {Mark::Bold=>"bold",Mark::Italic=>"italic",Mark::Strike=>"strike",Mark::Underline=>"underline",Mark::Code=>"code",Mark::Link=>"link"};json!({"mark":name,"href":href})
        }).collect::<Vec<_>>()})).collect::<Vec<_>>()})
}
pub fn value(a: &Any) -> Value {
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

// Shared read-only projection wire values. Native Session and engine use one format.
pub fn identity(i: &DocumentIdentity) -> Value {
    json!({"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,
        "protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding,"offsets":i.offsets})
}
pub fn projection_node(n: &crate::projection::ProjectedNode) -> Value {
    json!({
        "id":n.id, "kind":n.kind, "parent":n.parent, "order":n.order,
        "spans":n.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity,"start":s.start,"end":s.end})).collect::<Vec<_>>(),
        "runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),value(v))).collect::<BTreeMap<_,_>>()})).collect::<Vec<_>>(),
        "blockAttributes":n.block_attributes.as_ref().map(|b|value(&b.tuple())),
        "editor":n.editor.as_ref().map(|e|json!({"version":e.version,"containerAttributes":e.container_attributes.as_ref().map(value),"checked":e.checked,"number":e.number})),
    })
}

pub fn resolution(v: &Resolution) -> Value {
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

pub fn projection_patch(p: &crate::patches::Patch) -> Value {
    use crate::patches::NodePatch;
    json!({"version":p.version,"sequence":p.sequence,"revision":p.revision,
            "identity":identity(&p.identity),"writerId":p.writer_id,"operation":format!("{:?}",p.operation),"origin":p.origin,
            "changedNodes":p.changed_nodes,"changedSources":p.changed_sources,
            "nodes":p.nodes.iter().map(|n|match n {
                NodePatch::Visible(n)=>json!({"type":"visible","node":projection_node(n)}),
                NodePatch::Recovery(n)=>json!({"type":"recovery","node":projection_node(n)}),
                NodePatch::Removed(id)=>json!({"type":"removed","id":id}),
            }).collect::<Vec<_>>(),
            "touchedRanges":p.touched_ranges.iter().map(|r|json!({"source":r.source,"start":r.start,"newStart":r.new_start,"oldEnd":r.old_end,"newEnd":r.new_end})).collect::<Vec<_>>(),
            "selectionChanged":p.selection_changed,
            "selection":p.resolved_selection.as_ref().map(|r|match r { Ok(s)=>json!({"anchor":resolution(&s.anchor),"focus":resolution(&s.focus)}),Err(e)=>json!({"error":format!("{e:?}")}) }),
            "update":p.update.as_ref().map(|u|json!({"identity":identity(&u.identity),"bytes":u.bytes})),
            "projectionError":p.projection_error.as_ref().map(|e|format!("{e:?}")) })
}

pub fn projection_snapshot(doc: &crate::document::Document) -> Result<Value> {
    let s = doc.snapshot().map_err(|e| kernel("read", e))?;
    let i = doc.identity();
    Ok(
        json!({"revision":doc.revision(), "identity":{"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,"protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding,"offsets":i.offsets},
            "visible":s.visible.iter().map(|n|projection_node(n)).collect::<Vec<_>>(), "recovery":s.recovery.iter().map(|n|projection_node(n)).collect::<Vec<_>>(),
            "retainedStructure":s.retained_structure.as_ref().map(value),
            "changedNodes":s.changed_nodes, "touchedRanges":s.touched_ranges.iter().map(|r|json!({"source":r.source,"start":r.start,"newStart":r.new_start,"oldEnd":r.old_end,"newEnd":r.new_end})).collect::<Vec<_>>() }),
    )
}
