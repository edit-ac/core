//! REG-05 native committed semantics; transient pending state belongs to the host.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution, Selection},
    commands::{
        blocks::BlockCommand,
        editor::{EditorCommand as C, EditorPosition},
        format::{FormatAction, Mark},
        text::TextOrigin,
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
};
use std::sync::atomic::{AtomicU64, Ordering};
fn commit(d: &mut Document, c: &[C]) -> editac_core::commands::editor::EditorCommit {
    let p = d
        .prepare_editor(c, &TextOrigin::new("local:rgs:c4").unwrap())
        .unwrap();
    d.commit_editor(p).unwrap()
}
fn engine(atom: bool) -> (Document, String, String) {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = DocumentIdentity::v5(
        format!("42500000-0000-4000-8000-{n:012}"),
        format!("42500000-0000-4000-9000-{n:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &["", "a", ""].map(|text| InitialNode {
            kind: "block".into(),
            text: text.into(),
        }),
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    let nodes = d.snapshot().unwrap().visible;
    let rule = nodes[0].id.clone();
    let owner = nodes[1].id.clone();
    let mut setup = vec![C::MarkAt {
        owner: owner.clone(),
        from: U(0),
        to: U(1),
        mark: Mark::Bold,
        action: FormatAction::Apply,
        href: None,
    }];
    if atom {
        setup.push(C::BlockCommand(BlockCommand::ConvertSeparator {
            owner: rule.clone(),
        }));
    }
    commit(&mut d, &setup);
    d.clear_history();
    (d, rule, owner)
}
fn bookmark(owner: &str, offset: u32, bias: Bias, entry: bool) -> C {
    let anchor = EditorPosition {
        owner: owner.into(),
        offset: U(offset),
        bias,
    };
    let focus = anchor.clone();
    if entry {
        C::HistorySelectionAt { anchor, focus }
    } else {
        C::SelectionAt { anchor, focus }
    }
}
fn selection(d: &Document, s: &Selection, owner: &str, offset: u32, bias: Bias) {
    for a in [&s.anchor, &s.focus] {
        let Resolution::Position(p) = d.resolve_anchor(a).unwrap() else {
            panic!("missing native endpoint")
        };
        assert_eq!(p.node, owner);
        assert_eq!(p.offset, U(offset));
        assert_eq!(p.bias, bias);
    }
}
fn content(d: &Document, owner: &str, text: &str, bold_start: usize) {
    let n = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == owner)
        .unwrap();
    assert_eq!(
        n.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
        text
    );
    let mut offset = 0;
    for r in &n.runs {
        for _ in r.text.chars() {
            assert_eq!(r.attributes.contains_key("bold"), offset >= bold_start);
            offset += 1;
        }
    }
}
fn lifecycle(atom: bool, allowed: bool, bias: Bias) {
    let (mut d, rule, owner) = engine(atom);
    let original = d.snapshot().unwrap();
    let sources = original.visible[1]
        .spans
        .iter()
        .map(|s| s.source.clone())
        .collect::<Vec<_>>();
    let frozen = (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    );
    let c = if atom {
        BlockCommand::DeleteSeparator {
            owner: rule.clone(),
        }
    } else {
        BlockCommand::AlignLeft {
            owner: owner.clone(),
        }
    };
    let result = commit(
        &mut d,
        &[
            bookmark(&owner, 0, bias, true),
            C::BlockCommand(c),
            bookmark(&owner, 0, bias, false),
        ],
    );
    selection(
        &d,
        result.result_selection.as_ref().unwrap(),
        &owner,
        0,
        bias,
    );
    if !atom {
        assert_eq!(
            (
                d.checkpoint().bytes,
                d.state_vector_v1(),
                d.revision(),
                d.history_state()
            ),
            frozen
        );
    }
    let typing = |s: &str, from: u32, marked: bool| {
        vec![
            bookmark(&owner, from, bias, true),
            C::ReplaceAt {
                owner: owner.clone(),
                from: U(from),
                to: U(from),
                text: s.into(),
            },
            C::MarkAt {
                owner: owner.clone(),
                from: U(from),
                to: U(from + 1),
                mark: Mark::Bold,
                action: if marked {
                    FormatAction::Apply
                } else {
                    FormatAction::Remove
                },
                href: None,
            },
            bookmark(&owner, from + 1, bias, false),
        ]
    };
    let typed = commit(&mut d, &typing("X", 0, allowed));
    selection(
        &d,
        typed.result_selection.as_ref().unwrap(),
        &owner,
        1,
        bias,
    );
    content(&d, &owner, "Xa", if allowed { 0 } else { 1 });
    assert_eq!(d.history_state().undo_groups, if atom { 2 } else { 1 });
    let undo = d.undo().unwrap().unwrap();
    selection(&d, undo.selection.as_ref().unwrap(), &owner, 0, bias);
    content(&d, &owner, "a", 0);
    if atom {
        let undo = d.undo().unwrap().unwrap();
        selection(&d, undo.selection.as_ref().unwrap(), &owner, 0, bias);
        assert_eq!(d.snapshot().unwrap().visible, original.visible);
        let redo = d.redo().unwrap().unwrap();
        selection(&d, redo.selection.as_ref().unwrap(), &owner, 0, bias);
    }
    let redo = d.redo().unwrap().unwrap();
    selection(&d, redo.selection.as_ref().unwrap(), &owner, 1, bias);
    content(&d, &owner, "Xa", if allowed { 0 } else { 1 });
    let sentinel_allowed = allowed || bias == Bias::Right;
    let sentinel = commit(&mut d, &typing("S", 1, sentinel_allowed));
    selection(
        &d,
        sentinel.result_selection.as_ref().unwrap(),
        &owner,
        2,
        bias,
    );
    content(
        &d,
        &owner,
        "XSa",
        if allowed {
            0
        } else if sentinel_allowed {
            1
        } else {
            2
        },
    );
    let n = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == owner)
        .unwrap();
    assert_eq!(
        n.spans.iter().map(|s| s.source.clone()).collect::<Vec<_>>(),
        sources
    );
}
macro_rules! case {
    ($name:ident, $atom:expr, $allowed:expr, $bias:expr) => {
        #[test]
        fn $name() {
            lifecycle($atom, $allowed, $bias);
        }
    };
}
case!(align_bold_forward, false, true, Bias::Right);
case!(align_bold_backward, false, true, Bias::Left);
case!(align_empty_forward, false, false, Bias::Right);
case!(align_empty_backward, false, false, Bias::Left);
case!(separator_bold_forward, true, true, Bias::Right);
case!(separator_bold_backward, true, true, Bias::Left);
case!(separator_empty_forward, true, false, Bias::Right);
case!(separator_empty_backward, true, false, Bias::Left);
#[test]
fn final_bad_alignment_rejects_text_and_separator_deletion() {
    let (d, rule, owner) = engine(true);
    let before = (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    );
    let bad = vec![
        C::ReplaceAt {
            owner,
            from: U(0),
            to: U(0),
            text: "BAD".into(),
        },
        C::BlockCommand(BlockCommand::DeleteSeparator {
            owner: rule.clone(),
        }),
        C::BlockCommand(BlockCommand::AlignLeft {
            owner: "missing".into(),
        }),
    ];
    assert!(
        d.prepare_editor(&bad, &TextOrigin::new("local:rgs:c4").unwrap())
            .is_err()
    );
    assert!(
        d.prepare_blocks(
            &[BlockCommand::AlignLeft { owner: rule }],
            &TextOrigin::new("local:rgs:c4").unwrap()
        )
        .is_err()
    );
    assert_eq!(
        (
            d.checkpoint().bytes,
            d.state_vector_v1(),
            d.revision(),
            d.history_state()
        ),
        before
    );
}

#[test]
fn separator_alignment_text_and_mark_are_one_atomic_action() {
    for bias in [Bias::Left, Bias::Right] {
        let (mut d, rule, owner) = engine(true);
        let original = d.snapshot().unwrap().visible;
        let commands = vec![
            bookmark(&owner, 0, bias, true),
            C::BlockCommand(BlockCommand::DeleteSeparator { owner: rule }),
            C::BlockCommand(BlockCommand::AlignLeft {
                owner: owner.clone(),
            }),
            C::ReplaceAt {
                owner: owner.clone(),
                from: U(0),
                to: U(0),
                text: "X".into(),
            },
            C::MarkAt {
                owner: owner.clone(),
                from: U(0),
                to: U(1),
                mark: Mark::Bold,
                action: FormatAction::Apply,
                href: None,
            },
            bookmark(&owner, 1, bias, false),
        ];
        let before = (
            d.checkpoint().bytes,
            d.state_vector_v1(),
            d.revision(),
            d.history_state(),
        );
        let plan = d
            .prepare_editor(&commands, &TextOrigin::new("local:rgs:c4").unwrap())
            .unwrap();
        assert_eq!(
            (
                d.checkpoint().bytes,
                d.state_vector_v1(),
                d.revision(),
                d.history_state()
            ),
            before
        );
        let result = d.commit_editor(plan).unwrap();
        assert_eq!(d.revision(), before.2 + 1);
        assert_eq!(d.history_state().undo_groups, 1);
        selection(
            &d,
            result.result_selection.as_ref().unwrap(),
            &owner,
            1,
            bias,
        );
        content(&d, &owner, "Xa", 0);
        let undo = d.undo().unwrap().unwrap();
        selection(&d, undo.selection.as_ref().unwrap(), &owner, 0, bias);
        assert_eq!(d.snapshot().unwrap().visible, original);
        let redo = d.redo().unwrap().unwrap();
        selection(&d, redo.selection.as_ref().unwrap(), &owner, 1, bias);
        content(&d, &owner, "Xa", 0);
    }
}
