//! Deterministic process transport for the embedding-host example and Node proof.
//! No network, provider, apply endpoint, production storage or authority from prose.
use editac_core::{
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{DocumentIdentity, InitialNode},
    modules::content::Content,
};
use editac_markdown::{optional::Codecs, reconcile::SourceMode};
use editac_session::{
    edit_service::{EditService, HostPolicy, SourceTarget},
    ports::{StoreLimits, memory::MemoryStore},
    revision::ObservedRevision,
    session::Session,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Write},
};

fn snapshot(value: &editac_core::projection::Snapshot) -> Value {
    json!({"visible": value.visible.iter().map(|node| editac_core::interchange::projection_node(node)).collect::<Vec<_>>()})
}

fn main() {
    let id = DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap();
    let store = MemoryStore::new(id.clone(), StoreLimits::default()).unwrap();
    let session = Session::create_local(
        store,
        id,
        &[
            InitialNode {
                kind: "block".into(),
                text: "Hello 😀".into(),
            },
            InitialNode {
                kind: "block".into(),
                text: "opaque".into(),
            },
        ],
    )
    .unwrap();
    let mut service = EditService::new(
        session,
        HostPolicy {
            codecs: Codecs {
                images: true,
                ..Codecs::default()
            },
            ..HostPolicy::default()
        },
    );
    let owners: Vec<String> = service
        .read(0)
        .unwrap()
        .snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect();
    let origin = TextOrigin::new("host-agent:fixture").unwrap();
    let revision = service.read(0).unwrap().revision;
    let plan = service
        .prepare_commands(
            &revision,
            &[EditorCommand::Content {
                target: owners[1].clone(),
                content: Content::Image {
                    url: "https://example.invalid/inert.png".into(),
                    alt: "opaque".into(),
                    title: String::new(),
                    source: "![opaque](https://example.invalid/inert.png)".into(),
                },
            }],
            &origin,
            0,
        )
        .unwrap();
    service.apply(plan, 0).unwrap();
    // The opening source has an explicit opaque placeholder. Its real content
    // stays in the retained engine baseline; editing that placeholder is blocked.
    service.set_policy(HostPolicy::default());
    let source = "Hello 😀\n\nopaque\n";
    let mut targets: BTreeMap<u64, (SourceTarget, ObservedRevision)> = BTreeMap::new();
    let mut next = 0u64;
    let mut calls = 0u64;
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        assert!(line.len() < 100_000);
        let input: Value = serde_json::from_str(&line).unwrap();
        let response = match input["op"].as_str().unwrap() {
            "capture" => {
                let target = service
                    .capture_source(source, SourceMode::Markdown(Codecs::default()), &owners, 0)
                    .unwrap();
                let revision = service.read(0).unwrap().revision;
                let token = revision
                    .to_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                next += 1;
                targets.insert(next, (target, revision));
                json!({"target":next,"source":source,"revision":token,"profile":"markdown-v1/images-disabled",
                    "diagnostics":[{"code":"opaque-atom-retained","owner":owners[1]}]})
            }
            "prepare" => {
                calls += 1;
                let (target, revision) = targets.get(&input["target"].as_u64().unwrap()).unwrap();
                service.set_policy(HostPolicy {
                    writable: !input["readOnly"].as_bool().unwrap(),
                    ..HostPolicy::default()
                });
                match service.prepare_source(
                    target,
                    revision,
                    input["candidate"].as_str().unwrap(),
                    &origin,
                    0,
                ) {
                    Ok(plan) => {
                        json!({"status":"prepared","preview":snapshot(plan.preview()),"proposalId":format!("fixture-{calls}")})
                    }
                    Err(error) => json!({"status":"conflict","reason":format!("{error:?}")}),
                }
            }
            "release" => {
                targets.remove(&input["target"].as_u64().unwrap());
                json!({"released":true})
            }
            "state" => {
                let bytes = service.session().document().checkpoint().bytes;
                json!({"checkpointHash":format!("{:x}",Sha256::digest(bytes)),
                    "snapshot":snapshot(&service.read(0).unwrap().snapshot),"prepareCalls":calls,"targets":targets.len()})
            }
            _ => panic!("unknown fixture operation"),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
