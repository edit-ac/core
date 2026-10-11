//! FND-1.7: real single-Yrs-replica tombstone/recovery probe. No provider calls.
#[path = "support/delete_edit.rs"]
mod policy;

use policy::{Projection, registry};
use std::{collections::HashMap, fs, path::PathBuf};
use yrs::{Any, Doc, ReadTxn, StateVector, Text, Transact};

fn delta(doc: &Doc, base: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(base)
}

fn writer(id: u64, base: &[u8]) -> Doc {
    let doc = registry::replica(id);
    registry::apply(&doc, base);
    doc
}

fn assert_hidden(
    p: &Projection,
    identity: &str,
    expected: &str,
    runs: &[(String, Vec<(String, String)>)],
) {
    assert!(
        p.visible.is_none(),
        "a tombstone must never resurrect implicitly"
    );
    let recovery = p.recovery.as_ref().expect("deleted content is recoverable");
    assert_eq!(recovery.block_id, "block-1");
    assert_eq!(recovery.text_identity, identity);
    assert_eq!((&*recovery.parent, recovery.order), ("left", 0));
    assert_eq!(
        recovery.runs, runs,
        "recover text and marks, not plain text only"
    );
    assert_eq!(
        recovery
            .runs
            .iter()
            .map(|(s, _)| s.as_str())
            .collect::<String>(),
        expected
    );
    assert_eq!(recovery.utf16_len as usize, expected.encode_utf16().count());
}

fn original_runs() -> Vec<(String, Vec<(String, String)>)> {
    vec![
        ("a".into(), vec![]),
        ("😀".into(), vec![("bold".into(), "true".into())]),
        ("b".into(), vec![]),
    ]
}

fn edited_runs() -> Vec<(String, Vec<(String, String)>)> {
    let mut runs = original_runs();
    runs.insert(2, ("!".into(), vec![("italic".into(), "true".into())]));
    runs
}

fn permutations(n: usize) -> Vec<Vec<usize>> {
    fn visit(prefix: &mut Vec<usize>, left: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if left.is_empty() {
            out.push(prefix.clone());
            return;
        }
        for i in 0..left.len() {
            let value = left.remove(i);
            prefix.push(value);
            visit(prefix, left, out);
            prefix.pop();
            left.insert(i, value);
        }
    }
    let mut out = vec![];
    visit(&mut vec![], &mut (0..n).collect(), &mut out);
    out
}

fn record(name: &str, report: &str, updates: &[Vec<u8>]) {
    if let Some(dir) = std::env::var_os("EDITAC_DELETE_EDIT_OUTPUT") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.txt")), report).unwrap();
        for (i, update) in updates.iter().enumerate() {
            fs::write(dir.join(format!("{name}-{i}.bin")), update).unwrap();
        }
    }
}

/// Real transport boundary: all arrival permutations, including dependencies
/// arriving before initialization; duplicates, reconnect replay, fresh restore.
fn replay(name: &str, updates: &[Vec<u8>], expected: &Projection) {
    let orders = permutations(updates.len());
    assert_eq!(orders.len(), (1..=updates.len()).product::<usize>());
    let mut report = format!(
        "fixture=a😀b; bold UTF-16 [1,3); all {} permutations\nexpected={expected:#?}\n",
        orders.len()
    );
    for (schedule, order) in orders.iter().enumerate() {
        let observer = registry::replica(100 + schedule as u64);
        for i in order {
            registry::apply(&observer, &updates[*i]);
            registry::apply(&observer, &updates[*i]);
        }
        let before_projection = registry::full_update(&observer);
        assert_eq!(&policy::project(&observer), expected, "schedule {order:?}");
        assert_eq!(
            registry::full_update(&observer),
            before_projection,
            "read projection must not emit repair writes"
        );
        for i in order.iter().rev() {
            registry::apply(&observer, &updates[*i]);
        }
        assert_eq!(
            &policy::project(&observer),
            expected,
            "reverse replay {order:?}"
        );
        let restored = writer(1000 + schedule as u64, &registry::full_update(&observer));
        assert_eq!(
            &policy::project(&restored),
            expected,
            "fresh snapshot restore {order:?}"
        );
        report.push_str(&format!("{order:?}: duplicate delivery, reverse replay, restore: hidden; text/marks/identity retained\n"));
    }
    record(name, &report, updates);
}

#[test]
fn concurrent_delete_edit_retains_rich_content_independent_of_writer_order() {
    for (deleter_id, editor_id) in [(21, 22), (22, 21)] {
        let source = policy::fixture();
        let initial = registry::project(&source);
        let base = registry::full_update(&source);
        let sv = source.transact().state_vector();
        let deleter = writer(deleter_id, &base);
        let editor = writer(editor_id, &base);
        policy::delete(&deleter);
        assert_hidden(
            &policy::project(&deleter),
            &initial.text_identity,
            "a😀b",
            &original_runs(),
        );
        policy::edit_visible(&editor).unwrap();
        assert!(policy::project(&editor).visible.is_some());
        let deleted = delta(&deleter, &sv);
        let edited = delta(&editor, &sv);
        registry::apply(&deleter, &edited);
        registry::apply(&editor, &deleted);
        let expected = policy::project(&deleter);
        assert_eq!(policy::project(&editor), expected);
        assert_hidden(&expected, &initial.text_identity, "a😀!b", &edited_runs());
        replay(
            &format!("concurrent-{deleter_id}-{editor_id}"),
            &[base, deleted, edited],
            &expected,
        );
    }
}

#[test]
fn deletion_after_observed_edit_preserves_the_same_recovery_content() {
    let source = policy::fixture();
    let identity = registry::project(&source).text_identity;
    let base = registry::full_update(&source);
    let editor = writer(21, &base);
    let deleter = writer(22, &base);
    let sv = editor.transact().state_vector();
    policy::edit_visible(&editor).unwrap();
    let edited = delta(&editor, &sv);
    registry::apply(&deleter, &edited);
    let edited_sv = deleter.transact().state_vector();
    policy::delete(&deleter);
    let deleted = delta(&deleter, &edited_sv);
    registry::apply(&editor, &deleted);
    let expected = policy::project(&deleter);
    assert_eq!(policy::project(&editor), expected);
    assert_hidden(&expected, &identity, "a😀!b", &edited_runs());
    replay("edit-then-delete", &[base, edited, deleted], &expected);
}

#[test]
fn disconnected_edits_and_dependent_deltas_merge_into_hidden_recovery() {
    let source = policy::fixture();
    let identity = registry::project(&source).text_identity;
    let base = registry::full_update(&source);
    let sv = source.transact().state_vector();
    let deleter = writer(21, &base);
    let editor = writer(22, &base);
    let offline = writer(23, &base);
    policy::delete(&deleter);
    let deleted = delta(&deleter, &sv);
    policy::edit_visible(&editor).unwrap();
    let first = delta(&editor, &sv);
    let first_sv = editor.transact().state_vector();
    // Dependent delta from the same disconnected writer, including UTF-16
    // deletion of the complete surrogate pair and replacement/formatting.
    let t = registry::text(&editor);
    {
        let mut txn = editor.transact_mut_with("fixture:offline-replace");
        t.remove_range(&mut txn, 1, 2);
        t.insert_with_attributes(
            &mut txn,
            1,
            "👩‍💻",
            HashMap::from([("code".into(), Any::Bool(true))]),
        );
    }
    let second = delta(&editor, &first_sv);
    let t = registry::text(&offline);
    t.insert_with_attributes(
        &mut offline.transact_mut_with("fixture:offline-rtl"),
        4,
        "אב",
        HashMap::from([("underline".into(), Any::Bool(true))]),
    );
    let third = delta(&offline, &sv);
    let updates = [base, deleted, first, second, third];
    for doc in [&deleter, &editor, &offline] {
        for update in updates.iter().rev() {
            registry::apply(doc, update);
        }
    }
    let expected = policy::project(&deleter);
    assert_eq!(policy::project(&editor), expected);
    assert_eq!(policy::project(&offline), expected);
    let runs = vec![
        ("a".into(), vec![]),
        ("👩‍💻".into(), vec![("code".into(), "true".into())]),
        ("!".into(), vec![("italic".into(), "true".into())]),
        ("b".into(), vec![]),
        ("אב".into(), vec![("underline".into(), "true".into())]),
    ];
    assert_hidden(&expected, &identity, "a👩‍💻!bאב", &runs);
    replay("disconnected-dependent-edits", &updates, &expected);
}

#[test]
fn known_tombstone_rejects_local_edit_and_recovery_reads_never_resurrect() {
    let doc = policy::fixture();
    let identity = registry::project(&doc).text_identity;
    let visible = policy::project(&doc);
    assert!(visible.visible.is_some());
    assert!(visible.recovery.is_none());
    policy::delete(&doc);
    let deleted = registry::full_update(&doc);
    let sv = doc.transact().state_vector();
    let p = policy::project(&doc);
    assert_hidden(&p, &identity, "a😀b", &original_runs());
    assert_eq!(policy::edit_visible(&doc), Err("deleted target"));
    policy::delete(&doc); // duplicate command, not just duplicate transport
    for _ in 0..3 {
        assert_eq!(policy::project(&doc), p);
    }
    assert_eq!(doc.transact().state_vector(), sv);
    assert_eq!(registry::full_update(&doc), deleted);
    let restored = writer(24, &deleted);
    assert_eq!(policy::edit_visible(&restored), Err("deleted target"));
    assert_eq!(policy::project(&restored), p);
    record(
        "known-tombstone",
        &format!(
            "visible-before={visible:#?}\nhidden-after={p:#?}\nrejected edit + repeated delete + read projection: unchanged update and vector\n"
        ),
        &[deleted],
    );
}
