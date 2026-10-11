//! FND-1.12 real pinned Yrs/Yjs frozen-schema exchange, not durability evidence.
#[allow(dead_code)]
#[path = "support/structure_conflicts.rs"]
mod policy;
use policy::hierarchy::registry;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use yrs::{Any, Assoc, Doc, Map, ReadTxn, Text, Transact, XmlOut, XmlTextPrelim};
const CASES: [&str; 13] = [
    "move-edit",
    "move-move",
    "delete-edit",
    "edit-edit",
    "split-edit",
    "join-edit",
    "split-join",
    "cycle-edit",
    "js-move-edit",
    "js-delete-edit",
    "js-split-edit",
    "js-join-edit",
    "js-edit-edit",
];
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
const ANCHORS: [(&str, u32, Assoc); 4] = [
    ("block-1", 3, Assoc::Before),
    ("block-1", 3, Assoc::After),
    ("block-1", 4, Assoc::After),
    ("block-2", 1, Assoc::After),
];
fn roots(doc: &Doc) {
    for name in [
        "registry-parents",
        "registry-texts",
        "registry-placements",
        "delete-probe-tombstones",
        "probe-split-join",
    ] {
        doc.get_or_insert_map(name);
    }
}
fn seed() -> Doc {
    let doc = registry::replica(11);
    roots(&doc);
    let kinds = doc.get_or_insert_map("registry-parents");
    let texts = doc.get_or_insert_map("registry-texts");
    let places = doc.get_or_insert_map("registry-placements");
    let layout = doc.get_or_insert_map("probe-split-join");
    {
        let mut txn = doc.transact_mut_with("initialize");
        for (id, input, order, mark) in [
            ("block-1", "a😀b", 0, "bold"),
            ("block-2", "cאבd", 1, "code"),
        ] {
            kinds.insert(&mut txn, id, "list");
            let t = texts.insert(&mut txn, id, XmlTextPrelim::new(input));
            t.format(
                &mut txn,
                1,
                2,
                HashMap::from([(mark.into(), Any::Bool(true))]),
            );
            places.insert(&mut txn, id, registry::placement("@root", order));
        }
        layout.insert(
            &mut txn,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    doc
}
fn peer(id: u64, bytes: &[u8]) -> Doc {
    let doc = registry::replica(id);
    roots(&doc);
    registry::apply(&doc, bytes);
    doc
}
fn bridge(mode: &str, dir: &Path) {
    let result = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/schema-v1/exchange.mjs"))
        .arg(mode)
        .arg(dir)
        .output()
        .unwrap();
    fs::write(
        dir.join(format!("bridge-{mode}.log")),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "bridge {mode}: see {}",
        dir.join(format!("bridge-{mode}.log")).display()
    );
}
fn mutate(doc: &Doc, name: &str) {
    if name.starts_with("js-") {
        let t = policy::layout::text(doc, "block-1");
        t.insert_with_attributes(
            &mut doc.transact_mut_with("local:edit"),
            3,
            "R",
            HashMap::from([("italic".into(), true.into())]),
        );
        return;
    }
    match name {
        "move-edit" | "move-move" => {
            policy::hierarchy::move_node(doc, "block-1", "block-2", 7).unwrap()
        }
        "delete-edit" => policy::delete(doc, "block-1"),
        "edit-edit" => {
            let t = policy::layout::text(doc, "block-1");
            let mut txn = doc.transact_mut_with("local:edit");
            t.insert_with_attributes(
                &mut txn,
                3,
                "R",
                HashMap::from([("italic".into(), true.into())]),
            );
            t.remove_range(&mut txn, 4, 1);
        }
        "split-edit" | "split-join" => policy::layout::split(doc, 3).unwrap(),
        "join-edit" => policy::layout::join(doc).unwrap(),
        "cycle-edit" => {
            let places = doc.get_or_insert_map("registry-placements");
            let mut txn = doc.transact_mut_with("local:move");
            places.insert(&mut txn, "block-1", registry::placement("block-2", 2));
            places.insert(&mut txn, "block-2", registry::placement("block-1", 3));
        }
        _ => panic!("unknown case"),
    }
}
fn array(values: impl IntoIterator<Item = Any>) -> Any {
    Any::Array(values.into_iter().collect::<Vec<_>>().into())
}
fn object(values: impl IntoIterator<Item = (&'static str, Any)>) -> Any {
    Any::Map(
        values
            .into_iter()
            .map(|(k, v)| (k.into(), v))
            .collect::<HashMap<_, _>>()
            .into(),
    )
}
fn identity(doc: &Doc, source: &str) -> Any {
    let yrs::branch::BranchID::Nested(id) = XmlOut::Text(policy::layout::text(doc, source)).id()
    else {
        panic!("nested identity required")
    };
    array([Any::from(id.client.get() as u32), Any::from(id.clock)])
}
fn block(doc: &Doc, b: &policy::layout::Block) -> Any {
    let spans = array(b.spans.iter().map(|s| {
        object([
            ("source", s.source.clone().into()),
            ("identity", identity(doc, &s.source)),
            ("start", s.start.into()),
            ("end", s.end.into()),
        ])
    }));
    let runs = array(b.runs.iter().map(|(s, marks)| {
        array([
            s.clone().into(),
            array(
                marks
                    .iter()
                    .map(|(k, v)| array([k.clone().into(), v.clone().into()])),
            ),
        ])
    }));
    object([
        ("id", b.id.clone().into()),
        ("parent", b.parent.clone().into()),
        ("order", b.order.into()),
        ("spans", spans),
        ("runs", runs),
    ])
}
fn canonical(doc: &Doc, dir: &Path, prefix: &str) -> Any {
    let before = registry::full_update(doc);
    let p = policy::project(doc);
    let anchors = ANCHORS
        .iter()
        .enumerate()
        .map(|(i, (source, _, assoc))| {
            let anchor = policy::layout::Anchor {
                source: (*source).into(),
                bytes: fs::read(dir.join(format!("{prefix}-anchor-{i}.bin"))).unwrap(),
            };
            let sticky = yrs::StickyIndex::decode_v1(&anchor.bytes).unwrap();
            assert_eq!(sticky.assoc, *assoc);
            let original = policy::layout::text(doc, source);
            let txn = doc.transact();
            let offset = sticky.get_offset(&txn).unwrap();
            assert_eq!(offset.branch.id(), XmlOut::Text(original).id());
            let index = offset.index;
            drop(txn);
            let (owner, n) = policy::layout::resolve(doc, &anchor).unwrap();
            let hidden = p
                .recovery
                .iter()
                .any(|b| b.id == owner && b.spans.iter().any(|s| s.source == *source));
            object([
                ("source", (*source).into()),
                ("identity", identity(doc, source)),
                ("index", index.into()),
                (
                    "assoc",
                    Any::from(if *assoc == Assoc::Before { -1i32 } else { 0i32 }),
                ),
                ("owner", array([owner.into(), n.into()])),
                ("hidden", hidden.into()),
            ])
        })
        .collect::<Vec<_>>();
    let result = object([
        ("visible", array(p.visible.iter().map(|b| block(doc, b)))),
        ("recovery", array(p.recovery.iter().map(|b| block(doc, b)))),
        (
            "identities",
            array(
                p.identities
                    .iter()
                    .map(|(id, _)| array([id.clone().into(), identity(doc, id)])),
            ),
        ),
        ("anchors", array(anchors)),
    ]);
    assert_eq!(
        registry::full_update(doc),
        before,
        "projection/anchors emit no repairs"
    );
    result
}
use yrs::updates::decoder::Decode;
struct Temporary(PathBuf, bool);
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.1 {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
#[test]
fn frozen_schema_exchange_moves_deletes_edits_ownership_and_anchors_in_both_directions() {
    let external = std::env::var_os("EDITAC_SCHEMA_INTEROP_OUTPUT");
    let dir = Temporary(
        external.clone().map(PathBuf::from).unwrap_or_else(|| {
            std::env::temp_dir().join(format!("editac-schema-{}", std::process::id()))
        }),
        external.is_none(),
    );
    fs::create_dir_all(&dir.0).unwrap();
    fs::write(dir.0.join("rust-seed.bin"), registry::full_update(&seed())).unwrap();
    bridge("generate-js", &dir.0);
    for init in ["rust", "js"] {
        let bytes = fs::read(dir.0.join(format!("{init}-seed.bin"))).unwrap();
        let baseline = peer(601, &bytes);
        let baseline_ids = policy::project(&baseline).identities;
        for name in CASES {
            let prefix = format!("{init}-{name}");
            let writer = peer(101, &bytes);
            for (i, (source, index, assoc)) in ANCHORS.iter().enumerate() {
                fs::write(
                    dir.0.join(format!("{prefix}-rust-anchor-{i}.bin")),
                    policy::layout::anchor(&writer, source, *index, *assoc).bytes,
                )
                .unwrap();
            }
            let sv = writer.transact().state_vector();
            mutate(&writer, name);
            fs::write(
                dir.0.join(format!("{prefix}-rust.bin")),
                writer.transact().encode_state_as_update_v1(&sv),
            )
            .unwrap();
            assert_eq!(policy::project(&writer).identities, baseline_ids);
        }
    }
    bridge("verify", &dir.0); // JS creates expected projections only after actual exchange.
    for init in ["rust", "js"] {
        for name in CASES {
            let prefix = format!("{init}-{name}");
            let updates = [
                fs::read(dir.0.join(format!("{init}-seed.bin"))).unwrap(),
                fs::read(dir.0.join(format!("{prefix}-rust.bin"))).unwrap(),
                fs::read(dir.0.join(format!("{prefix}-js.bin"))).unwrap(),
            ];
            let expected = Any::from_json(
                &fs::read_to_string(dir.0.join(format!("{prefix}-js.json"))).unwrap(),
            )
            .unwrap();
            let baseline = peer(606, &updates[0]);
            let identities = policy::project(&baseline).identities;
            for order in ORDERS {
                let doc = registry::replica(707);
                roots(&doc);
                for i in order {
                    registry::apply(&doc, &updates[i]);
                    registry::apply(&doc, &updates[i]);
                }
                assert_eq!(
                    policy::project(&doc).identities,
                    identities,
                    "{prefix}: original nested IDs"
                );
                let actual = canonical(&doc, &dir.0, &format!("{prefix}-rust"));
                assert_eq!(actual, expected, "{prefix}/{order:?}");
                assert_eq!(
                    canonical(&doc, &dir.0, &format!("{prefix}-js")),
                    actual,
                    "JS anchor bytes in Rust"
                );
                for i in order.into_iter().rev() {
                    registry::apply(&doc, &updates[i]);
                }
                assert_eq!(canonical(&doc, &dir.0, &format!("{prefix}-rust")), actual);
                let restored = peer(808, &registry::full_update(&doc));
                assert_eq!(
                    canonical(&restored, &dir.0, &format!("{prefix}-js")),
                    actual
                );
                // Fresh restored peers consume a state-vector diff in both directions.
                for side in [1, 2] {
                    let continued = peer(if side == 1 { 901 } else { 902 }, &updates[0]);
                    registry::apply(&continued, &updates[side]);
                    let sv = continued.transact().state_vector();
                    let delta = doc.transact().encode_state_as_update_v1(&sv);
                    registry::apply(&continued, &delta);
                    registry::apply(&continued, &delta);
                    assert_eq!(
                        canonical(&continued, &dir.0, &format!("{prefix}-rust")),
                        actual
                    );
                }
                let mut json = String::new();
                actual.to_json(&mut json);
                fs::write(dir.0.join(format!("{prefix}-rust.json")), json).unwrap();
            }
        }
    }
    bridge("compare", &dir.0);
    fs::write(dir.0.join("coverage.json"),r#"{"initializers":2,"cases":13,"arrival_permutations_per_case":6,"observer_schedules_per_language":156,"restores_per_language":156,"rust_restored_peer_deltas":312,"duplicate_and_reverse_replay":true,"anchors_per_case":4,"repair_writes":0}"#).unwrap();
}
