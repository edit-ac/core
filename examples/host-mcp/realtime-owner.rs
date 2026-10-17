//! Prepared embedding-host transport for AGT-1.5. SQLite and the shared Session
//! own admission, mutation, request replay and sync publication. No provider/MCP
//! transport belongs in the engine. stdin is a trusted fixture control channel.
use editac_core::{
    Utf16Offset,
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    edit_service::{EditService, HostPolicy, PreparedEdit},
    operations::HostActor,
    ports::{
        memory::{FaultBoundary, InjectedFault},
        *,
    },
    receipts::*,
    session::{CachedPermission, Session},
    store::NativeStore,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Write},
    sync::Arc,
};

fn identity_json(i: &DocumentIdentity) -> Value {
    json!({"documentId":i.document_id,"epoch":i.epoch,"schema":i.schema,"profile":i.profile,"offsets":i.offsets,"protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding})
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::from_value(value.clone()).unwrap()
}
fn revision(r: &editac_session::revision::ObservedRevision) -> String {
    r.to_bytes().iter().map(|b| format!("{b:02x}")).collect()
}
fn main() {
    let path = std::env::args().nth(1).expect("fixture SQLite path");
    let identity = DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap();
    let store =
        Arc::new(NativeStore::create_new(path, identity.clone(), StoreLimits::default()).unwrap());
    let session = Session::create_local(
        store.clone(),
        identity.clone(),
        &[
            InitialNode {
                kind: "block".into(),
                text: "base".into(),
            },
            InitialNode {
                kind: "block".into(),
                text: "other".into(),
            },
        ],
    )
    .unwrap();
    let mut service = EditService::new(session, HostPolicy::default());
    let actor = HostActor::authenticated_by_host("agent-a").unwrap();
    let mut prepared: BTreeMap<String, PreparedEdit> = BTreeMap::new();
    let mut proposals: BTreeMap<String, RequestProposal> = BTreeMap::new();
    let mut tokens: BTreeMap<String, RequestToken> = BTreeMap::new();
    let mut bindings: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut serial = 0;
    let mut writable = true;
    let mut readable = true;
    let mut peer_sequences: BTreeMap<u32, u64> = BTreeMap::new();
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = (|| -> Result<Value, String> {
            let operation = input["op"].as_str().ok_or("missing operation")?;
            if !readable && !matches!(operation, "policy" | "recover" | "state") {
                return Err("Unauthorized".into());
            }
            match operation {
                "observe" => {
                    let access = &input["access"];
                    let permissions = access["permissions"].as_array().ok_or("Unauthorized")?;
                    if access["actorId"] != "agent-a"
                        || access["documentId"] != identity.document_id
                        || access["epoch"] != identity.epoch
                        || !permissions.iter().any(|p| p == "read")
                        || !permissions.iter().any(|p| p == "observe")
                    {
                        return Err("Unauthorized".into());
                    }
                    // Use the ordinary revision boundary, including its recovery
                    // barrier. Do not snapshot/export source for an invalidation.
                    let current = service
                        .session()
                        .observed_revision()
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"revision":revision(&current)}))
                }
                "seed" => {
                    let c = service.session().document().checkpoint();
                    Ok(
                        json!({"identity":identity_json(&c.identity),"initialized":c.initialized,"writerId":c.writer_id,"bytes":c.bytes}),
                    )
                }
                "prepare" => {
                    if !writable {
                        return Err("Unauthorized".into());
                    }
                    if prepared.len() + proposals.len() + tokens.len() >= 64 {
                        return Err("Limit".into());
                    }
                    let view = service.read(0).map_err(|e| format!("{e:?}"))?;
                    let node = view
                        .snapshot
                        .visible
                        .get(input["index"].as_u64().unwrap_or(0) as usize)
                        .ok_or("target")?;
                    let text = input["text"].as_str().ok_or("text")?;
                    if text.len() > 4096 {
                        return Err("Limit".into());
                    }
                    let origin = TextOrigin::new("agent:agent-a").unwrap();
                    let command = EditorCommand::ReplaceAt {
                        owner: node.id.clone(),
                        from: Utf16Offset(0),
                        to: Utf16Offset(0),
                        text: text.into(),
                    };
                    let p = service
                        .prepare_commands(&view.revision, &[command], &origin, 0)
                        .map_err(|e| format!("{e:?}"))?;
                    serial += 1;
                    let id = format!("proposal-{serial}");
                    prepared.insert(id.clone(), p);
                    Ok(json!({"proposalId":id,"expectedRevision":revision(&view.revision)}))
                }
                "apply" | "receipt" => {
                    let id = input["requestId"].as_str().ok_or("requestId")?;
                    let proposal_id = input["proposalId"].as_str().unwrap_or("");
                    if operation == "apply" && !writable {
                        return Err("Unauthorized".into());
                    }
                    if operation == "apply" {
                        let fields = (
                            proposal_id.to_owned(),
                            input["expectedRevision"].as_str().unwrap_or("").to_owned(),
                        );
                        if bindings.get(id).is_some_and(|old| old != &fields) {
                            return Err("ChangedPayload".into());
                        }
                    }
                    if operation == "apply" && !tokens.contains_key(id) {
                        let p = prepared.remove(proposal_id).ok_or("MissingProposal")?;
                        if revision(p.expected_revision())
                            != input["expectedRevision"].as_str().unwrap_or("")
                        {
                            return Err("StaleRevision".into());
                        }
                        let p = service
                            .bind_request(p, &actor, id, 100)
                            .map_err(|e| format!("{e:?}"))?;
                        bindings.insert(
                            id.into(),
                            (
                                proposal_id.into(),
                                input["expectedRevision"].as_str().unwrap_or("").into(),
                            ),
                        );
                        tokens.insert(id.into(), p.token().clone());
                        proposals.insert(id.into(), p);
                    }
                    let Some(token) = tokens.get(id) else {
                        return Ok(
                            json!({"requestId":id,"outcome":"not-found","revision":null,"localDurability":"none","remoteDurability":"not-applicable"}),
                        );
                    };
                    let r = if operation == "receipt" {
                        service
                            .request_receipt(&actor, token, readable)
                            .and_then(|r| r.ok_or(RequestError::MissingProposal))
                    } else {
                        service.apply_request(
                            &actor,
                            token,
                            proposals.remove(id),
                            readable,
                            1,
                            false,
                        )
                    };
                    match r {
                        Ok(r) => Ok(
                            json!({"requestId":id,"outcome":"committed","revision":revision(&r.result.revision()),
                            "localDurability":if r.local==Durability::ProcessCrash {"durable"} else {"unknown"},"remoteDurability":"pending"}),
                        ),
                        Err(RequestError::Pending { .. }) => Ok(
                            json!({"requestId":id,"outcome":"pending","revision":null,"localDurability":"pending","remoteDurability":"unknown"}),
                        ),
                        Err(e) => Err(format!("{e:?}")),
                    }
                }
                // Separate collaboration channel. Neither read nor receipt lookup
                // carries content. sync_update enforces the persistence barrier.
                "vector" => Ok(json!(service.session().document().state_vector_v1())),
                "sync" => {
                    let update = service
                        .session()
                        .sync_update(&bytes(&input["vector"]))
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"identity":identity_json(&identity),"bytes":update}))
                }
                "peer" => {
                    let writer = input["writerId"].as_u64().ok_or("writer")? as u32;
                    if !peer_sequences.contains_key(&writer) {
                        service
                            .session()
                            .reserve_peer_writer(writer)
                            .map_err(|e| format!("{e:?}"))?;
                        peer_sequences.insert(writer, 0);
                    }
                    let sequence = peer_sequences.get_mut(&writer).unwrap();
                    *sequence += 1;
                    let entry = JournalEntry::new(
                        identity.clone(),
                        writer,
                        *sequence,
                        "peer:human".into(),
                        bytes(&input["bytes"]),
                    )
                    .map_err(|e| format!("{e:?}"))?;
                    service.receive_peer(entry).map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"received":true}))
                }
                "policy" => {
                    writable = input["writable"].as_bool().unwrap_or(writable);
                    readable = input["readable"].as_bool().unwrap_or(readable);
                    service.set_permission(CachedPermission {
                        writable,
                        expires_at: None,
                    });
                    service.set_policy(HostPolicy {
                        writable,
                        ..HostPolicy::default()
                    });
                    Ok(json!({"writable":writable,"readable":readable}))
                }
                "fail" => {
                    store
                        .inject_once(InjectedFault {
                            boundary: FaultBoundary::BeforeCommit,
                            error: PortError::Unavailable,
                        })
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"armed":true}))
                }
                "recover" => {
                    service.recover().map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"recovered":true}))
                }
                "undo" => {
                    let r = service.read(0).map_err(|e| format!("{e:?}"))?.revision;
                    service.undo(&r, 0).map_err(|e| format!("{e:?}"))?;
                    Ok(json!({"undone":true}))
                }
                "state" => {
                    let s = service.read(0).map_err(|e| format!("{e:?}"))?;
                    Ok(
                        json!({"revision":revision(&s.revision),"texts":s.snapshot.visible.iter().map(|n| n.runs.iter().map(|r|r.text.as_str()).collect::<String>()).collect::<Vec<_>>(),
                        "undoGroups":service.session().document().history_state().undo_groups,
                        "pendingUpdates":service.session().pending_updates().map(|v|v.len()).ok()}),
                    )
                }
                _ => Err("unknown operation".into()),
            }
        })();
        let out = match result {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"error":e}),
        };
        println!("{out}");
        io::stdout().flush().unwrap();
    }
}
