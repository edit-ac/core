//! INT-1.4 DEL-01/02/07 shared native and mounted-WASM vector corpus.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{
        editor::{EditorCommand as C, EditorPosition},
        format::{FormatAction, Mark},
        text::TextOrigin,
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
};
fn engine(text: &str) -> (Document, String) {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = DocumentIdentity::v5(
        format!("42500000-0000-4000-8000-{n:012}"),
        format!("42500000-0000-4000-9000-{n:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: text.into(),
        }],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    (d, owner)
}
fn commit(d: &mut Document, c: &[C]) -> editac_core::commands::editor::EditorCommit {
    let p = d
        .prepare_editor(c, &TextOrigin::new("local:deletion").unwrap())
        .unwrap();
    d.commit_editor(p).unwrap()
}
#[test]
fn shared_vectors_delete_exact_graphemes_preserve_marks_and_undo() {
    let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/deletion-vectors.json"
    ))
    .unwrap();
    assert_eq!(vectors.len(), 8);
    let mut executed = 0;
    for v in vectors {
        let cluster = v["cluster"].as_str().unwrap();
        for (prefix, suffix) in [("", "b"), ("a", "b"), ("a", "")] {
            for backward in [false, true] {
                let text = format!("{prefix}{cluster}{suffix}");
                let (mut d, owner) = engine(&text);
                commit(
                    &mut d,
                    &[C::MarkAt {
                        owner: owner.clone(),
                        from: U(0),
                        to: U(text.encode_utf16().count() as u32),
                        mark: Mark::Bold,
                        action: FormatAction::Apply,
                        href: None,
                    }],
                );
                d.clear_history();
                let before = d.snapshot().unwrap().visible;
                let offset = U((prefix.encode_utf16().count()
                    + if backward {
                        cluster.encode_utf16().count()
                    } else {
                        0
                    }) as u32);
                let point = EditorPosition {
                    owner: owner.clone(),
                    offset,
                    bias: Bias::Right,
                };
                let result = commit(
                    &mut d,
                    &[
                        C::HistorySelectionAt {
                            anchor: point.clone(),
                            focus: point,
                        },
                        C::DeleteGraphemeAt {
                            owner: owner.clone(),
                            offset,
                            backward,
                        },
                    ],
                );
                let after = d.snapshot().unwrap().visible;
                assert_eq!(
                    after[0]
                        .runs
                        .iter()
                        .map(|r| r.text.as_str())
                        .collect::<String>(),
                    format!("{prefix}{suffix}")
                );
                assert!(
                    after[0]
                        .runs
                        .iter()
                        .all(|r| r.attributes.contains_key("bold"))
                );
                match d
                    .resolve_anchor(result.result_caret.as_ref().unwrap())
                    .unwrap()
                {
                    Resolution::Position(point) => {
                        assert_eq!(point.offset, U(prefix.len() as u32))
                    }
                    _ => panic!(),
                };
                assert_eq!(d.history_state().undo_groups, 1);
                d.undo().unwrap().unwrap();
                assert_eq!(d.snapshot().unwrap().visible, before);
                d.redo().unwrap().unwrap();
                assert_eq!(d.snapshot().unwrap().visible, after);
                executed += 1;
            }
        }
    }
    assert_eq!(executed, 48);
}
#[test]
fn document_edges_are_zero_mutation_zero_history() {
    for (text, offset, backward) in [
        ("ab", 0, true),
        ("ab", 2, false),
        ("", 0, true),
        ("", 0, false),
    ] {
        let (mut d, owner) = engine(text);
        let before = (d.checkpoint().bytes, d.revision(), d.history_state());
        commit(
            &mut d,
            &[C::DeleteGraphemeAt {
                owner,
                offset: U(offset),
                backward,
            }],
        );
        assert_eq!(
            (d.checkpoint().bytes, d.revision(), d.history_state()),
            before
        );
    }
}
#[test]
fn invalid_cuts_reject_whole_prepared_batch() {
    for (text, offset) in [("e\u{301}", 1), ("😀", 1), ("👨‍👩‍👧‍👦", 2), ("abc", 9)]
    {
        let (d, owner) = engine(text);
        let before = (d.checkpoint().bytes, d.revision(), d.history_state());
        let result = d.prepare_editor(
            &[
                C::MarkAt {
                    owner: owner.clone(),
                    from: U(0),
                    to: U(text.encode_utf16().count() as u32),
                    mark: Mark::Bold,
                    action: FormatAction::Apply,
                    href: None,
                },
                C::DeleteGraphemeAt {
                    owner,
                    offset: U(offset),
                    backward: true,
                },
            ],
            &TextOrigin::new("local:deletion").unwrap(),
        );
        assert!(result.is_err());
        assert_eq!(
            (d.checkpoint().bytes, d.revision(), d.history_state()),
            before
        );
    }
}
