//! ENG-1.13: bounded seeded schedules over production commands and admission.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::Bias,
    commands::{blocks::*, editor::*, lists::*, text::*},
    document::{Document, DocumentError, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
    history::HistoryConfig,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{Any, Map, Out, ReadTxn, Text, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const Q: &str = "c:11:2";
const K: &str = "c:11:3";
const W: &str = "c:11:4";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap()
}
fn restore(bytes: &[u8], journal: &[ReplayUpdate]) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes.into(),
        },
        journal,
    )
    .unwrap()
}
fn raw(d: &Document) -> yrs::Doc {
    let x = m::replica(30001);
    m::apply(&x, &d.checkpoint().bytes).unwrap();
    x
}
fn sources(d: &Document) -> BTreeMap<String, (String, String)> {
    let x = raw(d);
    let t = x.transact();
    t.get_map(m::ROOTS[1])
        .unwrap()
        .iter(&t)
        .map(|(id, value)| {
            let Out::YXmlText(text) = value else {
                panic!("nontext source")
            };
            (
                id.into(),
                (
                    text.diff(&t, |_| ())
                        .into_iter()
                        .map(|r| {
                            let Out::Any(Any::String(s)) = r.insert else {
                                panic!("embedded source content")
                            };
                            s.to_string()
                        })
                        .collect::<String>(),
                    format!("{:?}", AsRef::<yrs::branch::Branch>::as_ref(&text).id()),
                ),
            )
        })
        .collect()
}
fn stable_json(a: &Any) -> String {
    match a {
        Any::Map(v) => {
            let sorted: BTreeMap<_, _> = v.iter().collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(k, v)| format!("{}:{}", m::json(&Any::from(k.as_str())), stable_json(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Any::Array(v) => format!(
            "[{}]",
            v.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        _ => m::json(a),
    }
}
fn canonical(d: &Document) -> String {
    let s = d.snapshot().unwrap();
    // Exclude transaction-local dirty metadata, never semantic content.
    let node = |n: &editac_core::projection::ProjectedNode| {
        m::obj(vec![
            ("id", Any::from(n.id.clone())),
            ("kind", Any::from(n.kind.clone())),
            ("parent", Any::from(n.parent.clone())),
            ("order", Any::from(n.order)),
            (
                "spans",
                m::arr(
                    n.spans
                        .iter()
                        .map(|s| {
                            m::arr(vec![
                                Any::from(s.source.clone()),
                                Any::from(s.identity.clone()),
                                Any::from(s.start),
                                Any::from(s.end),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "runs",
                m::arr(
                    n.runs
                        .iter()
                        .map(|r| {
                            m::obj(vec![
                                ("text", Any::from(r.text.clone())),
                                (
                                    "attributes",
                                    Any::Map(
                                        r.attributes
                                            .clone()
                                            .into_iter()
                                            .collect::<std::collections::HashMap<_, _>>()
                                            .into(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "block",
                n.block_attributes
                    .as_ref()
                    .map(|a| a.tuple())
                    .unwrap_or(Any::Null),
            ),
            (
                "editor",
                n.editor
                    .as_ref()
                    .map(|e| {
                        m::obj(vec![
                            ("version", Any::from(e.version.clone())),
                            (
                                "container",
                                e.container_attributes.clone().unwrap_or(Any::Null),
                            ),
                            ("checked", e.checked.map(Any::Bool).unwrap_or(Any::Null)),
                            ("number", e.number.map(Any::from).unwrap_or(Any::Null)),
                        ])
                    })
                    .unwrap_or(Any::Null),
            ),
        ])
    };
    stable_json(&m::obj(vec![
        (
            "visible",
            m::arr(s.visible.iter().map(|n| node(n)).collect()),
        ),
        (
            "recovery",
            m::arr(s.recovery.iter().map(|n| node(n)).collect()),
        ),
        ("retained", s.retained_structure.unwrap()),
    ]))
}
struct Run {
    dir: PathBuf,
    updates: Vec<ReplayUpdate>,
    writers: [u32; 3],
    trace: Vec<String>,
    branches: [Vec<usize>; 3],
    expected: BTreeMap<String, String>,
    initial: BTreeMap<String, (String, String)>,
}
impl Run {
    fn save(&mut self, branch: usize, name: &str, u: ReplayUpdate) {
        let i = self.updates.len();
        fs::write(self.dir.join(format!("update-{i:03}.bin")), &u.bytes).unwrap();
        self.trace.push(format!(
            "{i}\t{branch}\t{name}\t{}\t{}",
            self.writers[branch],
            self.branches[branch].len()
        ));
        self.branches[branch].push(i);
        self.updates.push(u);
        fs::write(
            self.dir.join("operations.tsv"),
            self.trace.join("\n") + "\n",
        )
        .unwrap();
    }
    fn edit(&mut self, d: &mut Document, branch: usize, name: &str, commands: Vec<EditorCommand>) {
        let before = d.checkpoint().bytes;
        let origin = TextOrigin::new(&format!("replica:{name}")).unwrap();
        d.can_editor(&commands, &origin)
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let plan = d.prepare_editor(&commands, &origin).unwrap();
        assert_eq!(before, d.checkpoint().bytes, "preparation mutated {name}");
        let u = d.commit_editor(plan).unwrap().update;
        self.save(branch, name, u);
    }
    fn history(&mut self, d: &mut Document, branch: usize, redo: bool) {
        let c = if redo { d.redo() } else { d.undo() }
            .unwrap()
            .expect("history group");
        self.save(
            branch,
            if redo { "redo" } else { "undo" },
            c.update.expect("history update"),
        );
    }
    fn insert(&mut self, d: &mut Document, branch: usize, id: &str, text: &str, name: &str) {
        let n = d
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| n.id == id)
            .unwrap();
        let len = n
            .runs
            .iter()
            .map(|r| r.text.encode_utf16().count() as u32)
            .sum();
        let at = d.anchor(id, U(len), Bias::Right).unwrap();
        self.edit(
            d,
            branch,
            name,
            vec![EditorCommand::Text(TextCommand::Insert {
                at,
                text: text.into(),
            })],
        );
    }
    fn split(&mut self, d: &mut Document, id: &str, at: u32, list: bool) -> String {
        let anchor = d.anchor(id, U(at), Bias::Right).unwrap();
        let before: BTreeSet<_> = d
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .map(|n| n.id.clone())
            .collect();
        let command = if list {
            EditorCommand::List(ListCommand::Enter {
                owner: id.into(),
                at: anchor,
            })
        } else {
            EditorCommand::Split {
                owner: id.into(),
                at: anchor,
            }
        };
        self.edit(
            d,
            0,
            if list { "list-enter" } else { "split" },
            vec![command],
        );
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| !before.contains(&n.id) && n.kind == "block")
            .expect("split owner")
            .id
            .clone()
    }
    fn check(&self, d: &Document) {
        let actual = sources(d);
        for (id, expected) in &self.expected {
            assert_eq!(&actual[id].0, expected, "acknowledged source {id}");
        }
        for (id, (_, identity)) in &self.initial {
            assert_eq!(&actual[id].1, identity, "original source identity {id}");
        }
        assert!(actual.values().all(|(text, _)| !text.contains("TEMP-UNDO")));
        let x = raw(d);
        let txn = x.transact();
        for (id, (original, _)) in &self.initial {
            if original.is_empty() {
                continue;
            }
            let plain = &actual[id].0;
            let byte = plain.find(original).expect("original text remains");
            let start = plain[..byte].encode_utf16().count() as u32;
            let end = start + original.encode_utf16().count() as u32;
            let mut offset = 0;
            for run in m::text(&x, id).diff(&txn, |_| ()) {
                let Out::Any(Any::String(text)) = run.insert else {
                    panic!("source embed")
                };
                let next = offset + text.encode_utf16().count() as u32;
                if next > start && offset < end {
                    let attrs = run.attributes.expect("original rich marks");
                    assert_eq!(
                        attrs.get("bold"),
                        Some(&Any::Bool(true)),
                        "original bold {id}"
                    );
                    assert_eq!(
                        attrs.get("ext:future"),
                        Some(&m::obj(vec![("retained", Any::Bool(true))])),
                        "opaque mark {id}"
                    );
                }
                offset = next;
            }
        }
        drop(txn);
        let s = d.snapshot().unwrap();
        editac_core::commands::lists::validate_editor_hierarchy(&s, &[]).unwrap();
        let mut covered: BTreeMap<String, Vec<(u32, u32)>> = BTreeMap::new();
        for n in s.visible.iter().chain(s.recovery.iter()) {
            for span in &n.spans {
                assert!(span.start <= span.end);
                assert!(span.end <= actual[&span.source].0.encode_utf16().count() as u32);
                covered
                    .entry(span.source.clone())
                    .or_default()
                    .push((span.start, span.end));
            }
        }
        // Hidden content is retained in recovery, never silently dropped.
        for (id, text) in &self.expected {
            let len = text.encode_utf16().count() as u32;
            let mut spans = covered.get(id).cloned().unwrap_or_default();
            spans.sort();
            let mut end = 0;
            for (a, b) in spans {
                assert!(a <= end, "uncovered acknowledged range {id}: {a}>{end}");
                end = end.max(b);
            }
            assert_eq!(end, len, "lost acknowledged projection range {id}");
        }
        // Restoration re-runs the actual bounded production schema admission.
        let restored = restore(&d.checkpoint().bytes, &[]);
        assert_eq!(canonical(d), canonical(&restored));
    }
}
// Bounded reliable transport. Sparse Yrs updates can carry deletions before
// replacement metadata arrives, even without a pending Yrs struct. Retain both
// incomplete-causal and incomplete-schema candidates without acknowledging them.
// Admission of their merged bytes still uses production decoding/schema checks.
fn deliver(
    d: &mut Document,
    pending: &mut BTreeSet<usize>,
    i: usize,
    updates: &[ReplayUpdate],
    trace: &mut Vec<String>,
    context: &str,
) -> usize {
    pending.insert(i);
    let merged = yrs::Update::merge_updates(
        pending
            .iter()
            .map(|&i| yrs::Update::decode_v1(&updates[i].bytes).unwrap()),
    )
    .encode_v1();
    let candidate = ReplayUpdate {
        identity: identity(),
        bytes: merged,
    };
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    let history = d.history_state();
    match d.apply_replay(&candidate) {
        Ok(()) => {
            trace.push(format!("{context}\t{pending:?}\tadmitted"));
            pending.clear();
            0
        }
        Err(e @ (DocumentError::IncompleteRestore | DocumentError::UnsupportedSchema)) => {
            assert_eq!(d.checkpoint().bytes, before);
            assert_eq!(d.revision(), revision);
            assert_eq!(d.history_state(), history);
            trace.push(format!("{context}\t{pending:?}\tretained-{e:?}"));
            1
        }
        Err(e) => panic!("{context} update {i}: {e:?}"),
    }
}
fn list(c: ListCommand) -> EditorCommand {
    EditorCommand::List(c)
}
fn block(c: BlockCommand) -> EditorCommand {
    EditorCommand::BlockCommand(c)
}
fn rng(x: &mut u64) -> u64 {
    *x ^= *x << 13;
    *x ^= *x >> 7;
    *x ^= *x << 17;
    *x
}
fn run(file: &str) {
    let fixture = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/replica-seeds")
            .join(file),
    )
    .unwrap();
    let Any::Map(f) = Any::from_json(&fixture).unwrap() else {
        panic!()
    };
    let Any::Number(seed) = f["seed"] else {
        panic!()
    };
    let seed = seed.as_f64().unwrap() as u64;
    let Any::String(family) = &f["family"] else {
        panic!()
    };
    let Any::Map(expected) = &f["expected_sources"] else {
        panic!()
    };
    let root = std::env::var_os("EDITAC_REPLICA_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("editac-replicas-{}", std::process::id()))
        });
    let dir = root.join(file.trim_end_matches(".json"));
    fs::create_dir_all(&dir).unwrap();
    let seed_bytes = m::bytes(&m::seed());
    fs::write(dir.join("seed.bin"), &seed_bytes).unwrap();
    let mut peers: [Document; 3] = std::array::from_fn(|_| {
        let mut d = restore(&seed_bytes, &[]);
        d.enable_history(HistoryConfig::default()).unwrap();
        d
    });
    let writers = peers.each_ref().map(|d| d.writer_id());
    assert_eq!(writers.into_iter().collect::<BTreeSet<_>>().len(), 3);
    fs::write(dir.join("writers.txt"), format!("{writers:?}\n")).unwrap();
    let mut r = Run {
        dir,
        updates: vec![],
        writers,
        trace: vec![],
        branches: std::array::from_fn(|_| vec![]),
        expected: expected
            .iter()
            .map(|(id, a)| {
                let Any::String(s) = a else { panic!() };
                (id.clone(), s.to_string())
            })
            .collect(),
        initial: sources(&peers[0]),
    };
    // Two independent acknowledged source edits stay disconnected from structural authors.
    r.insert(&mut peers[1], 1, B, &format!("[ack:{seed}:B]"), "ack-B");
    r.insert(&mut peers[2], 2, C, &format!("[ack:{seed}:C]"), "ack-C");
    match family.as_ref() {
        "structure" => {
            let right = r.split(&mut peers[0], A, 1, false);
            r.edit(
                &mut peers[0],
                0,
                "join-split",
                vec![EditorCommand::Join {
                    first: A.into(),
                    second: right,
                }],
            );
            r.edit(
                &mut peers[0],
                0,
                "join-originals",
                vec![EditorCommand::Join {
                    first: A.into(),
                    second: B.into(),
                }],
            );
            let right = r.split(&mut peers[0], A, 4, false);
            r.edit(
                &mut peers[0],
                0,
                "repeat-join",
                vec![EditorCommand::Join {
                    first: A.into(),
                    second: right,
                }],
            );
            r.edit(
                &mut peers[0],
                0,
                "heading-retained-join",
                vec![EditorCommand::Block {
                    target: A.into(),
                    tuple: m::arr(vec![Any::from("heading"), Any::from(1 + (seed % 6) as u32)]),
                }],
            );
            r.history(&mut peers[0], 0, false);
            r.history(&mut peers[0], 0, true);
        }
        "lists" => {
            r.edit(
                &mut peers[0],
                0,
                "wrap-quote",
                vec![list(ListCommand::Wrap {
                    targets: vec![C.into()],
                    style: ContainerStyle::Quote,
                })],
            );
            let wrap = peers[0].next_editor_id(true).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "wrap-checklist",
                vec![list(ListCommand::Wrap {
                    targets: vec![A.into(), B.into()],
                    style: ContainerStyle::Checklist,
                })],
            );
            r.edit(
                &mut peers[0],
                0,
                "style-checklist",
                vec![
                    list(ListCommand::SetStyle {
                        container: wrap.clone(),
                        style: ContainerStyle::Checklist,
                    }),
                    list(ListCommand::SetChecked {
                        owner: A.into(),
                        checked: true,
                    }),
                ],
            );
            let right = r.split(&mut peers[0], A, 1, true);
            let at = peers[0].anchor(&right, U(0), Bias::Right).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "list-backspace",
                vec![list(ListCommand::Backspace { owner: right, at })],
            );
            r.edit(
                &mut peers[0],
                0,
                "indent",
                vec![list(ListCommand::Indent { owner: B.into() })],
            );
            r.edit(
                &mut peers[0],
                0,
                "outdent",
                vec![list(ListCommand::Outdent { owner: B.into() })],
            );
            r.edit(
                &mut peers[0],
                0,
                "style-ordered",
                vec![list(ListCommand::SetStyle {
                    container: wrap.clone(),
                    style: ContainerStyle::Ordered {
                        start: 1 + (seed % 19) as u32,
                    },
                })],
            );
            r.edit(
                &mut peers[0],
                0,
                "style-unordered",
                vec![list(ListCommand::SetStyle {
                    container: wrap,
                    style: ContainerStyle::Unordered,
                })],
            );
            let at = peers[0].anchor(D, U(0), Bias::Right).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "empty-item-exit",
                vec![list(ListCommand::Enter {
                    owner: D.into(),
                    at,
                })],
            );
            r.history(&mut peers[0], 0, false);
            r.history(&mut peers[0], 0, true);
        }
        "blocks" => {
            let language = if seed % 2 == 0 { "rust" } else { "future-lang" };
            r.edit(
                &mut peers[0],
                0,
                "code",
                vec![
                    block(BlockCommand::SetCode {
                        owner: A.into(),
                        language: language.into(),
                    }),
                    block(BlockCommand::SetCode {
                        owner: B.into(),
                        language: language.into(),
                    }),
                ],
            );
            r.edit(
                &mut peers[0],
                0,
                "code-join",
                vec![block(BlockCommand::Join {
                    first: A.into(),
                    second: B.into(),
                })],
            );
            let at = peers[0].anchor(A, U(0), Bias::Right).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "hard-break",
                vec![block(BlockCommand::HardBreak { at })],
            );
            let right = r.split(&mut peers[0], A, 1, false);
            r.edit(
                &mut peers[0],
                0,
                "code-repeat-join",
                vec![block(BlockCommand::Join {
                    first: A.into(),
                    second: right,
                })],
            );
            r.edit(
                &mut peers[0],
                0,
                "paragraph-conversion",
                vec![block(BlockCommand::SetParagraph { owner: A.into() })],
            );
            let separator = peers[0].next_editor_id(false).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "insert-separator",
                vec![block(BlockCommand::InsertSeparator {
                    beside: C.into(),
                    side: Side::Before,
                })],
            );
            let para = peers[0].next_editor_id(false).unwrap();
            let token = format!("[ack:{seed}:paragraph]");
            r.edit(
                &mut peers[0],
                0,
                "typing-neighbor",
                vec![block(BlockCommand::InsertParagraph {
                    separator: separator.clone(),
                    side: Side::After,
                    text: token.clone(),
                })],
            );
            r.expected.insert(para, token);
            r.edit(
                &mut peers[0],
                0,
                "delete-separator",
                vec![block(BlockCommand::DeleteSeparator { owner: separator })],
            );
            r.edit(
                &mut peers[0],
                0,
                "convert-empty-separator",
                vec![block(BlockCommand::ConvertSeparator { owner: D.into() })],
            );
            r.history(&mut peers[0], 0, false);
            r.history(&mut peers[0], 0, true);
        }
        "moves" => {
            let container = peers[0].next_editor_id(true).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "create-container",
                vec![EditorCommand::Create {
                    id: container.clone(),
                    kind: "quote".into(),
                    text: String::new(),
                    tuple: m::arr(vec![Any::from("quote")]),
                }],
            );
            let leaf = peers[0].next_editor_id(false).unwrap();
            let token = format!("[ack:{seed}:created]");
            r.edit(
                &mut peers[0],
                0,
                "create-leaf",
                vec![
                    EditorCommand::Create {
                        id: leaf.clone(),
                        kind: "block".into(),
                        text: token.clone(),
                        tuple: m::arr(vec![Any::from("paragraph")]),
                    },
                    EditorCommand::Place {
                        target: leaf.clone(),
                        parent: container.clone(),
                        before: None,
                    },
                ],
            );
            r.expected.insert(leaf, token);
            let command = peers[0].move_command(K, &container, None).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "move-subtree",
                vec![EditorCommand::Move(command)],
            );
            r.edit(
                &mut peers[0],
                0,
                "hide-parent",
                vec![EditorCommand::Enable {
                    target: container.clone(),
                    enabled: false,
                }],
            );
            r.history(&mut peers[0], 0, false);
            r.history(&mut peers[0], 0, true);
            r.edit(
                &mut peers[0],
                0,
                "show-parent",
                vec![EditorCommand::Enable {
                    target: container,
                    enabled: true,
                }],
            );
            let command = peers[0].move_command(B, W, None).unwrap();
            r.edit(
                &mut peers[0],
                0,
                "move-race-left",
                vec![EditorCommand::Move(command)],
            );
            let command = peers[1].move_command(B, Q, None).unwrap();
            r.edit(
                &mut peers[1],
                1,
                "move-race-right",
                vec![EditorCommand::Move(command)],
            );
            // Local undo after actual remote admission must preserve that remote edit.
            r.insert(&mut peers[2], 2, A, "TEMP-UNDO", "typing-to-undo");
            peers[2].apply_replay(&r.updates[0]).unwrap();
            r.history(&mut peers[2], 2, false);
            assert!(sources(&peers[2])[B].0.contains(&format!("[ack:{seed}:B]")));
        }
        _ => panic!("unknown published family"),
    }
    // Every family also exercises independently authored placement/metadata racing edits.
    if family.as_ref() != "moves" {
        let command = peers[1].move_command(C, W, None).unwrap();
        r.edit(
            &mut peers[1],
            1,
            "remote-move-edit",
            vec![EditorCommand::Move(command)],
        );
        r.edit(
            &mut peers[2],
            2,
            "remote-check",
            vec![EditorCommand::Check {
                target: C.into(),
                checked: seed % 2 == 1,
            }],
        );
    }
    // Independent reference fold, plus independent source/identity/schema oracles.
    let mut reference = restore(&seed_bytes, &[]);
    for u in &r.updates {
        reference.apply_replay(u).unwrap();
    }
    r.check(&reference);
    let expected = canonical(&reference);
    fs::write(r.dir.join("canonical.json"), &expected).unwrap();
    let mut schedules = vec![
        (0..r.updates.len()).collect::<Vec<_>>(),
        (0..r.updates.len()).rev().collect(),
    ];
    for perm in PERMS {
        schedules.push(
            perm.into_iter()
                .flat_map(|b| r.branches[b].iter().copied())
                .collect(),
        );
    }
    let mut state = seed;
    for _ in 0..12 {
        let mut order = (0..r.updates.len()).collect::<Vec<_>>();
        for i in (1..order.len()).rev() {
            let j = (rng(&mut state) as usize) % (i + 1);
            order.swap(i, j);
        }
        schedules.push(order);
    }
    fs::write(r.dir.join("schedules.txt"), format!("{schedules:?}\n")).unwrap();
    let mut delivery_trace = Vec::new();
    let mut deferred = 0;
    for (schedule, order) in schedules.iter().enumerate() {
        let mut d = restore(&seed_bytes, &[]);
        let mut pending = BTreeSet::new();
        for (arrival, &i) in order.iter().enumerate() {
            for _ in 0..2 {
                deferred += deliver(
                    &mut d,
                    &mut pending,
                    i,
                    &r.updates,
                    &mut delivery_trace,
                    &format!("schedule={schedule} arrival={arrival}"),
                );
                fs::write(
                    r.dir.join("deliveries.tsv"),
                    delivery_trace.join("\n") + "\n",
                )
                .unwrap();
            }
            if arrival == order.len() / 2 {
                let tail = pending
                    .iter()
                    .copied()
                    .chain(order[arrival + 1..].iter().copied())
                    .map(|i| r.updates[i].clone())
                    .collect::<Vec<_>>();
                let resumed = restore(&d.checkpoint().bytes, &tail);
                r.check(&resumed);
                assert_eq!(
                    canonical(&resumed),
                    expected,
                    "journal resume seed {seed}, schedule {schedule}"
                );
                // Restart the disconnected receiver, retaining its durable unadmitted queue.
                d = restore(&d.checkpoint().bytes, &[]);
            }
        }
        assert!(
            pending.is_empty(),
            "unacknowledged queue seed {seed}, schedule {schedule}: {pending:?}"
        );
        r.check(&d);
        let actual = canonical(&d);
        if actual != expected {
            fs::write(r.dir.join(format!("divergence-{schedule}.json")), &actual).unwrap();
        }
        assert_eq!(actual, expected, "seed {seed}, schedule {schedule}");
    }
    for (role, d) in peers.iter_mut().enumerate() {
        let mut pending = BTreeSet::new();
        for &i in &schedules[8 + role] {
            for _ in 0..2 {
                deferred += deliver(
                    d,
                    &mut pending,
                    i,
                    &r.updates,
                    &mut delivery_trace,
                    &format!("live={role}"),
                );
            }
        }
        assert!(pending.is_empty());
        r.check(d);
        assert_eq!(canonical(d), expected, "live writer catchup {role}");
    }
    fs::write(
        r.dir.join("deliveries.tsv"),
        delivery_trace.join("\n") + "\n",
    )
    .unwrap();
    fs::write(r.dir.join("deferred.txt"), format!("{deferred}\n")).unwrap();
    fs::write(r.dir.join("coverage.txt"),format!("seed={seed}\nfamily={family}\nwriters={:?}\nupdates={}\nschedules={}\nlive_catchups=3\ncheckpoint_journal_restores={}\nduplicate_factor=2\npassed=1\n",r.writers,r.updates.len(),schedules.len(),schedules.len())).unwrap();
    println!(
        "seed={seed} family={family} updates={} schedules={} live=3 restores={} passed",
        r.updates.len(),
        schedules.len(),
        schedules.len()
    );
}
macro_rules! case {
    ($name:ident,$file:literal) => {
        #[test]
        fn $name() {
            run($file)
        }
    };
}
case!(seed_17_structure, "01-structure.json");
case!(seed_9127_structure, "02-structure.json");
case!(seed_41_lists, "03-lists.json");
case!(seed_65003_lists, "04-lists.json");
case!(seed_73_blocks, "05-blocks.json");
case!(seed_99991_blocks, "06-blocks.json");
case!(seed_101_moves, "07-moves.json");
case!(seed_4294967291_moves, "08-moves.json");

#[test]
fn frozen_complete_reordered_history_journal() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/replica-seeds/causal-history");
    let seed = fs::read(root.join("seed.bin")).unwrap();
    let mut updates = (0..16)
        .map(|i| ReplayUpdate {
            identity: identity(),
            bytes: fs::read(root.join(format!("update-{i:03}.bin"))).unwrap(),
        })
        .collect::<Vec<_>>();
    // Exact failing mid-disconnect journal: unresolved received updates, then
    // the rest of the reverse arrival stream. All sixteen dependencies exist.
    let order = (7..16).chain((0..7).rev()).collect::<Vec<_>>();
    let journal = order
        .into_iter()
        .map(|i| updates[i].clone())
        .collect::<Vec<_>>();
    let d = restore(&seed, &journal);
    assert_eq!(
        canonical(&d),
        fs::read_to_string(root.join("canonical.json")).unwrap()
    );
    updates.reverse();
    let d = restore(&seed, &updates);
    assert_eq!(
        canonical(&d),
        fs::read_to_string(root.join("canonical.json")).unwrap()
    );
}

#[test]
fn frozen_list_incremental_arrival() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/replica-seeds/list-arrival");
    let seed = fs::read(root.join("seed.bin")).unwrap();
    let updates = (0..16)
        .map(|i| ReplayUpdate {
            identity: identity(),
            bytes: fs::read(root.join(format!("update-{i:03}.bin"))).unwrap(),
        })
        .collect::<Vec<_>>();
    let mut d = restore(&seed, &[]);
    let mut pending = BTreeSet::new();
    let mut trace = vec![];
    for i in [10, 6, 15, 3, 13, 8, 4, 12, 7, 0, 5, 2, 1, 11, 14, 9] {
        deliver(&mut d, &mut pending, i, &updates, &mut trace, "frozen list");
    }
    assert!(pending.is_empty());
    assert_eq!(
        canonical(&d),
        fs::read_to_string(root.join("canonical.json")).unwrap()
    );
}
