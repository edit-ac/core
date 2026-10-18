//! Qualification fixtures author captured checkpoints through the shared fragment API.
use super::fixture::{para, run};
use super::*;
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
    },
    document::BlockAttributes,
    modules::{
        assets::*,
        content::{Alignment, Content},
    },
};
const PNG: &[u8] = include_bytes!("../../../fixtures/formats/pdf/export/panels.png");
const FIXTURE: &str = include_str!("../../../fixtures/formats/pdf/export/structure.json");
fn rich_blocks() -> Vec<FragmentBlock> {
    use editac_core::{
        commands::{format::Mark, lists::ContainerStyle},
        document::BlockAttributes,
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/formats/pdf/export/rich.json"
    ))
    .unwrap();
    fixture["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| FragmentBlock {
            runs: b["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| FragmentRun {
                    opaque_marks: vec![],
                    text: r["text"].as_str().unwrap().into(),
                    marks: r["marks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| match m.as_str().unwrap() {
                            "bold" => (Mark::Bold, None),
                            "italic" => (Mark::Italic, None),
                            "underline" => (Mark::Underline, None),
                            "strike" => (Mark::Strike, None),
                            "code" => (Mark::Code, None),
                            "link" => (Mark::Link, Some(r["href"].as_str().unwrap().into())),
                            _ => panic!(),
                        })
                        .collect(),
                })
                .collect(),
            attributes: b
                .get("heading")
                .map(|h| BlockAttributes::Heading(h.as_u64().unwrap() as u8)),
            containers: b.get("path").map_or(vec![], |p| {
                p.as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        (
                            c[0].as_str().unwrap().into(),
                            if c[1].is_null() {
                                ContainerStyle::Unordered
                            } else {
                                ContainerStyle::Ordered {
                                    start: c[1].as_u64().unwrap() as u32,
                                }
                            },
                        )
                    })
                    .collect()
            }),
            checked: None,
        })
        .collect()
}

fn image(bytes: &[u8]) -> AssetDescriptor {
    AssetDescriptor {
        identity: AssetIdentity {
            host: "local".into(),
            key: "pdf-panels".into(),
        },
        kind: AssetKind::Image,
        metadata: AssetMetadata {
            filename: "panels.png".into(),
            media_type: "image/png".into(),
            byte_length: Some(bytes.len() as u64),
            sha256: Some(format!("{:x}", Sha256::digest(bytes))),
            width: Some(120),
            height: Some(60),
            duration_ms: None,
            alt: "Red, green and blue vertical panels".into(),
            caption: "Original authorized color panels".into(),
        },
        fallback: "[original color panels]".into(),
        source: "inert original image source".into(),
    }
}
fn atom(c: Content) -> FragmentBlock {
    let text = c.asset_fallback().unwrap_or("").to_string();
    FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text,
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(c.tuple().unwrap())),
        containers: vec![],
        checked: None,
    }
}
fn table(rows: Vec<Vec<Vec<FragmentRun>>>, alignments: Vec<Alignment>) -> FragmentBlock {
    atom(Content::Table {
        rows,
        alignments,
        source: "inert table source".into(),
    })
}
fn content() -> Vec<FragmentBlock> {
    let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let rows = f["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            row.as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    vec![FragmentRun {
                        opaque_marks: vec![],
                        text: c["text"].as_str().unwrap().into(),
                        marks: if c["marks"].as_array().unwrap().is_empty() {
                            vec![]
                        } else {
                            vec![(Mark::Bold, None)]
                        },
                    }]
                })
                .collect()
        })
        .collect();
    vec![
        para(vec![run("Before table", vec![])]),
        table(rows, vec![Alignment::Left, Alignment::Center]),
        atom(Content::Asset {
            descriptor: image(PNG),
        }),
        para(vec![run("After original image", vec![])]),
    ]
}

pub fn blocks(kind: &str) -> Vec<FragmentBlock> {
    match kind {
        "pdf-rich" => rich_blocks(),
        "pdf-structure" => content(),
        "pdf-loss" => vec![FragmentBlock {
            attributes: Some(BlockAttributes::Code("rust".into())),
            ..para(vec![run("unsupported code block", vec![])])
        }],
        "pdf-overflow" => (0..200)
            .map(|n| {
                para(vec![run(
                    &format!("Paragraph {n}: page budget is finite."),
                    vec![],
                )])
            })
            .collect(),
        _ => serde_json::from_str::<Vec<String>>(include_str!(
            "../../../fixtures/formats/pdf/export/text.json"
        ))
        .unwrap()
        .iter()
        .map(|s| para(vec![run(s, vec![])]))
        .collect(),
    }
}

/// Text qualification starts with an actual shared initialized Session, exactly
/// like the original PDF fixture. This does not exercise an unrelated import path.
pub fn initial_checkpoint(kind: &str) -> Value {
    let texts: Vec<String> = if kind == "pdf-overflow" {
        (0..200)
            .map(|n| format!("Paragraph {n}: page budget is finite."))
            .collect()
    } else {
        serde_json::from_str(include_str!(
            "../../../fixtures/formats/pdf/export/text.json"
        ))
        .unwrap()
    };
    let id = DocumentIdentity::v5(
        "27000000-0000-4000-8000-000000000099",
        "27000000-0000-4000-8000-000000000000",
    )
    .unwrap();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let nodes = texts
        .iter()
        .map(|text| InitialNode {
            kind: "block".into(),
            text: text.clone(),
        })
        .collect::<Vec<_>>();
    let o = ConversionOwner::create(store, id.clone(), &nodes, HostPolicy::default()).unwrap();
    let cp = o.service().session().document().checkpoint();
    json!({"documentId":"27000000-0000-4000-8000-000000000099","epoch":id.epoch,"writerId":cp.writer_id,"checkpointSha256":hash(&cp.bytes),"checkpoint":cp.bytes})
}
