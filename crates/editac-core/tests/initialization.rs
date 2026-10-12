//! ENG-1.2: real pinned Yrs initialization and checkpoint/journal replay.
use editac_core::document::{
    CreationPermit, Document, DocumentError, DocumentIdentity, InitialNode, InitializedCheckpoint,
    ROOTS, ReplayUpdate,
};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update, XmlTextPrelim,
};

fn identity(n: u32) -> DocumentIdentity {
    DocumentIdentity::v1(
        format!("00000000-0000-4000-8000-{n:012x}"),
        format!("10000000-0000-4000-8000-{n:012x}"),
    )
    .unwrap()
}
fn create(n: u32, nodes: &[InitialNode]) -> Document {
    Document::create(CreationPermit::authorize_new(identity(n)).unwrap(), nodes).unwrap()
}
fn node(text: &str) -> InitialNode {
    InitialNode {
        kind: "list".into(),
        text: text.into(),
    }
}
fn fixture_replica(id: u64) -> Doc {
    let doc = Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for root in ROOTS {
        doc.get_or_insert_map(root);
    }
    doc
}
fn read_checkpoint(checkpoint: &InitializedCheckpoint) -> Doc {
    let doc = fixture_replica(901);
    doc.transact_mut()
        .apply_update(Update::decode_v1(&checkpoint.bytes).unwrap())
        .unwrap();
    doc
}
fn snapshot(document: &Document) -> Vec<(String, String, String)> {
    let doc = read_checkpoint(&document.checkpoint());
    let txn = doc.transact();
    let kinds = txn.get_map(ROOTS[0]).unwrap();
    let texts = txn.get_map(ROOTS[1]).unwrap();
    let mut result: Vec<_> = kinds
        .iter(&txn)
        .map(|(id, kind)| {
            let Out::Any(Any::String(kind)) = kind else {
                panic!("invalid kind")
            };
            let Some(Out::YXmlText(text)) = texts.get(&txn, id) else {
                panic!("invalid text")
            };
            (id.to_owned(), kind.to_string(), text.get_string(&txn))
        })
        .collect();
    result.sort();
    result
}
/// One authorized fixed initializer, followed by two causally ordered updates.
/// This same harness is used by all reorder, duplicate and partial replay cases.
fn replay_fixture(n: u32) -> (InitializedCheckpoint, Vec<ReplayUpdate>) {
    let doc = fixture_replica(11);
    let kinds = doc.get_or_insert_map(ROOTS[0]);
    let texts = doc.get_or_insert_map(ROOTS[1]);
    let placements = doc.get_or_insert_map(ROOTS[2]);
    let text;
    {
        let mut txn = doc.transact_mut_with("initialize");
        kinds.insert(&mut txn, "n-b-0", "list");
        text = texts.insert(&mut txn, "n-b-0", XmlTextPrelim::new("a😀b"));
        placements.insert(
            &mut txn,
            "n-b-0",
            Any::Array(vec![Any::from("@root"), Any::from(0u32)].into()),
        );
    }
    let checkpoint = InitializedCheckpoint {
        identity: identity(n),
        initialized: true,
        writer_id: 11,
        bytes: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };
    let mut updates = Vec::new();
    for input in ["אב", "e\u{301}"] {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut_with("fixture-edit");
            let end = text.len(&txn);
            text.insert(&mut txn, end, input);
        }
        updates.push(ReplayUpdate {
            identity: identity(n),
            bytes: doc.transact().encode_state_as_update_v1(&before),
        });
    }
    (checkpoint, updates)
}

#[test]
fn creates_exact_five_roots_and_one_copy_of_defaults() {
    let doc = create(1, &[node("a😀b"), node("אב")]);
    assert!(doc.is_initialized());
    assert_eq!(doc.next_node_counter(), 2);
    let rows = snapshot(&doc);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|(_, _, text)| text == "a😀b"));
    assert!(
        rows.iter()
            .all(|(id, _, _)| id.starts_with(&format!("n-{:x}-", doc.writer_id())))
    );
    let raw = read_checkpoint(&doc.checkpoint());
    let txn = raw.transact();
    let mut roots: Vec<_> = txn
        .root_refs()
        .map(|(name, v)| {
            assert!(matches!(v, Out::YMap(_)));
            name.to_owned()
        })
        .collect();
    roots.sort();
    let mut expected = ROOTS.map(str::to_owned);
    expected.sort();
    assert_eq!(roots, expected);
    let text = match txn
        .get_map(ROOTS[1])
        .unwrap()
        .get(&txn, &rows.iter().find(|r| r.2 == "a😀b").unwrap().0)
    {
        Some(Out::YXmlText(t)) => t,
        _ => panic!("missing text"),
    };
    assert_eq!(text.len(&txn), 4, "public offsets are UTF-16");
}

#[test]
fn restore_never_reimports_defaults_even_across_repeated_open() {
    let original = create(2, &[node("original 😀")]);
    let expected = snapshot(&original);
    let checkpoint = original.checkpoint();
    let first = Document::restore(original.identity(), &checkpoint, &[]).unwrap();
    let second = Document::restore(original.identity(), &first.checkpoint(), &[]).unwrap();
    assert_eq!(snapshot(&first), expected);
    assert_eq!(snapshot(&second), expected);
    assert_eq!(checkpoint.bytes, first.checkpoint().bytes);
    assert_ne!(first.writer_id(), original.writer_id());
    assert_ne!(second.writer_id(), first.writer_id());
}

#[test]
fn empty_but_existing_remains_initialized_without_default_import() {
    let original = create(3, &[]);
    assert_eq!(snapshot(&original), vec![]);
    let checkpoint = original.checkpoint();
    let restored = Document::restore(original.identity(), &checkpoint, &[]).unwrap();
    assert!(restored.is_initialized());
    assert!(snapshot(&restored).is_empty());
    assert_eq!(restored.checkpoint().bytes, checkpoint.bytes);
}

#[test]
fn duplicate_and_all_reordered_initialization_deliveries_converge() {
    let (checkpoint, updates) = replay_fixture(4);
    let expected = vec![("n-b-0".into(), "list".into(), "a😀bאבe\u{301}".into())];
    // All six permutations of initializer checkpoint + two incremental updates,
    // each duplicated, after an explicitly initialized empty baseline.
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let deliveries = [
            ReplayUpdate {
                identity: identity(4),
                bytes: checkpoint.bytes.clone(),
            },
            updates[0].clone(),
            updates[1].clone(),
        ];
        let empty = InitializedCheckpoint {
            bytes: vec![0, 0],
            ..checkpoint.clone()
        };
        let journal: Vec<_> = order
            .into_iter()
            .flat_map(|i| [deliveries[i].clone(), deliveries[i].clone()])
            .collect();
        let a = Document::restore(&identity(4), &empty, &journal).unwrap();
        let b = Document::restore(&identity(4), &a.checkpoint(), &journal).unwrap();
        let c = Document::restore(&identity(4), &checkpoint, &updates).unwrap();
        assert_eq!(snapshot(&a), expected, "schedule {order:?}");
        assert_eq!(snapshot(&b), expected);
        assert_eq!(snapshot(&c), expected);
        assert_eq!(a.checkpoint().bytes, b.checkpoint().bytes);
        assert_eq!(a.checkpoint().bytes, c.checkpoint().bytes);
    }
}

#[test]
fn wrong_checkpoint_epoch_is_typed_and_preserves_live_state() {
    let live = create(5, &[node("keep")]);
    let before = live.checkpoint();
    let mut wrong = before.clone();
    wrong.identity.epoch = identity(6).epoch;
    assert_eq!(
        Document::restore(live.identity(), &wrong, &[]).unwrap_err(),
        DocumentError::WrongEpoch
    );
    assert_eq!(live.checkpoint().bytes, before.bytes);
    assert_eq!(
        wrong.bytes, before.bytes,
        "rejected bytes remain owned by caller"
    );
}
#[test]
fn wrong_journal_epoch_rejects_whole_restore_before_publication() {
    let (checkpoint, mut updates) = replay_fixture(7);
    updates[1].identity.epoch = identity(8).epoch;
    let bytes = updates[1].bytes.clone();
    assert_eq!(
        Document::restore(&identity(7), &checkpoint, &updates).unwrap_err(),
        DocumentError::WrongEpoch
    );
    assert_eq!(updates[1].bytes, bytes);
}
#[test]
fn complete_profile_and_document_identity_are_required() {
    let doc = create(9, &[]);
    let checkpoint = doc.checkpoint();
    for field in 0..7 {
        let mut wrong = checkpoint.clone();
        let expected = match field {
            0 => {
                wrong.identity.profile = "other".into();
                DocumentError::UnsupportedProfile
            }
            1 => {
                wrong.identity.schema = "other".into();
                DocumentError::UnsupportedProfile
            }
            2 => {
                wrong.identity.protocol_version = 2;
                DocumentError::UnsupportedProfile
            }
            3 => {
                wrong.identity.update_encoding = 2;
                DocumentError::UnsupportedProfile
            }
            4 => {
                wrong.identity.offsets = "bytes".into();
                DocumentError::UnsupportedProfile
            }
            5 => {
                wrong.identity.document_id = identity(10).document_id;
                DocumentError::WrongDocument
            }
            _ => {
                wrong.identity.epoch = "not-a-uuid".into();
                DocumentError::InvalidMetadata
            }
        };
        assert_eq!(
            Document::restore(doc.identity(), &wrong, &[]).unwrap_err(),
            expected
        );
    }
}
#[test]
fn missing_initializer_authority_cannot_be_guessed_from_content() {
    let (mut checkpoint, updates) = replay_fixture(11);
    checkpoint.initialized = false;
    assert_eq!(
        Document::restore(&identity(11), &checkpoint, &updates).unwrap_err(),
        DocumentError::MissingInitialization
    );
}
#[test]
fn independent_live_replicas_never_reactivate_checkpoint_writer() {
    let (checkpoint, updates) = replay_fixture(12);
    let docs: Vec<_> = (0..32)
        .map(|_| Document::restore(&identity(12), &checkpoint, &updates).unwrap())
        .collect();
    let ids: std::collections::HashSet<_> = docs.iter().map(Document::writer_id).collect();
    assert_eq!(ids.len(), docs.len());
    assert!(!ids.contains(&11));
    assert!(docs.iter().all(|d| d.next_node_counter() == 0));
}
#[test]
fn creation_authority_is_one_shot_even_after_initializer_is_dropped() {
    let doc = create(13, &[]);
    let checkpoint = doc.checkpoint();
    drop(doc);
    assert_eq!(
        CreationPermit::authorize_new(identity(13)).unwrap_err(),
        DocumentError::AlreadyInitialized
    );
    assert!(
        Document::restore(&identity(13), &checkpoint, &[])
            .unwrap()
            .is_initialized()
    );
}
#[test]
fn malformed_and_partial_replay_remain_explicit_recovery() {
    let (checkpoint, updates) = replay_fixture(14);
    let bad = ReplayUpdate {
        identity: identity(14),
        bytes: vec![255],
    };
    assert_eq!(
        Document::restore(&identity(14), &checkpoint, &[updates[0].clone(), bad]).unwrap_err(),
        DocumentError::InvalidUpdate
    );
    let empty = InitializedCheckpoint {
        bytes: vec![0, 0],
        ..checkpoint
    };
    assert_eq!(
        Document::restore(&identity(14), &empty, &[updates[1].clone()]).unwrap_err(),
        DocumentError::IncompleteRestore
    );
}
#[test]
fn unsupported_roots_are_rejected_without_repair() {
    let doc = fixture_replica(15);
    let text = doc.get_or_insert_text("foreign-root");
    text.insert(&mut doc.transact_mut(), 0, "preserve me");
    let checkpoint = InitializedCheckpoint {
        identity: identity(15),
        initialized: true,
        writer_id: 15,
        bytes: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };
    assert_eq!(
        Document::restore(&identity(15), &checkpoint, &[]).unwrap_err(),
        DocumentError::UnsupportedSchema
    );
    assert_eq!(text.get_string(&doc.transact()), "preserve me");
}

#[test]
fn invalid_creation_releases_uncommitted_authority() {
    let permit = CreationPermit::authorize_new(identity(16)).unwrap();
    assert_eq!(
        Document::create(
            permit,
            &[InitialNode {
                kind: String::new(),
                text: "invalid".into()
            }]
        )
        .unwrap_err(),
        DocumentError::InvalidInitialContent
    );
    let valid = create(16, &[node("retry")]);
    assert_eq!(snapshot(&valid)[0].2, "retry");
}

#[test]
fn restores_frozen_reserved_pair_with_marks_without_reconstruction() {
    let doc = fixture_replica(11);
    let kinds = doc.get_or_insert_map(ROOTS[0]);
    let texts = doc.get_or_insert_map(ROOTS[1]);
    let placements = doc.get_or_insert_map(ROOTS[2]);
    let layout = doc.get_or_insert_map(ROOTS[4]);
    {
        let mut txn = doc.transact_mut_with("initialize");
        for (id, input, order, mark) in [
            ("block-1", "a😀b", 0u32, "bold"),
            ("block-2", "cאבd", 1u32, "code"),
        ] {
            kinds.insert(&mut txn, id, "list");
            let text = texts.insert(&mut txn, id, XmlTextPrelim::new(input));
            text.format(
                &mut txn,
                1,
                2,
                std::collections::HashMap::from([(mark.into(), Any::Bool(true))]),
            );
            placements.insert(
                &mut txn,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
        }
        layout.insert(
            &mut txn,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    let checkpoint = InitializedCheckpoint {
        identity: identity(17),
        initialized: true,
        writer_id: 11,
        bytes: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };
    let restored = Document::restore(&identity(17), &checkpoint, &[]).unwrap();
    assert_eq!(
        snapshot(&restored),
        vec![
            ("block-1".into(), "list".into(), "a<bold>😀</bold>b".into()),
            ("block-2".into(), "list".into(), "c<code>אב</code>d".into())
        ]
    );
    assert_eq!(
        restored.checkpoint().bytes,
        checkpoint.bytes,
        "marks, nested identities, placements and descriptor are retained byte-for-byte"
    );
}

#[test]
fn emptied_existing_text_does_not_trigger_reinitialization() {
    let (checkpoint, _) = replay_fixture(18);
    let doc = read_checkpoint(&checkpoint);
    let texts = doc.get_or_insert_map(ROOTS[1]);
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let Some(Out::YXmlText(text)) = texts.get(&txn, "n-b-0") else {
            panic!("missing text")
        };
        let length = text.len(&txn);
        text.remove_range(&mut txn, 0, length);
    }
    let journal = [ReplayUpdate {
        identity: identity(18),
        bytes: doc.transact().encode_state_as_update_v1(&before),
    }];
    let restored = Document::restore(&identity(18), &checkpoint, &journal).unwrap();
    assert_eq!(
        snapshot(&restored),
        vec![("n-b-0".into(), "list".into(), String::new())]
    );
    let reopened = Document::restore(&identity(18), &restored.checkpoint(), &[]).unwrap();
    assert_eq!(snapshot(&reopened), snapshot(&restored));
}

#[test]
fn a_sequence_under_a_map_root_is_not_silently_projected_as_empty() {
    let doc = Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(19),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    let text = doc.get_or_insert_text(ROOTS[0]);
    text.insert(&mut doc.transact_mut(), 0, "wrong shared type");
    let checkpoint = InitializedCheckpoint {
        identity: identity(19),
        initialized: true,
        writer_id: 19,
        bytes: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };
    assert_eq!(
        Document::restore(&identity(19), &checkpoint, &[]).unwrap_err(),
        DocumentError::UnsupportedSchema
    );
}

#[test]
fn restored_lineage_revokes_creation_authority_including_pending_permits() {
    let (checkpoint, updates) = replay_fixture(20);
    let stale_permit = CreationPermit::authorize_new(identity(20)).unwrap();
    let restored = Document::restore(&identity(20), &checkpoint, &updates).unwrap();
    assert_eq!(
        Document::create(stale_permit, &[node("must not reseed")]).unwrap_err(),
        DocumentError::AlreadyInitialized
    );
    assert_eq!(
        CreationPermit::authorize_new(identity(20)).unwrap_err(),
        DocumentError::AlreadyInitialized
    );
    assert_eq!(snapshot(&restored)[0].2, "a😀bאבe\u{301}");
}
