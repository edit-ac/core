//! RGS-1.2 upstream primitive: independent native text/mark/selection oracles.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{editor::*, format::*, text::*},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    patches::PatchScope,
};
use std::{
    cell::Cell,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
use yrs::Any;
fn origin() -> TextOrigin {
    TextOrigin::new("atomic:fixture").unwrap()
}
fn document(text: &str) -> Document {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = DocumentIdentity::v5(
        format!("42100000-0000-4000-8000-{n:012}"),
        format!("42100000-0000-4000-9000-{n:012}"),
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
    d
}
fn owner(d: &Document) -> String {
    d.snapshot().unwrap().visible[0].id.clone()
}
fn replace(owner: &str, from: u32, to: u32, text: &str) -> EditorCommand {
    EditorCommand::ReplaceAt {
        owner: owner.into(),
        from: U(from),
        to: U(to),
        text: text.into(),
    }
}
fn mark(owner: &str, from: u32, to: u32) -> EditorCommand {
    EditorCommand::MarkAt {
        owner: owner.into(),
        from: U(from),
        to: U(to),
        mark: Mark::Bold,
        action: FormatAction::Apply,
        href: None,
    }
}
fn selection(owner: &str, anchor: u32, focus: u32) -> EditorCommand {
    EditorCommand::SelectionAt {
        anchor: EditorPosition {
            owner: owner.into(),
            offset: U(anchor),
            bias: Bias::Left,
        },
        focus: EditorPosition {
            owner: owner.into(),
            offset: U(focus),
            bias: Bias::Right,
        },
    }
}
fn frozen(d: &Document) -> (Vec<u8>, Vec<u8>, u64, editac_core::history::HistoryState) {
    (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    )
}
fn reject(d: &Document, commands: &[EditorCommand]) {
    let old = frozen(d);
    assert!(d.prepare_editor(commands, &origin()).is_err());
    assert_eq!(frozen(d), old);
}
#[test]
fn invalid_last_mark_then_valid_retry_is_one_identity_preserving_commit() {
    let mut d = document("abc");
    let id = owner(&d);
    let original = d.snapshot().unwrap().visible[0].clone();
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    reject(&d, &[replace(&id, 1, 1, "X"), mark("missing", 1, 2)]);
    assert_eq!(count.get(), 0);
    let old = frozen(&d);
    let p = d
        .prepare_editor(
            &[
                replace(&id, 1, 1, "X"),
                mark(&id, 1, 2),
                selection(&id, 2, 2),
            ],
            &origin(),
        )
        .unwrap();
    assert_eq!(frozen(&d), old);
    let result = d.commit_editor(p).unwrap();
    assert_eq!(count.get(), 1);
    assert_eq!(result.revision, old.2 + 1);
    assert_eq!(d.history_state().undo_groups, 1);
    let node = d.snapshot().unwrap().visible[0].clone();
    assert_eq!(node.id, original.id);
    assert_eq!(node.spans[0].source, original.spans[0].source);
    assert_eq!(node.spans[0].identity, original.spans[0].identity);
    assert_eq!(
        node.runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "aXbc"
    );
    assert_eq!(node.runs.len(), 3);
    assert_eq!(node.runs[1].text, "X");
    assert_eq!(node.runs[1].attributes.get("bold"), Some(&Any::Bool(true)));
    assert!(node.runs[0].attributes.is_empty());
    assert!(node.runs[2].attributes.is_empty());
    let selection = result.result_selection.unwrap();
    for a in [&selection.anchor, &selection.focus] {
        match d.resolve_anchor(a).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.node, id);
                assert_eq!(p.offset, U(2));
            }
            _ => panic!("missing selection"),
        }
    }
    d.undo().unwrap().unwrap();
    let n = d.snapshot().unwrap().visible[0].clone();
    assert_eq!(n.id, id);
    assert_eq!(
        n.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
        "abc"
    );
    assert!(n.runs.iter().all(|r| r.attributes.is_empty()));
}
#[test]
fn backward_result_endpoints_and_biases_are_not_collapsed() {
    let mut d = document("abc");
    let id = owner(&d);
    let p = d
        .prepare_editor(
            &[
                replace(&id, 1, 1, "X"),
                mark(&id, 1, 2),
                selection(&id, 4, 1),
            ],
            &origin(),
        )
        .unwrap();
    let r = d.commit_editor(p).unwrap().result_selection.unwrap();
    for (a, offset, bias) in [(&r.anchor, 4, Bias::Left), (&r.focus, 1, Bias::Right)] {
        match d.resolve_anchor(a).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.offset, U(offset));
                assert_eq!(p.bias, bias);
            }
            _ => panic!("missing endpoint"),
        }
    }
}
#[test]
fn staged_utf16_surrogate_cut_and_invalid_result_reject_all_changes() {
    let d = document("a😀b");
    let id = owner(&d);
    reject(&d, &[replace(&id, 1, 1, "X"), mark(&id, 3, 4)]);
    reject(
        &d,
        &[
            replace(&id, 1, 1, "X"),
            mark(&id, 1, 2),
            selection(&id, 99, 2),
        ],
    );
    reject(&d, &[selection(&id, 1, 1), replace(&id, 1, 1, "X")]);
}
#[test]
fn ordered_replacements_resolve_against_prior_staged_edits() {
    let mut d = document("abc");
    let id = owner(&d);
    let p = d
        .prepare_editor(
            &[
                replace(&id, 1, 1, "XY"),
                replace(&id, 2, 3, "Z"),
                mark(&id, 1, 3),
                selection(&id, 3, 3),
            ],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    let n = d.snapshot().unwrap().visible[0].clone();
    assert_eq!(
        n.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
        "aXZbc"
    );
    assert_eq!(n.runs[1].text, "XZ");
    assert_eq!(n.runs[1].attributes.get("bold"), Some(&Any::Bool(true)));
}
#[test]
fn live_change_rejects_prepared_batch_without_extra_history_or_publication() {
    let mut d = document("abc");
    let id = owner(&d);
    let plan = d
        .prepare_editor(
            &[
                replace(&id, 1, 1, "X"),
                mark(&id, 1, 2),
                selection(&id, 2, 2),
            ],
            &origin(),
        )
        .unwrap();
    let other = d
        .prepare_editor(&[replace(&id, 0, 0, "Z")], &origin())
        .unwrap();
    d.commit_editor(other).unwrap();
    let old = frozen(&d);
    assert!(d.commit_editor(plan).is_err());
    assert_eq!(frozen(&d), old);
}

#[test]
fn code_mark_and_invalid_link_policy_reject_staged_text_prefix() {
    let mut d = document("abc");
    let id = owner(&d);
    let invalid_link = EditorCommand::MarkAt {
        owner: id.clone(),
        from: U(1),
        to: U(2),
        mark: Mark::Link,
        action: FormatAction::Apply,
        href: Some("javascript:alert(1)".into()),
    };
    reject(&d, &[replace(&id, 1, 1, "X"), invalid_link]);
    let p = d
        .prepare_editor(
            &[EditorCommand::BlockCommand(
                editac_core::commands::blocks::BlockCommand::SetCode {
                    owner: id.clone(),
                    language: "rust".into(),
                },
            )],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    reject(&d, &[replace(&id, 1, 1, "X"), mark(&id, 1, 2)]);
}
