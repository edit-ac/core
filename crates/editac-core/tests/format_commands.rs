//! Prepared formatting against real frozen-schema replicas and update replay.
use editac_core::{
    Utf16Offset as U,
    anchors::*,
    commands::{format::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ROOTS},
};
use std::collections::BTreeMap;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, ClientID, Doc, IndexedSequence, Map, OffsetKind, Options, Out, ReadTxn,
    StateVector, Text, Transact, Update, XmlTextPrelim, XmlTextRef,
};
fn identity() -> DocumentIdentity {
    DocumentIdentity::v1(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap()
}
fn replica(client: u64) -> Doc {
    let d = Doc::with_options(Options {
        client_id: ClientID::new(client),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for root in ROOTS {
        d.get_or_insert_map(root);
    }
    d
}
fn seed(first: &str, second: &str) -> Doc {
    let d = replica(11);
    {
        let mut t = d.transact_mut_with("fixture:seed");
        for (id, value, order) in [("block-1", first, 0), ("block-2", second, 1)] {
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, "list");
            t.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id, XmlTextPrelim::new(value));
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
        }
        t.get_map(ROOTS[4]).unwrap().insert(
            &mut t,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    d
}
fn bytes(d: &Doc) -> Vec<u8> {
    d.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
fn engine(d: &Doc) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes(d),
        },
        &[],
    )
    .unwrap()
}
fn text(d: &Doc, id: &str) -> XmlTextRef {
    let t = d.transact();
    let Some(Out::YXmlText(x)) = t.get_map(ROOTS[1]).unwrap().get(&t, id) else {
        panic!("text")
    };
    x
}
fn mode(d: &Doc, mode: &str, cut: u32) {
    let mut value = vec![Any::from(mode)];
    if mode == "split" {
        value.push(Any::Buffer(
            text(d, "block-1")
                .sticky_index(&d.transact(), cut, Assoc::Before)
                .unwrap()
                .encode_v1()
                .into(),
        ));
    }
    let mut t = d.transact_mut();
    t.get_map(ROOTS[4])
        .unwrap()
        .insert(&mut t, "pair", Any::Array(value.into()));
}
fn origin() -> TextOrigin {
    TextOrigin::new("format").unwrap()
}
fn command(
    d: &Document,
    a: (&str, u32),
    b: (&str, u32),
    mark: Mark,
    action: FormatAction,
) -> FormatCommand {
    FormatCommand {
        selection: d
            .selection((a.0, U(a.1), Bias::Right), (b.0, U(b.1), Bias::Left))
            .unwrap(),
        mark,
        action,
        href: if mark == Mark::Link && action != FormatAction::Remove {
            Some("https://example.com".into())
        } else {
            None
        },
    }
}
fn run(d: &mut Document, commands: &[FormatCommand]) -> TextCommit {
    let plan = d.prepare_format(commands, &origin()).unwrap();
    d.commit_format(plan).unwrap()
}
fn chars(d: &Document, node: &str) -> Vec<(char, BTreeMap<String, Any>)> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == node)
        .unwrap()
        .runs
        .iter()
        .flat_map(|r| r.text.chars().map(|c| (c, r.attributes.clone())))
        .collect()
}
fn has(d: &Document, node: &str, key: &str) -> Vec<bool> {
    chars(d, node)
        .iter()
        .map(|(_, a)| a.get(key) == Some(&Any::Bool(true)))
        .collect()
}
fn unchanged(d: &Document, commands: &[FormatCommand], error: FormatError) {
    let bytes = d.checkpoint().bytes;
    let revision = d.revision();
    assert_eq!(d.can_format(commands, &origin()), Err(error.clone()));
    assert_eq!(d.prepare_format(commands, &origin()).unwrap_err(), error);
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), revision);
}
fn fixture_mark(d: &Doc, id: &str, start: u32, end: u32, key: &str, value: Any) {
    text(d, id).format(
        &mut d.transact_mut(),
        start,
        end - start,
        [(key.into(), value)].into(),
    );
}
#[test]
fn six_marks_apply_and_remove_without_changing_text_or_source_identity() {
    for mark in [
        Mark::Bold,
        Mark::Italic,
        Mark::Strike,
        Mark::Underline,
        Mark::Code,
        Mark::Link,
    ] {
        let mut d = engine(&seed("a😀b", "cאבd"));
        let before = d.snapshot().unwrap().visible[0].spans.clone();
        let c = command(
            &d,
            ("block-1", 1),
            ("block-1", 3),
            mark,
            FormatAction::Apply,
        );
        let commit = run(&mut d, &[c]);
        assert_eq!(commit.revision, 1);
        assert!(commit.update.is_some());
        let current = chars(&d, "block-1");
        assert_eq!(current.iter().map(|x| x.0).collect::<String>(), "a😀b");
        let key = match mark {
            Mark::Bold => "bold",
            Mark::Italic => "italic",
            Mark::Strike => "strike",
            Mark::Underline => "underline",
            Mark::Code => "code",
            Mark::Link => "link",
        };
        assert!(!current[0].1.contains_key(key));
        assert!(current[1].1.contains_key(key));
        assert!(!current[2].1.contains_key(key));
        assert_eq!(d.snapshot().unwrap().visible[0].spans, before);
        let c = command(
            &d,
            ("block-1", 1),
            ("block-1", 3),
            mark,
            FormatAction::Remove,
        );
        run(&mut d, &[c]);
        assert!(chars(&d, "block-1").iter().all(|x| !x.1.contains_key(key)));
    }
}
#[test]
fn mixed_selection_toggle_applies_globally_then_removes_globally() {
    let s = seed("abcd", "efgh");
    fixture_mark(&s, "block-1", 1, 3, "bold", Any::Bool(true));
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Toggle,
    );
    run(&mut d, &[c.clone()]);
    assert_eq!(has(&d, "block-1", "bold"), vec![true; 4]);
    run(&mut d, &[c]);
    assert_eq!(has(&d, "block-1", "bold"), vec![false; 4]);
}
#[test]
fn backward_cross_node_toggle_uses_one_global_state_and_utf16_ranges() {
    let s = seed("a😀b", "cאבd");
    fixture_mark(&s, "block-1", 1, 4, "italic", Any::Bool(true));
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-2", 3),
        ("block-1", 1),
        Mark::Italic,
        FormatAction::Toggle,
    );
    let r = run(&mut d, &[c.clone()]);
    assert_eq!(has(&d, "block-1", "italic"), vec![false, true, true]);
    assert_eq!(has(&d, "block-2", "italic"), vec![true, true, true, false]);
    assert!(r.touched_ranges.iter().all(|r| r.old_end == r.new_end));
    assert_eq!(r.revision, 1);
    run(&mut d, &[c]);
    assert_eq!(has(&d, "block-1", "italic"), vec![false; 3]);
    assert_eq!(has(&d, "block-2", "italic"), vec![false; 4]);
}
#[test]
fn cross_node_apply_and_remove_preserve_unselected_suffixes() {
    let s = seed("abcd", "efgh");
    fixture_mark(&s, "block-2", 0, 4, "underline", Any::Bool(true));
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-1", 2),
        ("block-2", 2),
        Mark::Underline,
        FormatAction::Apply,
    );
    run(&mut d, &[c]);
    assert_eq!(
        has(&d, "block-1", "underline"),
        vec![false, false, true, true]
    );
    let c = command(
        &d,
        ("block-1", 2),
        ("block-2", 2),
        Mark::Underline,
        FormatAction::Remove,
    );
    run(&mut d, &[c]);
    assert_eq!(
        has(&d, "block-2", "underline"),
        vec![false, false, true, true]
    );
}
#[test]
fn sequential_batch_toggles_observe_prior_planned_marks() {
    let mut d = engine(&seed("abcd", "ef"));
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Toggle,
    );
    let r = run(&mut d, &[c.clone(), c]);
    assert_eq!(r.revision, 1);
    assert_eq!(has(&d, "block-1", "bold"), vec![false; 4]);
}
#[test]
fn overlapping_batch_ranges_preserve_different_marks() {
    let mut d = engine(&seed("abcd", "ef"));
    let a = command(
        &d,
        ("block-1", 0),
        ("block-1", 3),
        Mark::Bold,
        FormatAction::Apply,
    );
    let b = command(
        &d,
        ("block-1", 2),
        ("block-1", 4),
        Mark::Italic,
        FormatAction::Apply,
    );
    run(&mut d, &[a, b]);
    assert_eq!(has(&d, "block-1", "bold"), vec![true, true, true, false]);
    assert_eq!(has(&d, "block-1", "italic"), vec![false, false, true, true]);
}
#[test]
fn code_clears_known_rich_marks_but_retains_unknown_attributes() {
    let s = seed("abcd", "ef");
    for k in ["bold", "italic", "strike", "underline", "link", "ext:v1"] {
        fixture_mark(
            &s,
            "block-1",
            0,
            4,
            k,
            if k == "link" {
                Any::from("https://example.com")
            } else {
                Any::Bool(true)
            },
        );
    }
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-1", 1),
        ("block-1", 3),
        Mark::Code,
        FormatAction::Apply,
    );
    run(&mut d, &[c]);
    for (_, attrs) in chars(&d, "block-1").into_iter().skip(1).take(2) {
        assert_eq!(attrs.len(), 2);
        assert_eq!(attrs["code"], Any::Bool(true));
        assert_eq!(attrs["ext:v1"], Any::Bool(true));
    }
}
#[test]
fn rich_mark_over_code_rejects_entire_batch_before_mutation() {
    let s = seed("abcd", "ef");
    fixture_mark(&s, "block-1", 1, 2, "code", Any::Bool(true));
    let d = engine(&s);
    let a = command(
        &d,
        ("block-2", 0),
        ("block-2", 2),
        Mark::Bold,
        FormatAction::Apply,
    );
    let b = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Italic,
        FormatAction::Apply,
    );
    unchanged(&d, &[a, b], FormatError::CodeConflict);
}
#[test]
fn remove_code_then_apply_rich_is_valid_in_one_batch() {
    let s = seed("abcd", "ef");
    fixture_mark(&s, "block-1", 0, 4, "code", Any::Bool(true));
    let mut d = engine(&s);
    let a = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Code,
        FormatAction::Remove,
    );
    let b = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    let r = run(&mut d, &[a, b]);
    assert_eq!(r.revision, 1);
    assert_eq!(has(&d, "block-1", "bold"), vec![true; 4]);
    assert_eq!(has(&d, "block-1", "code"), vec![false; 4]);
}
#[test]
fn invalid_link_as_last_command_cannot_partially_apply_first_command() {
    let d = engine(&seed("abcd", "ef"));
    let a = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    let mut b = command(
        &d,
        ("block-2", 0),
        ("block-2", 2),
        Mark::Link,
        FormatAction::Apply,
    );
    b.href = Some("javascript:alert(1)".into());
    unchanged(&d, &[a, b], FormatError::InvalidUrl);
}
#[test]
fn normalized_url_admission_and_mixed_link_toggle() {
    let mut d = engine(&seed("abcd", "ef"));
    let mut c = command(
        &d,
        ("block-1", 0),
        ("block-1", 2),
        Mark::Link,
        FormatAction::Apply,
    );
    c.href = Some("HTTPS://EXAMPLE.COM/é".into());
    run(&mut d, &[c]);
    assert_eq!(
        chars(&d, "block-1")[0].1["link"],
        Any::from("https://example.com/%C3%A9")
    );
    let mut c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Link,
        FormatAction::Toggle,
    );
    c.href = Some("https://example.com/%C3%A9".into());
    run(&mut d, &[c.clone()]);
    assert!(
        chars(&d, "block-1")
            .iter()
            .all(|x| x.1.contains_key("link"))
    );
    run(&mut d, &[c]);
    assert!(
        chars(&d, "block-1")
            .iter()
            .all(|x| !x.1.contains_key("link"))
    );
}
#[test]
fn unsafe_malformed_relative_and_obfuscated_urls_are_rejected() {
    let d = engine(&seed("abcd", "ef"));
    for href in [
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///tmp/x",
        "/relative",
        "//evil.test",
        "https://user:pass@example.com",
        "https://example.com/\n",
        "https://example.com/%0a",
        "https://example.com/%5c",
        "https://example.com/%zz",
        "https://example.com/%ff",
        "java%73cript:alert(1)",
        "javascript&#58;alert(1)",
        "https://example.com/&Tab;",
        "https:\\evil.test",
        "https://example.com/%C2%A0",
        "",
    ] {
        let mut c = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Link,
            FormatAction::Apply,
        );
        c.href = Some(href.into());
        unchanged(&d, &[c], FormatError::InvalidUrl);
    }
}
#[test]
fn mailto_links_and_ordinary_query_ampersands_are_allowed() {
    for href in ["mailto:a@example.com", "https://example.com/?a=1&b=2"] {
        let mut d = engine(&seed("abcd", "ef"));
        let mut c = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Link,
            FormatAction::Apply,
        );
        c.href = Some(href.into());
        run(&mut d, &[c]);
        assert_eq!(chars(&d, "block-1")[0].1["link"], Any::from(href));
    }
}
#[test]
fn invalid_attribute_shapes_and_url_length_reject_without_mutation() {
    let d = engine(&seed("abcd", "ef"));
    let mut c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    c.href = Some("https://example.com".into());
    unchanged(&d, &[c], FormatError::InvalidAttributes);
    let mut c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Link,
        FormatAction::Apply,
    );
    c.href = None;
    unchanged(&d, &[c], FormatError::InvalidAttributes);
    let mut c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Link,
        FormatAction::Apply,
    );
    c.href = Some(format!(
        "https://example.com/{}",
        "a".repeat(MAX_LINK_BYTES)
    ));
    unchanged(&d, &[c], FormatError::ResourceLimit);
}
#[test]
fn collapsed_empty_and_already_applied_commands_do_not_emit_updates() {
    let mut d = engine(&seed("", "abcd"));
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", 0),
        Mark::Bold,
        FormatAction::Apply,
    );
    assert!(run(&mut d, &[c]).update.is_none());
    let c = command(
        &d,
        ("block-2", 2),
        ("block-2", 2),
        Mark::Bold,
        FormatAction::Toggle,
    );
    assert!(run(&mut d, &[c]).update.is_none());
    let c = command(
        &d,
        ("block-2", 0),
        ("block-2", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    run(&mut d, &[c.clone()]);
    assert!(run(&mut d, &[c]).update.is_none());
    assert_eq!(d.revision(), 1);
}
#[test]
fn joined_owner_formats_both_original_shared_texts() {
    let s = seed("abcd", "efgh");
    mode(&s, "join", 0);
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-1", 2),
        ("block-1", 6),
        Mark::Strike,
        FormatAction::Apply,
    );
    let r = run(&mut d, &[c]);
    assert_eq!(
        has(&d, "block-1", "strike"),
        vec![false, false, true, true, true, true, false, false]
    );
    assert_eq!(r.touched_ranges.len(), 2);
    assert_eq!(r.touched_ranges[0].source, "block-1");
    assert_eq!(r.touched_ranges[1].source, "block-2");
}
#[test]
fn split_owner_and_original_share_source_without_formatting_other_owners() {
    let s = seed("abcd", "efgh");
    mode(&s, "split", 2);
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-split", 0),
        ("block-split", 2),
        Mark::Underline,
        FormatAction::Apply,
    );
    let r = run(&mut d, &[c]);
    assert_eq!(r.touched_ranges[0].start, 2);
    assert_eq!(r.touched_ranges[0].old_end, 4);
    assert_eq!(has(&d, "block-1", "underline"), vec![false; 2]);
    assert_eq!(has(&d, "block-split", "underline"), vec![true; 2]);
    assert_eq!(has(&d, "block-2", "underline"), vec![false; 4]);
}
#[test]
fn ordinary_nodes_and_intermediate_empty_nodes_are_supported() {
    let s = seed("abcd", "");
    {
        let mut t = s.transact_mut();
        t.get_map(ROOTS[4]).unwrap().remove(&mut t, "pair");
    }
    let mut d = engine(&s);
    let c = command(
        &d,
        ("block-1", 0),
        ("block-2", 0),
        Mark::Bold,
        FormatAction::Apply,
    );
    run(&mut d, &[c]);
    assert_eq!(has(&d, "block-1", "bold"), vec![true; 4]);
}
#[test]
fn unicode_graphemes_and_rtl_format_with_utf16_source_ranges() {
    for content in ["👩‍💻", "e\u{301}", "🇭🇺", "אבג"] {
        let mut d = engine(&seed(content, ""));
        let length = content.encode_utf16().count() as u32;
        let c = command(
            &d,
            ("block-1", 0),
            ("block-1", length),
            Mark::Bold,
            FormatAction::Apply,
        );
        let r = run(&mut d, &[c]);
        assert_eq!(r.touched_ranges[0].old_end, length);
        assert_eq!(
            has(&d, "block-1", "bold"),
            vec![true; content.chars().count()]
        );
    }
}
#[test]
fn deleted_target_and_unknown_kind_reject_entire_batch() {
    let s = seed("abcd", "ef");
    let d = engine(&s);
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    {
        let mut t = s.transact_mut();
        t.get_map(ROOTS[3]).unwrap().insert(&mut t, "block-1", true);
    }
    let d = engine(&s);
    unchanged(&d, &[c], FormatError::Text(TextError::DeletedTarget));
    let s = seed("abcd", "ef");
    {
        let mut t = s.transact_mut();
        t.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut t, "block-2", "extension:v1");
    }
    let d = engine(&s);
    let c = command(
        &d,
        ("block-1", 0),
        ("block-2", 2),
        Mark::Bold,
        FormatAction::Apply,
    );
    unchanged(&d, &[c], FormatError::Text(TextError::UnsupportedKind));
}
#[test]
fn wrong_replica_and_intervening_local_change_reject_plans() {
    let s = seed("abcd", "ef");
    let mut a = engine(&s);
    let mut b = engine(&s);
    let c = command(
        &a,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    let p = a.prepare_format(&[c.clone()], &origin()).unwrap();
    assert_eq!(
        b.commit_format(p).unwrap_err(),
        FormatError::Text(TextError::WrongReplica)
    );
    let p = a.prepare_format(&[c.clone()], &origin()).unwrap();
    run(&mut a, &[c]);
    assert_eq!(
        a.commit_format(p).unwrap_err(),
        FormatError::Text(TextError::StalePlan)
    );
}
#[test]
fn applicability_does_not_consume_pending_projection_changes() {
    let mut d = engine(&seed("abcd", "ef"));
    d.snapshot().unwrap();
    let c = command(
        &d,
        ("block-1", 1),
        ("block-1", 3),
        Mark::Bold,
        FormatAction::Apply,
    );
    run(&mut d, &[c.clone()]);
    d.can_format(&[c], &origin()).unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(s.changed_nodes.len(), 1);
    assert!(s.changed_nodes.contains("block-1"));
    assert!(!s.touched_ranges.is_empty());
    assert_eq!(s.source_reads, 1);
}
#[test]
fn command_and_fragment_limits_reject_before_mutation() {
    let d = engine(&seed("abcd", "ef"));
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", 4),
        Mark::Bold,
        FormatAction::Apply,
    );
    unchanged(
        &d,
        &vec![c; MAX_FORMAT_COMMANDS + 1],
        FormatError::ResourceLimit,
    );
    let s = seed(&"a".repeat(MAX_FORMAT_RUNS + 2), "");
    {
        let x = text(&s, "block-1");
        let mut t = s.transact_mut();
        for i in (0..MAX_FORMAT_RUNS + 2).step_by(2) {
            x.format(
                &mut t,
                i as u32,
                1,
                [("ext:v1".into(), Any::Bool(true))].into(),
            );
        }
    }
    let d = engine(&s);
    let c = command(
        &d,
        ("block-1", 0),
        ("block-1", (MAX_FORMAT_RUNS + 2) as u32),
        Mark::Bold,
        FormatAction::Apply,
    );
    unchanged(&d, &[c], FormatError::ResourceLimit);
}
#[test]
fn remote_insert_before_preparation_rebases_selection_and_preserves_text() {
    let s = seed("abcd", "ef");
    let d = engine(&s);
    let c = command(
        &d,
        ("block-1", 1),
        ("block-1", 3),
        Mark::Bold,
        FormatAction::Apply,
    );
    text(&s, "block-1").insert(&mut s.transact_mut(), 0, "😀");
    let mut d = engine(&s);
    run(&mut d, &[c]);
    assert_eq!(
        has(&d, "block-1", "bold"),
        vec![false, false, true, true, false]
    );
}
#[test]
fn three_real_replicas_converge_under_duplicate_reordered_format_delivery() {
    let s = seed("abcd", "efgh");
    let mut a = engine(&s);
    let mut b = engine(&s);
    let ca = command(
        &a,
        ("block-1", 0),
        ("block-2", 2),
        Mark::Bold,
        FormatAction::Apply,
    );
    let cb = command(
        &b,
        ("block-1", 2),
        ("block-2", 4),
        Mark::Italic,
        FormatAction::Apply,
    );
    let ua = run(&mut a, &[ca]).update.unwrap();
    let ub = run(&mut b, &[cb]).update.unwrap();
    let ra = replica(21);
    let rb = replica(22);
    let rc = replica(23);
    for r in [&ra, &rb, &rc] {
        apply(r, &bytes(&s));
    }
    for u in [&ua, &ub, &ub] {
        apply(&ra, &u.bytes);
    }
    for u in [&ub, &ua, &ua] {
        apply(&rb, &u.bytes);
    }
    for u in [&ub, &ua, &ub, &ua] {
        apply(&rc, &u.bytes);
    }
    let a = engine(&ra);
    let b = engine(&rb);
    let c = engine(&rc);
    assert_eq!(chars(&a, "block-1"), chars(&b, "block-1"));
    assert_eq!(chars(&a, "block-2"), chars(&c, "block-2"));
    assert_eq!(has(&a, "block-1", "bold"), vec![true; 4]);
    assert_eq!(has(&a, "block-2", "italic"), vec![true; 4]);
}
fn apply(d: &Doc, update: &[u8]) {
    d.transact_mut_with("fixture:remote")
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

#[test]
fn pinned_yjs_reads_all_six_marks_and_rust_restores_js_formatting() {
    use std::{fs, path::Path, process::Command};
    let s = seed("abcd", "efgh");
    fixture_mark(&s, "block-1", 0, 4, "ext:v1", Any::Bool(true));
    let mut d = engine(&s);
    let mut commands = Vec::new();
    for mark in [
        Mark::Bold,
        Mark::Italic,
        Mark::Strike,
        Mark::Underline,
        Mark::Link,
    ] {
        commands.push(command(
            &d,
            ("block-1", 1),
            ("block-1", 3),
            mark,
            FormatAction::Apply,
        ));
    }
    commands.push(command(
        &d,
        ("block-2", 0),
        ("block-2", 4),
        Mark::Code,
        FormatAction::Apply,
    ));
    run(&mut d, &commands);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_FORMAT_EXCHANGE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("target/format-command-interop"));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("rust.bin"), d.checkpoint().bytes).unwrap();
    let result = Command::new("node")
        .arg(root.join("fixtures/schema-v1/format-exchange.mjs"))
        .arg(&dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("bridge.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "Yjs exchange failed: {}",
        dir.join("bridge.log").display()
    );
    let peer = replica(22);
    apply(&peer, &fs::read(dir.join("js.bin")).unwrap());
    let restored = engine(&peer);
    assert_eq!(
        has(&restored, "block-1", "underline"),
        vec![true, true, true, false]
    );
    assert_eq!(has(&restored, "block-2", "code"), vec![false; 4]);
    assert_eq!(has(&restored, "block-2", "strike"), vec![true; 4]);
    assert!(
        chars(&restored, "block-1")
            .iter()
            .all(|x| x.1.get("ext:v1") == Some(&Any::Bool(true)))
    );
    assert_eq!(
        restored.snapshot().unwrap().visible[0].spans,
        d.snapshot().unwrap().visible[0].spans
    );
}

/// Canonical production harness for ENG-1.6's qualified v2 owner metadata.
mod blocks {
    use super::*;
    use editac_core::commands::structure::StructureCommand;
    use editac_core::document::{BLOCK_ATTRIBUTES as A, BlockAttributes as B};

    fn id() -> DocumentIdentity {
        DocumentIdentity::v2(identity().document_id, identity().epoch).unwrap()
    }
    fn source(a: &str, b: &str) -> Doc {
        let s = seed(a, b);
        s.get_or_insert_map(A);
        {
            let mut t = s.transact_mut_with("fixture:v2");
            for key in ["block-1", "block-2"] {
                t.get_map(ROOTS[0]).unwrap().insert(&mut t, key, "block");
            }
        }
        s
    }
    fn restore(s: &Doc) -> Document {
        Document::restore(
            &id(),
            &InitializedCheckpoint {
                identity: id(),
                initialized: true,
                writer_id: 11,
                bytes: bytes(s),
            },
            &[],
        )
        .unwrap()
    }
    fn block(targets: &[&str], attributes: B, action: FormatAction) -> BlockFormatCommand {
        BlockFormatCommand {
            targets: targets.iter().map(|x| x.to_string()).collect(),
            attributes,
            action,
        }
    }
    fn batch(
        d: &mut Document,
        marks: &[FormatCommand],
        blocks: &[BlockFormatCommand],
    ) -> TextCommit {
        let p = d.prepare_format_batch(marks, blocks, &origin()).unwrap();
        d.commit_format(p).unwrap()
    }
    fn attr(d: &Document, key: &str) -> B {
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == key)
            .unwrap()
            .block_attributes
            .clone()
            .unwrap()
    }
    fn set(s: &Doc, key: &str, value: B) {
        let mut t = s.transact_mut_with("fixture:metadata");
        t.get_map(A).unwrap().insert(&mut t, key, value.tuple());
    }
    fn reject(
        d: &Document,
        marks: &[FormatCommand],
        blocks: &[BlockFormatCommand],
        error: FormatError,
    ) {
        let state = d.checkpoint().bytes;
        let revision = d.revision();
        let snapshot = d.snapshot().unwrap();
        assert_eq!(
            d.can_format_batch(marks, blocks, &origin()).unwrap_err(),
            error
        );
        assert_eq!(
            d.prepare_format_batch(marks, blocks, &origin())
                .unwrap_err(),
            error
        );
        assert_eq!(d.checkpoint().bytes, state);
        assert_eq!(d.revision(), revision);
        assert_eq!(d.snapshot().unwrap().visible, snapshot.visible);
    }
    fn split(d: &mut Document, at: u32) {
        let at = d.anchor("block-1", U(at), Bias::Left).unwrap();
        let plan = d
            .prepare_structure(&StructureCommand::Split { at }, &origin())
            .unwrap();
        d.commit_structure(plan).unwrap();
    }
    fn join(d: &mut Document) {
        let first = d.anchor("block-1", U(0), Bias::Left).unwrap();
        let second = d.anchor("block-2", U(0), Bias::Left).unwrap();
        let plan = d
            .prepare_structure(&StructureCommand::Join { first, second }, &origin())
            .unwrap();
        d.commit_structure(plan).unwrap();
    }
    #[test]
    fn empty_blocks_keep_every_heading_level_and_paragraph_through_restore() {
        let mut d = restore(&source("", ""));
        for level in 1..=6 {
            let c = batch(
                &mut d,
                &[],
                &[block(
                    &["block-1", "block-2"],
                    B::Heading(level),
                    FormatAction::Apply,
                )],
            );
            assert!(c.update.is_some());
            assert!(c.touched_ranges.is_empty());
            let restored = Document::restore(&id(), &d.checkpoint(), &[]).unwrap();
            assert_eq!(attr(&restored, "block-1"), B::Heading(level));
            assert_eq!(attr(&restored, "block-2"), B::Heading(level));
        }
        batch(
            &mut d,
            &[],
            &[
                block(&["block-1"], B::Paragraph, FormatAction::Apply),
                block(&["block-2"], B::Heading(6), FormatAction::Remove),
            ],
        );
        assert_eq!(attr(&d, "block-1"), B::Paragraph);
        assert_eq!(attr(&d, "block-2"), B::Paragraph);
    }
    #[test]
    fn mixed_block_toggle_is_global_deduplicated_and_sequential() {
        let s = source("abc", "def");
        set(&s, "block-1", B::Heading(2));
        let mut d = restore(&s);
        let toggle = block(
            &["block-2", "block-1", "block-1"],
            B::Heading(2),
            FormatAction::Toggle,
        );
        batch(&mut d, &[], &[toggle.clone()]);
        assert_eq!(attr(&d, "block-2"), B::Heading(2));
        batch(&mut d, &[], &[toggle.clone()]);
        assert_eq!(attr(&d, "block-1"), B::Paragraph);
        assert_eq!(attr(&d, "block-2"), B::Paragraph);
        batch(&mut d, &[], &[toggle.clone(), toggle]);
        assert_eq!(attr(&d, "block-1"), B::Paragraph);
        assert_eq!(attr(&d, "block-2"), B::Paragraph);
    }
    #[test]
    fn mixed_marks_blocks_and_unicode_preserve_sources_unknown_marks_and_anchors() {
        let s = source("a😀b", "e\u{301}👩‍💻אב");
        fixture_mark(&s, "block-1", 0, 4, "ext:v1", Any::Bool(true));
        let mut d = restore(&s);
        let before = d.snapshot().unwrap();
        let anchor = d.anchor("block-1", U(3), Bias::Left).unwrap();
        let mark = command(
            &d,
            ("block-1", 1),
            ("block-2", 2),
            Mark::Bold,
            FormatAction::Toggle,
        );
        let commit = batch(
            &mut d,
            &[mark],
            &[block(
                &["block-1", "block-2"],
                B::Heading(6),
                FormatAction::Apply,
            )],
        );
        assert_eq!(commit.revision, 1);
        assert_eq!(has(&d, "block-1", "bold"), vec![false, true, true]);
        assert_eq!(attr(&d, "block-2"), B::Heading(6));
        assert_eq!(
            d.resolve_anchor(&anchor).unwrap(),
            Resolution::Position(Position {
                node: "block-1".into(),
                offset: U(3),
                source: "block-1".into(),
                source_offset: U(3),
                bias: Bias::Left
            })
        );
        let after = d.snapshot().unwrap();
        for (a, b) in before.visible.iter().zip(&after.visible) {
            assert_eq!(a.spans, b.spans);
        }
        assert!(
            chars(&d, "block-1")
                .iter()
                .all(|c| c.1.get("ext:v1") == Some(&Any::Bool(true)))
        );
    }
    #[test]
    fn metadata_only_projection_is_observable_without_text_reads_and_can_is_nonconsuming() {
        let mut d = restore(&source("", "abc"));
        d.snapshot().unwrap();
        let c = batch(
            &mut d,
            &[],
            &[block(&["block-1"], B::Heading(3), FormatAction::Apply)],
        );
        assert_eq!(c.revision, 1);
        assert!(c.touched_ranges.is_empty());
        d.can_format_batch(
            &[],
            &[block(&["block-2"], B::Heading(1), FormatAction::Apply)],
            &origin(),
        )
        .unwrap();
        let snapshot = d.snapshot().unwrap();
        assert_eq!(
            snapshot.changed_nodes,
            std::collections::BTreeSet::from(["block-1".into()])
        );
        assert_eq!(snapshot.source_reads, 0);
        assert!(snapshot.touched_ranges.is_empty());
        assert!(d.snapshot().unwrap().changed_nodes.is_empty());
    }
    #[test]
    fn absent_default_and_already_applied_ordinary_metadata_do_not_emit_updates() {
        let mut d = restore(&source("", ""));
        let before = d.checkpoint().bytes;
        assert!(
            batch(
                &mut d,
                &[],
                &[block(&["block-1"], B::Paragraph, FormatAction::Apply)]
            )
            .update
            .is_none()
        );
        assert_eq!(d.checkpoint().bytes, before);
        batch(
            &mut d,
            &[],
            &[block(&["block-1"], B::Heading(4), FormatAction::Apply)],
        );
        assert!(
            batch(
                &mut d,
                &[],
                &[block(&["block-1"], B::Heading(4), FormatAction::Apply)]
            )
            .update
            .is_none()
        );
    }
    #[test]
    fn beginning_middle_end_and_empty_production_splits_inherit_then_override() {
        for (value, cut) in [("abcd", 0), ("abcd", 2), ("abcd", 4), ("", 0)] {
            let mut d = restore(&source(value, "z"));
            batch(
                &mut d,
                &[],
                &[block(&["block-1"], B::Heading(5), FormatAction::Apply)],
            );
            split(&mut d, cut);
            assert_eq!(attr(&d, "block-split"), B::Heading(5));
            batch(
                &mut d,
                &[],
                &[block(&["block-1"], B::Heading(6), FormatAction::Apply)],
            );
            assert_eq!(attr(&d, "block-split"), B::Heading(6));
            // Matching inherited values still produce a persistent override.
            assert!(
                batch(
                    &mut d,
                    &[],
                    &[block(&["block-split"], B::Heading(6), FormatAction::Apply)]
                )
                .update
                .is_some()
            );
            batch(
                &mut d,
                &[],
                &[block(&["block-1"], B::Paragraph, FormatAction::Apply)],
            );
            assert_eq!(attr(&d, "block-split"), B::Heading(6));
            let restored = Document::restore(&id(), &d.checkpoint(), &[]).unwrap();
            assert_eq!(attr(&restored, "block-split"), B::Heading(6));
        }
    }
    #[test]
    fn inherited_toggle_observes_prior_planned_first_owner_change() {
        let mut d = restore(&source("abcd", ""));
        split(&mut d, 2);
        batch(
            &mut d,
            &[],
            &[
                block(&["block-1"], B::Heading(3), FormatAction::Apply),
                block(&["block-split"], B::Heading(3), FormatAction::Toggle),
            ],
        );
        assert_eq!(attr(&d, "block-1"), B::Heading(3));
        assert_eq!(attr(&d, "block-split"), B::Paragraph);
    }
    #[test]
    fn joined_marks_span_both_sources_and_absorbed_metadata_stays_recoverable() {
        let s = source("ab", "cd");
        set(&s, "block-2", B::Heading(4));
        let mut d = restore(&s);
        join(&mut d);
        let mark = command(
            &d,
            ("block-1", 1),
            ("block-1", 3),
            Mark::Italic,
            FormatAction::Apply,
        );
        batch(
            &mut d,
            &[mark],
            &[block(&["block-1"], B::Heading(2), FormatAction::Apply)],
        );
        assert_eq!(has(&d, "block-1", "italic"), vec![false, true, true, false]);
        reject(
            &d,
            &[],
            &[block(
                &["block-1", "block-2"],
                B::Paragraph,
                FormatAction::Apply,
            )],
            FormatError::UnavailableBlockTarget,
        );
        let cp = d.checkpoint();
        let r = replica(101);
        r.get_or_insert_map(A);
        apply(&r, &cp.bytes);
        let t = r.transact();
        assert_eq!(
            t.get_map(A).unwrap().get(&t, "block-2"),
            Some(Out::Any(B::Heading(4).tuple()))
        );
        // Join projects both original sources under the first owner; the
        // absorbed owner remains in the checkpoint, not the tombstone list.
        let retained: String = text(&r, "block-2")
            .diff(&t, |_| ())
            .into_iter()
            .map(|run| {
                let Out::Any(Any::String(value)) = run.insert else {
                    panic!("retained text")
                };
                value.to_string()
            })
            .collect();
        assert_eq!(retained, "cd");
        assert_eq!(d.snapshot().unwrap().visible[0].spans.len(), 2);
    }
    #[test]
    fn invalid_last_block_rejects_all_marks_and_blocks_without_mutation() {
        let d = restore(&source("abcd", ""));
        let mark = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Bold,
            FormatAction::Apply,
        );
        for invalid in [
            B::Heading(0),
            B::Heading(7),
            B::Unknown(Any::Array(vec![Any::from("ext:v2")].into())),
        ] {
            reject(
                &d,
                &[mark.clone()],
                &[
                    block(&["block-1"], B::Heading(2), FormatAction::Apply),
                    block(&["block-2"], invalid, FormatAction::Apply),
                ],
                FormatError::InvalidAttributes,
            );
        }
        reject(
            &d,
            &[mark],
            &[block(
                &["block-1", "missing"],
                B::Heading(2),
                FormatAction::Apply,
            )],
            FormatError::UnavailableBlockTarget,
        );
    }
    #[test]
    fn invalid_marks_code_and_urls_reject_valid_blocks_atomically() {
        let s = source("abcd", "");
        fixture_mark(&s, "block-1", 0, 4, "code", Any::Bool(true));
        let d = restore(&s);
        let mark = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Bold,
            FormatAction::Apply,
        );
        reject(
            &d,
            &[mark],
            &[block(&["block-2"], B::Heading(1), FormatAction::Apply)],
            FormatError::CodeConflict,
        );
        let mut link = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Link,
            FormatAction::Apply,
        );
        link.href = Some("javascript:alert(1)".into());
        reject(
            &d,
            &[link],
            &[block(&["block-2"], B::Heading(1), FormatAction::Apply)],
            FormatError::InvalidUrl,
        );
    }
    #[test]
    fn legacy_profile_and_opaque_structural_deleted_and_dormant_targets_reject() {
        let legacy = engine(&seed("ab", "cd"));
        reject(
            &legacy,
            &[],
            &[block(&["block-1"], B::Heading(1), FormatAction::Apply)],
            FormatError::UnsupportedBlockProfile,
        );
        let s = source("ab", "cd");
        set(
            &s,
            "block-1",
            B::Unknown(Any::Array(
                vec![Any::from("ext:future"), Any::Bool(true)].into(),
            )),
        );
        reject(
            &restore(&s),
            &[],
            &[block(&["block-1"], B::Paragraph, FormatAction::Remove)],
            FormatError::UnsupportedBlockTarget,
        );
        let s = source("ab", "cd");
        {
            let mut t = s.transact_mut();
            t.get_map(ROOTS[0])
                .unwrap()
                .insert(&mut t, "block-2", "item");
            t.get_map(ROOTS[4]).unwrap().remove(&mut t, "pair");
        }
        reject(
            &restore(&s),
            &[],
            &[block(&["block-2"], B::Heading(1), FormatAction::Apply)],
            FormatError::UnsupportedBlockTarget,
        );
        let s = source("ab", "cd");
        set(&s, "block-2", B::Heading(6));
        {
            let mut t = s.transact_mut();
            t.get_map(ROOTS[3]).unwrap().insert(&mut t, "block-2", true);
        }
        reject(
            &restore(&s),
            &[],
            &[block(&["block-2"], B::Paragraph, FormatAction::Apply)],
            FormatError::UnavailableBlockTarget,
        );
        reject(
            &restore(&source("ab", "cd")),
            &[],
            &[block(&["block-split"], B::Heading(1), FormatAction::Apply)],
            FormatError::UnavailableBlockTarget,
        );
    }
    #[test]
    fn intervening_block_only_local_or_remote_change_rejects_mixed_and_text_plans() {
        let s = source("abcd", "");
        let mut d = restore(&s);
        let mark = command(
            &d,
            ("block-1", 0),
            ("block-1", 4),
            Mark::Bold,
            FormatAction::Apply,
        );
        let plan = d
            .prepare_format_batch(
                &[mark],
                &[block(&["block-2"], B::Heading(1), FormatAction::Apply)],
                &origin(),
            )
            .unwrap();
        let text_plan = d
            .prepare_text(
                &TextCommand::Insert {
                    at: d.anchor("block-1", U(0), Bias::Left).unwrap(),
                    text: "X".into(),
                },
                &origin(),
            )
            .unwrap();
        batch(
            &mut d,
            &[],
            &[block(&["block-2"], B::Heading(2), FormatAction::Apply)],
        );
        let before = d.checkpoint().bytes;
        assert_eq!(
            d.commit_format(plan).unwrap_err(),
            FormatError::Text(TextError::StalePlan)
        );
        assert_eq!(d.commit_text(text_plan).unwrap_err(), TextError::StalePlan);
        assert_eq!(d.checkpoint().bytes, before);
        let plan = d
            .prepare_format_batch(
                &[],
                &[block(&["block-1"], B::Heading(1), FormatAction::Apply)],
                &origin(),
            )
            .unwrap();
        let peer = replica(99);
        peer.get_or_insert_map(A);
        apply(&peer, &d.checkpoint().bytes);
        set(&peer, "block-2", B::Heading(6));
        d.apply_replay(&editac_core::document::ReplayUpdate {
            identity: id(),
            bytes: bytes(&peer),
        })
        .unwrap();
        let before = d.checkpoint().bytes;
        assert_eq!(
            d.commit_format(plan).unwrap_err(),
            FormatError::Text(TextError::StalePlan)
        );
        assert_eq!(d.checkpoint().bytes, before);
    }
    #[test]
    fn mixed_batch_resource_bounds_and_wrong_replica_are_nonmutating() {
        let s = source("ab", "");
        let d = restore(&s);
        reject(
            &d,
            &[],
            &vec![block(&["block-1"], B::Heading(1), FormatAction::Apply); MAX_FORMAT_COMMANDS + 1],
            FormatError::ResourceLimit,
        );
        let mut c = block(&[], B::Heading(1), FormatAction::Apply);
        c.targets = vec!["block-1".into(); MAX_FORMAT_RUNS + 1];
        reject(&d, &[], &[c], FormatError::ResourceLimit);
        let p = d
            .prepare_format_batch(
                &[],
                &[block(&["block-1"], B::Heading(1), FormatAction::Apply)],
                &origin(),
            )
            .unwrap();
        let mut other = restore(&s);
        let before = other.checkpoint().bytes;
        assert_eq!(
            other.commit_format(p).unwrap_err(),
            FormatError::Text(TextError::WrongReplica)
        );
        assert_eq!(other.checkpoint().bytes, before);
    }
    #[test]
    fn prepared_mixed_conflicts_converge_with_actual_reordered_duplicate_updates() {
        let s = source("abcd", "efgh");
        set(&s, "block-1", B::Heading(3));
        let base = restore(&s).checkpoint();
        let mut a = Document::restore(&id(), &base, &[]).unwrap();
        let mut b = Document::restore(&id(), &base, &[]).unwrap();
        let ca = command(
            &a,
            ("block-1", 0),
            ("block-1", 2),
            Mark::Bold,
            FormatAction::Apply,
        );
        let cb = command(
            &b,
            ("block-2", 0),
            ("block-2", 2),
            Mark::Italic,
            FormatAction::Apply,
        );
        let ua = batch(
            &mut a,
            &[ca],
            &[
                block(&["block-1"], B::Heading(1), FormatAction::Apply),
                block(&["block-2"], B::Heading(6), FormatAction::Apply),
            ],
        )
        .update
        .unwrap();
        let ub = batch(
            &mut b,
            &[cb],
            &[block(&["block-1"], B::Paragraph, FormatAction::Apply)],
        )
        .update;
        // The competing tuple must be an explicit write, not an absent default no-op.
        let ub = if let Some(u) = ub {
            u
        } else {
            panic!("mark update required")
        };
        a.apply_replay(&ub).unwrap();
        b.apply_replay(&ua).unwrap();
        assert_eq!(a.snapshot().unwrap().visible, b.snapshot().unwrap().visible);
        for schedule in [[0, 1, 0, 1], [1, 0, 1, 0], [0, 0, 1, 1], [1, 1, 0, 0]] {
            let mut r = Document::restore(&id(), &base, &[]).unwrap();
            for i in schedule {
                r.apply_replay([&ua, &ub][i]).unwrap();
            }
            assert_eq!(r.snapshot().unwrap().visible, a.snapshot().unwrap().visible);
            assert_eq!(has(&r, "block-1", "bold"), vec![true, true, false, false]);
            assert_eq!(has(&r, "block-2", "italic"), vec![true, true, false, false]);
            assert_eq!(attr(&r, "block-2"), B::Heading(6));
            assert!(matches!(attr(&r, "block-1"), B::Heading(1) | B::Paragraph));
        }
    }
    #[test]
    fn pinned_yjs_exchanges_real_prepared_mixed_mark_block_commands_both_directions() {
        use std::{fs, path::Path, process::Command};
        let s = source("abcd", "efgh");
        fixture_mark(&s, "block-1", 0, 4, "ext:v1", Any::Bool(true));
        let mut d = restore(&s);
        let base = d.checkpoint();
        let marks = [
            command(
                &d,
                ("block-1", 1),
                ("block-1", 3),
                Mark::Bold,
                FormatAction::Apply,
            ),
            command(
                &d,
                ("block-2", 0),
                ("block-2", 4),
                Mark::Code,
                FormatAction::Apply,
            ),
        ];
        let update = batch(
            &mut d,
            &marks,
            &[
                block(&["block-1"], B::Heading(2), FormatAction::Apply),
                block(&["block-2"], B::Heading(6), FormatAction::Apply),
            ],
        )
        .update
        .unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let dir = std::env::var_os("EDITAC_FORMAT_BLOCK_EXCHANGE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("target/format-block-interop"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("base.bin"), &base.bytes).unwrap();
        fs::write(dir.join("rust-update.bin"), &update.bytes).unwrap();
        let result = Command::new("node")
            .arg("--test")
            .arg(root.join("fixtures/schema-v2/format-exchange.mjs"))
            .env("EDITAC_FORMAT_BLOCK_EXCHANGE", &dir)
            .output()
            .unwrap();
        fs::write(
            dir.join("node.log"),
            [result.stdout, result.stderr].concat(),
        )
        .unwrap();
        assert!(
            result.status.success(),
            "Yjs mixed exchange failed: {}",
            dir.join("node.log").display()
        );
        let before = d.snapshot().unwrap();
        let js = editac_core::document::ReplayUpdate {
            identity: id(),
            bytes: fs::read(dir.join("js-update.bin")).unwrap(),
        };
        d.apply_replay(&js).unwrap();
        d.apply_replay(&js).unwrap();
        assert_eq!(attr(&d, "block-1"), B::Paragraph);
        assert_eq!(attr(&d, "block-2"), B::Heading(1));
        assert_eq!(
            has(&d, "block-1", "underline"),
            vec![true, false, false, false]
        );
        assert_eq!(has(&d, "block-2", "code"), vec![false; 4]);
        assert_eq!(has(&d, "block-2", "strike"), vec![true; 4]);
        assert!(
            chars(&d, "block-1")
                .iter()
                .all(|c| c.1.get("ext:v1") == Some(&Any::Bool(true)))
        );
        let peer = replica(83);
        peer.get_or_insert_map(A);
        apply(&peer, &fs::read(dir.join("js.bin")).unwrap());
        let restored = restore(&peer);
        assert_eq!(
            restored.snapshot().unwrap().visible,
            d.snapshot().unwrap().visible
        );
        for (a, b) in before
            .visible
            .iter()
            .zip(d.snapshot().unwrap().visible.iter())
        {
            assert_eq!(a.spans, b.spans);
        }
    }
}
