//! Deterministic process transport for the embedding-host example and Node proof.
//! No network, provider, apply endpoint, production storage or authority from prose.
use editac_core::{
    Utf16Offset,
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{DocumentIdentity, InitialNode},
    modules::content::Content,
};
use editac_diff::{
    portable::{ChangeInput, ChangeModel},
    representation::{ImmutableRevision, RepresentationLimits, RevisionInput, RevisionScope},
    semantic::{self, SemanticLimits},
    text::{PatchLimits, TextPatch},
};
use editac_markdown::{optional::Codecs, reconcile::SourceMode};
use editac_session::{
    edit_service::{EditService, HostPolicy, PreparedEdit, ServiceError, SourceTarget},
    ports::{StoreLimits, memory::MemoryStore},
    revision::ObservedRevision,
    session::{CachedPermission, Session},
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

fn token(revision: &ObservedRevision) -> String {
    revision
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn hash(source: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(source.as_bytes()))
}
// Host-owned opaque plans, not presentation strings or synthetic receipts.
struct Proposal {
    _plan: PreparedEdit,
    metadata: Value,
    expires_at: u64,
}

fn previews(
    service: &EditService<MemoryStore>,
    target: &SourceTarget,
    candidate: &str,
    plan: &PreparedEdit,
) -> Result<(Value, Value, Vec<String>), String> {
    let identity = service.session().document().identity();
    let scope = RevisionScope {
        document: identity.document_id.clone(),
        epoch: identity.epoch.clone(),
        schema: identity.schema.clone(),
        module_profile: "markdown-v1/images-disabled".into(),
        observed_token: plan.expected_revision().to_bytes(),
    };
    let limits = RepresentationLimits {
        max_bytes: 262144,
        max_nodes: 1024,
        max_depth: 64,
    };
    let before = ImmutableRevision::capture(
        scope.clone(),
        RevisionInput::ExactSource(target.source().as_bytes()),
        limits,
    )
    .map_err(|e| format!("{e:?}"))?;
    let after = ImmutableRevision::capture(
        scope.clone(),
        RevisionInput::ExactSource(candidate.as_bytes()),
        limits,
    )
    .map_err(|e| format!("{e:?}"))?;
    let patch = TextPatch::between(&before, &after, PatchLimits::default())
        .map_err(|e| format!("{e:?}"))?;
    let wire = patch
        .encode(PatchLimits::default())
        .map_err(|e| format!("{e:?}"))?;
    let source =
        ChangeModel::new(ChangeInput::ExactSource { wire }).map_err(|e| format!("{e:?}"))?;
    let before =
        semantic::capture_projection(scope.clone(), &service.read(0).unwrap().snapshot, limits)
            .map_err(|e| format!("{e:?}"))?;
    let after = semantic::capture_projection(scope, plan.preview(), limits)
        .map_err(|e| format!("{e:?}"))?;
    let model = semantic::compare(
        &before,
        &after,
        SemanticLimits {
            input: limits,
            max_changes: 1024,
            max_output_bytes: 524288,
        },
    )
    .map_err(|e| format!("{e:?}"))?;
    let ids = model
        .changes
        .iter()
        .map(|change| change.id.clone())
        .collect();
    let semantic =
        ChangeModel::new(ChangeInput::Semantic { model }).map_err(|e| format!("{e:?}"))?;
    Ok((
        serde_json::to_value(source).unwrap(),
        serde_json::to_value(semantic).unwrap(),
        ids,
    ))
}

fn prepare_host(
    service: &EditService<MemoryStore>,
    target: &SourceTarget,
    expected: &ObservedRevision,
    candidate: &str,
    origin: &TextOrigin,
    now: u64,
    input: &Value,
    proposals: &mut BTreeMap<String, Proposal>,
    next: &mut u64,
) -> Value {
    let access = &input["access"];
    if access["actorId"] != "actor"
        || access["documentId"] != "fixture-document"
        || access["epoch"] != "epoch"
        || access["readOnly"] != false
        || !access["permissions"]
            .as_array()
            .is_some_and(|p| p.iter().any(|v| v == "prepare"))
    {
        return json!({"status":"rejected","code":"denied"});
    }
    proposals.retain(|_, value| now < value.expires_at);
    if candidate.len() > 65536 || proposals.len() >= 32 {
        return json!({"status":"rejected","code":"limit"});
    }
    // The process loop is the serialized owner. There is no await or mutable
    // engine escape between current authority/policy checks and preparation.
    if !service.capabilities(now).can_prepare {
        return json!({"status":"rejected","code":"denied"});
    }
    match service.prepare_source(target, expected, candidate, origin, now) {
        Ok(plan) => match previews(service, target, candidate, &plan) {
            Ok((source_diff, semantic_diff, ids)) => {
                *next += 1;
                let id = format!("host-fixture-proposal-{next}");
                let metadata = json!({"actorId":access["actorId"],"documentId":access["documentId"],
                    "epoch":access["epoch"],"expectedRevision":token(expected),
                    "profile":"markdown-v1/images-disabled","sourceHash":hash(target.source()),
                    "candidateHash":hash(candidate)});
                let result = json!({"status":"prepared","proposalId":id,"expectedRevision":token(expected),
                    "sourceHash":hash(target.source()),"candidateHash":hash(candidate),
                    "profile":"markdown-v1/images-disabled","preview":snapshot(plan.preview()),
                    "sourceDiff":source_diff,"semanticDiff":semantic_diff,"affectedIds":ids});
                proposals.insert(
                    id,
                    Proposal {
                        _plan: plan,
                        metadata,
                        expires_at: now + 300000,
                    },
                );
                result
            }
            Err(_) => json!({"status":"rejected","code":"preview-limit"}),
        },
        Err(error) => {
            let current = service.read(now).unwrap();
            // A stale token is never silently rebased. Shared reconciliation at
            // current state may refine its diagnostic; any resulting plan drops.
            let diagnostic = if current.revision != *expected {
                service
                    .prepare_source(target, &current.revision, candidate, origin, now)
                    .err()
            } else {
                None
            };
            let (code, target_id) = match diagnostic.as_ref().unwrap_or(&error) {
                ServiceError::SourceConflict { conflict, .. } | ServiceError::Source(conflict) => {
                    (format!("{:?}", conflict.kind), conflict.target.clone())
                }
                ServiceError::Session(editac_session::session::SessionError::Revision(_)) => {
                    ("StaleRevision".into(), None)
                }
                ServiceError::ResourceLimit => return json!({"status":"rejected","code":"limit"}),
                _ => return json!({"status":"rejected","code":"denied"}),
            };
            json!({"status":"conflict","code":code,"target":target_id,
                "recovery":{"base":target.source(),"proposed":candidate,
                    "current":snapshot(&current.snapshot),"currentRevision":token(&current.revision)}})
        }
    }
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
    let mut source = "Hello 😀\n\nopaque\n".to_string();
    let mut targets: BTreeMap<u64, (SourceTarget, ObservedRevision)> = BTreeMap::new();
    let mut next = 0u64;
    let mut calls = 0u64;
    let mut proposal_sequence = 0u64;
    let mut proposals: BTreeMap<String, Proposal> = BTreeMap::new();
    let mut now = 0u64;
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        assert!(line.len() < 100_000);
        let input: Value = serde_json::from_str(&line).unwrap();
        let response = match input["op"].as_str().unwrap() {
            "capture" => {
                let current = service.read(now).unwrap();
                let active_owners: Vec<String> = owners
                    .iter()
                    .filter(|id| current.snapshot.visible.iter().any(|node| node.id == **id))
                    .cloned()
                    .collect();
                let target = service
                    .capture_source(
                        &source,
                        SourceMode::Markdown(Codecs::default()),
                        &active_owners,
                        now,
                    )
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
            "prepare_v1" => {
                calls += 1;
                let (target, revision) = targets.get(&input["target"].as_u64().unwrap()).unwrap();
                prepare_host(
                    &service,
                    target,
                    revision,
                    input["candidate"].as_str().unwrap(),
                    &origin,
                    now,
                    &input,
                    &mut proposals,
                    &mut proposal_sequence,
                )
            }
            "human" => {
                let command = if input["delete"] == true {
                    EditorCommand::Enable {
                        target: owners[0].clone(),
                        enabled: false,
                    }
                } else {
                    EditorCommand::ReplaceAt {
                        owner: owners[0].clone(),
                        from: Utf16Offset(0),
                        to: Utf16Offset(5),
                        text: "Human".into(),
                    }
                };
                let revision = service.read(now).unwrap().revision;
                let plan = service
                    .prepare_commands(
                        &revision,
                        &[command],
                        &TextOrigin::new("human").unwrap(),
                        now,
                    )
                    .unwrap();
                service.apply(plan, now).unwrap();
                // This fixture owns its exact source buffer alongside the
                // known human command; never synthesize a whole-document import.
                source = if input["delete"] == true {
                    "opaque\n"
                } else {
                    "Human 😀\n\nopaque\n"
                }
                .into();
                json!({"edited":true})
            }
            "policy" => {
                let mut policy = HostPolicy::default();
                if let Some(writable) = input["writable"].as_bool() {
                    policy.writable = writable;
                }
                if let Some(limit) = input["maxInputBytes"].as_u64() {
                    policy.max_input_bytes = limit as usize;
                }
                if let Some(history) = input["historyView"].as_bool() {
                    policy.history_view = history;
                }
                service.set_policy(policy);
                if let Some(writable) = input["permission"].as_bool() {
                    service.set_permission(CachedPermission {
                        writable,
                        expires_at: input["permissionExpiry"].as_u64(),
                    });
                }
                if let Some(time) = input["now"].as_u64() {
                    now = time;
                }
                json!({"updated":true})
            }
            "proposal" => {
                proposals.retain(|_, value| now < value.expires_at);
                json!({"metadata":proposals.get(input["proposalId"].as_str().unwrap()).map(|p| &p.metadata)})
            }
            "release" => {
                targets.remove(&input["target"].as_u64().unwrap());
                json!({"released":true})
            }
            "state" => {
                let bytes = service.session().document().checkpoint().bytes;
                json!({"checkpointHash":format!("{:x}",Sha256::digest(bytes)),
                    "snapshot":snapshot(&service.read(now).unwrap().snapshot),"prepareCalls":calls,"targets":targets.len(),"proposals":proposals.len()})
            }
            _ => panic!("unknown fixture operation"),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
