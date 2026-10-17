include!("support/jobs_harness.rs");
use editac_core::{
    commands::format::Mark,
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_formats::rtf::export::{self as writer};
fn setup() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p.codecs.images = true;
    o.service_mut().set_policy(p);
    (o, s)
}
fn insert(o: &mut Owner, bs: &[FragmentBlock]) {
    job(o, "insert", Direction::Import)
        .finish_import(o, bs, 0)
        .unwrap();
}
fn begin(o: &Owner, id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Export);
    s.original = b"";
    s.profile = writer::PROFILE;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
fn run(text: &str, marks: Vec<(Mark, Option<String>)>) -> FragmentRun {
    FragmentRun {
        text: text.into(),
        marks,
    }
}
fn para(rs: Vec<FragmentRun>) -> FragmentBlock {
    FragmentBlock {
        runs: rs,
        attributes: Some(BlockAttributes::Paragraph),
        containers: vec![],
        checked: None,
    }
}
fn fixture() -> Vec<FragmentBlock> {
    vec![
        para(vec![run(
            "Unicode é € 🙂 e\u{301} العربية {literal} \\object \\u65? \\bin9",
            vec![],
        )]),
        para(vec![
            run("bold", vec![(Mark::Bold, None)]),
            run("italic", vec![(Mark::Italic, None)]),
            run("under", vec![(Mark::Underline, None)]),
            run("strike", vec![(Mark::Strike, None)]),
            run("both", vec![(Mark::Bold, None), (Mark::Italic, None)]),
            run("plain\ttab\nline", vec![]),
        ]),
        para(vec![]),
        FragmentBlock {
            runs: vec![run("A\tB\n🙂\t=1+1\n\t{cell} \\row", vec![])],
            attributes: Some(BlockAttributes::Unknown(
                Content::Table {
                    rows: vec![
                        vec![
                            vec![run("A", vec![(Mark::Bold, None)])],
                            vec![run("B", vec![])],
                        ],
                        vec![vec![run("🙂", vec![])], vec![run("=1+1", vec![])]],
                        vec![
                            vec![],
                            vec![run("{cell} \\row", vec![(Mark::Underline, None)])],
                        ],
                    ],
                    alignments: vec![Alignment::None, Alignment::None],
                    source: "A\tB\n🙂\t=1+1\n\t{cell} \\row".into(),
                }
                .tuple()
                .unwrap(),
            )),
            containers: vec![],
            checked: None,
        },
        para(vec![run("Tail", vec![])]),
    ]
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
#[test]
fn captured_semantics_artifact_and_immutable_history() {
    let (mut o, store) = setup();
    insert(&mut o, &fixture());
    let before = current(&o);
    let mut j = begin(&o, "supported");
    let rev = j.contract().revision.clone();
    edit(&mut o, "later");
    let changed = checkpoint(&o);
    let c = writer::export(&mut j, None, false, || 0).unwrap();
    assert_eq!(c.artifact.revision(), &rev);
    assert_eq!(checkpoint(&o), changed);
    assert!(!String::from_utf8_lossy(c.artifact.bytes()).contains("later"));
    assert!(c.report.diagnostics.iter().all(|d| !d.lossy));
    let path =
        std::env::var("EDITAC_FORMATS_OUTPUT").unwrap_or_else(|_| "/tmp/rtf-export-unit".into());
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(format!("{path}/supported.rtf"), c.artifact.bytes()).unwrap();
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), before);
    let reopened = ConversionOwner::open(
        store,
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        {
            let mut p = HostPolicy::default();
            p.extensions = true;
            p.codecs.tables = true;
            p.codecs.images = true;
            p
        },
    )
    .unwrap();
    assert!(current(&reopened).contains("Unicode"));
    println!(
        "RTF_EXPORT bytes={} nodes={} units={}",
        c.artifact.bytes().len(),
        c.report.nodes,
        c.report.utf16_units
    );
}
#[test]
fn all_sixteen_direct_mark_combinations() {
    let (mut o, _) = setup();
    let rs = (0..16)
        .map(|n| {
            run(
                &format!("m{n:02}"),
                [Mark::Bold, Mark::Italic, Mark::Underline, Mark::Strike]
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| n & (1 << i) != 0)
                    .map(|(_, m)| (m, None))
                    .collect(),
            )
        })
        .collect();
    insert(&mut o, &[para(rs)]);
    let c = writer::export(&mut begin(&o, "masks"), None, false, || 0).unwrap();
    let path =
        std::env::var("EDITAC_FORMATS_OUTPUT").unwrap_or_else(|_| "/tmp/rtf-export-unit".into());
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(format!("{path}/marks.rtf"), c.artifact.bytes()).unwrap();
}
#[test]
fn unsupported_marks_styles_and_original_require_explicit_loss() {
    let (mut o, _) = setup();
    let mut b = para(vec![
        run("code", vec![(Mark::Code, None)]),
        run(
            "link",
            vec![(Mark::Link, Some("https://example.test/a".into()))],
        ),
    ]);
    b.attributes = Some(BlockAttributes::Heading(2));
    insert(&mut o, &[b]);
    let before = checkpoint(&o);
    let e = writer::export(&mut begin(&o, "loss"), None, false, || 0)
        .err()
        .unwrap();
    assert_eq!(e.reason, "loss-approval-required");
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_BLOCK_STYLE")
    );
    assert!(e.report.diagnostics.iter().filter(|d| d.lossy).count() >= 3);
    let c = writer::export(&mut begin(&o, "approved"), None, true, || 0).unwrap();
    assert!(c.report.diagnostics.iter().any(|d| d.lossy));
    assert_eq!(checkpoint(&o), before);
    let mut s = spec(&o, "original", Direction::Export);
    s.profile = writer::PROFILE;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let e = writer::export(&mut j, None, false, || 0).err().unwrap();
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "SOURCE_PROVENANCE_UNAVAILABLE")
    );
}
#[test]
fn unsupported_atom_has_explicit_fallback_and_no_activation() {
    let (mut o, _) = setup();
    let c = Content::Image {
        url: "https://example.invalid/a.png".into(),
        alt: "x^2".into(),
        title: "".into(),
        source: "x^2".into(),
    };
    let b = FragmentBlock {
        runs: vec![run("x^2", vec![])],
        attributes: Some(BlockAttributes::Unknown(c.tuple().unwrap())),
        containers: vec![],
        checked: None,
    };
    insert(&mut o, &[b]);
    assert!(
        writer::export(&mut begin(&o, "atom"), None, false, || 0)
            .err()
            .unwrap()
            .report
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_CONTENT")
    );
    let c = writer::export(&mut begin(&o, "fallback"), None, true, || 0).unwrap();
    assert!(!String::from_utf8_lossy(c.artifact.bytes()).contains("\\object"));
}
#[test]
fn cancellation_deadline_and_output_budget_leave_state_unchanged() {
    let (mut o, _) = setup();
    insert(&mut o, &fixture());
    let before = checkpoint(&o);
    let mut j = begin(&o, "cancel");
    j.cancellation().cancel();
    assert!(
        writer::export(&mut j, None, false, || 0)
            .err()
            .unwrap()
            .reason
            .contains("Cancelled")
    );
    let mut j = begin(&o, "timeout");
    assert!(
        writer::export(&mut j, None, false, || 101)
            .err()
            .unwrap()
            .reason
            .contains("Timeout")
    );
    let mut s = spec(&o, "budget", Direction::Export);
    s.original = b"";
    s.profile = writer::PROFILE;
    s.limits.output_bytes = 32;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        writer::export(&mut j, None, false, || 0)
            .err()
            .unwrap()
            .reason,
        "output-budget"
    );
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn cancellation_during_unicode_escape_checks_work() {
    let (mut o, _) = setup();
    insert(&mut o, &[para(vec![run(&"🙂".repeat(2000), vec![])])]);
    let mut j = begin(&o, "during");
    let cancel = j.cancellation();
    let mut calls = 0;
    let e = writer::export(&mut j, None, false, || {
        calls += 1;
        if calls == 20 {
            cancel.cancel()
        }
        0
    })
    .err()
    .unwrap();
    assert!(e.reason.contains("Cancelled"));
    assert!(calls < 25);
}
#[test]
fn invalid_profile_cannot_complete_export() {
    let (o, _) = setup();
    let mut j = job(&o, "wrong", Direction::Export);
    assert_eq!(
        writer::export(&mut j, None, false, || 0)
            .err()
            .unwrap()
            .reason,
        "export-profile-required"
    );
}
#[test]
fn node_budget_and_invalid_text_do_not_partially_export() {
    let (mut o, _) = setup();
    insert(&mut o, &fixture());
    let before = checkpoint(&o);
    let mut s = spec(&o, "nodes", Direction::Export);
    s.original = b"";
    s.profile = writer::PROFILE;
    s.limits.nodes = 10;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        writer::export(&mut j, None, false, || 0)
            .err()
            .unwrap()
            .reason,
        "node-budget"
    );
    assert_eq!(checkpoint(&o), before);
    let (mut o, _) = setup();
    insert(&mut o, &[para(vec![run("bad\rtext", vec![])])]);
    let e = writer::export(&mut begin(&o, "controls"), None, false, || 0)
        .err()
        .unwrap();
    assert_eq!(e.reason, "unsupported-control-character");
}
#[cfg(feature = "rtf-import")]
#[test]
fn original_provenance_diagnostics_are_complete_and_hash_correlated() {
    use editac_formats::rtf::import::{Budgets, prepare};
    let (mut o, _) = setup();
    let original = b"{\\rtf1 retained{\\*\\unknown hidden}\\par}";
    let mut s = spec(&o, "source", Direction::Import);
    s.profile = editac_formats::rtf::import::PROFILE;
    s.original = original;
    s.filename = "a.rtf";
    s.media_type = "application/rtf";
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let p = prepare(&mut j, Budgets::default(), || 0).unwrap();
    let provenance = writer::Provenance::from_import(&p);
    let expected = p.report().diagnostics.len();
    p.commit(&mut j, &mut o, true, 0).unwrap().unwrap();
    let mut s = spec(&o, "export-source", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = original;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let e = writer::export(&mut j, Some(&provenance), false, || 0)
        .err()
        .unwrap();
    assert_eq!(e.reason, "loss-approval-required");
    assert_eq!(
        e.report.diagnostics.iter().filter(|d| d.lossy).count(),
        expected
    );
    let mut s = spec(&o, "export-source-approved", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = original;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let c = writer::export(&mut j, Some(&provenance), true, || 0).unwrap();
    assert_eq!(
        c.report.diagnostics.iter().filter(|d| d.lossy).count(),
        expected
    );
    assert_eq!(j.source().original(), original);
    assert!(!String::from_utf8_lossy(c.artifact.bytes()).contains("hidden"));
    assert_eq!(
        writer::export(&mut begin(&o, "foreign"), Some(&provenance), true, || 0)
            .err()
            .unwrap()
            .reason,
        "foreign-provenance"
    );
}
