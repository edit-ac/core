include!("support/jobs_harness.rs");
use editac_core::{
    commands::format::Mark,
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_formats::table_text::{export as writer, import as reader};
use writer::{Dialect, Newline};
use yrs::Any;
#[derive(Default)]
struct Sink(Vec<u8>);
impl ArtifactSink for Sink {
    fn write(&mut self, b: &[u8]) -> Result<(), SaveFailure> {
        self.0 = b.to_vec();
        Ok(())
    }
    fn close(&mut self) -> Result<(), SaveFailure> {
        Ok(())
    }
}
const CSV: &[u8] = include_bytes!("../../../fixtures/formats/table-text/quoted.csv");
fn policy() -> HostPolicy {
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p
}
fn setup() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    o.service_mut().set_policy(policy());
    (o, s)
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn insert(o: &mut Owner, bs: &[FragmentBlock]) {
    job(o, "insert", Direction::Import)
        .finish_import(o, bs, 0)
        .unwrap();
}
fn import(o: &mut Owner, bytes: &[u8], header: reader::Header) {
    let mut s = spec(o, "source", Direction::Import);
    s.profile = reader::PROFILE;
    s.original = bytes;
    s.filename = "fixture.csv";
    s.media_type = "text/csv";
    let mut j = PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    reader::prepare(
        &mut j,
        reader::Dialect {
            delimiter: reader::Delimiter::Comma,
            newline: reader::Newline::Lf,
            encoding: reader::Encoding::Utf8,
            header,
            ragged: reader::Ragged::Reject,
        },
        reader::Budgets::default(),
        || 0,
    )
    .unwrap()
    .commit(&mut j, o, 0)
    .unwrap();
}
fn table_id(o: &Owner) -> String {
    o.service().read(0).unwrap().snapshot.visible.into_iter().find(|n| matches!(&n.block_attributes,Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t),Ok(Some(Content::RichTable{..}|Content::Table{..}))))).unwrap().id.clone()
}
fn begin(o: &Owner, profile: Profile) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, "export", Direction::Export);
    s.profile = profile;
    s.original = CSV;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
fn output(o: &Owner, profile: Profile, newline: Newline, loss: bool) -> writer::Completion {
    writer::export(
        &mut begin(o, profile),
        Some(&table_id(o)),
        Dialect { newline },
        loss,
        || 0,
    )
    .unwrap()
}
fn legacy(texts: Vec<Vec<&str>>, marked: bool, alignment: Alignment) -> FragmentBlock {
    let rows: Vec<Vec<Vec<FragmentRun>>> = texts
        .iter()
        .map(|r| {
            r.iter()
                .map(|s| {
                    vec![FragmentRun {
                        text: (*s).into(),
                        marks: if marked {
                            vec![(Mark::Bold, None)]
                        } else {
                            vec![]
                        },
                        opaque_marks: vec![],
                    }]
                })
                .collect()
        })
        .collect();
    let source = texts
        .iter()
        .map(|r| r.join("\t"))
        .collect::<Vec<_>>()
        .join("\n");
    FragmentBlock {
        runs: vec![FragmentRun {
            text: source.clone(),
            marks: vec![],
            opaque_marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(
            Content::Table {
                alignments: vec![alignment; texts[0].len()],
                rows,
                source,
            }
            .tuple()
            .unwrap(),
        )),
        containers: vec![],
        checked: None,
    }
}
fn failure(o: &Owner, selected: Option<&str>, reason: &str) {
    let before = checkpoint(o);
    let mut j = begin(o, writer::PROFILE);
    let e = writer::export(
        &mut j,
        selected,
        Dialect {
            newline: Newline::Lf,
        },
        false,
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, reason, "{e:?}");
    assert_eq!(checkpoint(o), before);
    assert_eq!(j.source().original(), CSV);
    assert!(matches!(j.finish_export(0), Err(JobError::Finished)));
}
#[test]
fn selected_v2_exact_csv_tsv_unicode_multiline_quotes_empty_formula_and_no_mutation() {
    let (mut o, store) = setup();
    import(&mut o, CSV, reader::Header::None);
    let before = checkpoint(&o);
    for (name, p, n) in [
        ("exact.csv", writer::PROFILE, Newline::CrLf),
        ("exact.tsv", writer::TSV_PROFILE, Newline::Lf),
    ] {
        let c = output(&o, p, n, false);
        assert_eq!(c.report.cells, 9);
        assert_eq!(c.report.rows, 3);
        assert_eq!(c.report.columns, 3);
        assert_eq!(c.report.transformed_cells, 0);
        assert!(
            c.report
                .diagnostics
                .iter()
                .any(|d| d.code == "OUTSIDE_SELECTED_TABLE")
        );
        assert_eq!(checkpoint(&o), before);
        let second = output(&o, p, n, false);
        assert_eq!(c.artifact.bytes(), second.artifact.bytes());
        if let Ok(dir) = std::env::var("EDITAC_FORMATS_OUTPUT") {
            std::fs::write(std::path::Path::new(&dir).join(name), c.artifact.bytes()).unwrap();
        }
    }
    let reopened = ConversionOwner::open(
        store,
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        policy(),
    )
    .unwrap();
    assert_eq!(current(&reopened), current(&o));
    assert_eq!(table_id(&reopened), table_id(&o));
    assert_eq!(
        output(&reopened, writer::PROFILE, Newline::Lf, false)
            .artifact
            .bytes(),
        output(&o, writer::PROFILE, Newline::Lf, false)
            .artifact
            .bytes()
    );
    println!(
        "TABLE_EXPORT rows=3 cells=9 live_updates=0 reopen=1 original_bytes={} network=0",
        CSV.len()
    );
}
#[test]
fn safe_profiles_transform_only_declared_formula_like_cells_and_report_each() {
    let (mut o, _) = setup();
    let texts = vec![
        vec!["=1+1", "+SUM(A1)", "-2", "@x"],
        vec!["  =x", "\tcmd", "\ncmd", "text"],
        vec!["'safe", "12", " é", "🙂"],
    ];
    insert(&mut o, &[legacy(texts, false, Alignment::None)]);
    for (name, p) in [
        ("safe.csv", writer::SAFE_PROFILE),
        ("safe.tsv", writer::SAFE_TSV_PROFILE),
    ] {
        let c = output(&o, p, Newline::CrLf, true);
        assert_eq!(c.report.transformed_cells, 7);
        assert_eq!(
            c.report
                .diagnostics
                .iter()
                .filter(|d| d.code == "SPREADSHEET_SAFE_PREFIX")
                .count(),
            7
        );
        assert_eq!(c.report.diagnostics.iter().filter(|d| d.lossy).count(), 1);
        if let Ok(dir) = std::env::var("EDITAC_FORMATS_OUTPUT") {
            std::fs::write(std::path::Path::new(&dir).join(name), c.artifact.bytes()).unwrap();
        }
    }
    let c = output(&o, writer::PROFILE, Newline::Lf, true);
    assert_eq!(c.report.transformed_cells, 0);
    assert!(
        std::str::from_utf8(c.artifact.bytes())
            .unwrap()
            .starts_with("\"=1+1\"")
    );
}
#[test]
fn rich_marks_alignment_and_header_loss_require_explicit_approval() {
    let (mut o, _) = setup();
    insert(
        &mut o,
        &[legacy(vec![vec!["a", "b"]], true, Alignment::Right)],
    );
    failure(&o, Some(&table_id(&o)), "loss-approval-required");
    let c = output(&o, writer::PROFILE, Newline::Lf, true);
    assert_eq!(c.artifact.bytes(), b"\"a\",\"b\"\n");
    assert!(
        c.report
            .diagnostics
            .iter()
            .any(|d| d.code == "CELL_MARKS_LOST" && d.lossy)
    );
    assert!(
        c.report
            .diagnostics
            .iter()
            .any(|d| d.code == "TABLE_ALIGNMENT_LOST" && d.lossy)
    );
    let (mut o, _) = setup();
    import(&mut o, CSV, reader::Header::FirstRow);
    failure(&o, Some(&table_id(&o)), "loss-approval-required");
    let c = output(&o, writer::PROFILE, Newline::Lf, true);
    assert_eq!(c.report.rows, 3);
    assert_eq!(
        c.report
            .diagnostics
            .iter()
            .filter(|d| d.code == "HEADER_FLAG_LOST_ROW_RETAINED")
            .count(),
        3
    );
}
#[test]
fn no_selection_never_drops_document_or_chooses_first_table() {
    let (mut o, _) = setup();
    failure(&o, None, "explicit-table-selection-required");
    import(&mut o, CSV, reader::Header::None);
    failure(&o, None, "explicit-table-selection-required");
    insert(
        &mut o,
        &[legacy(vec![vec!["other"]], false, Alignment::None)],
    );
    failure(&o, None, "explicit-table-selection-required");
    failure(&o, Some("unknown"), "selected-table-not-captured");
    let para = o
        .service()
        .read(0)
        .unwrap()
        .snapshot
        .visible
        .into_iter()
        .find(|n| matches!(n.block_attributes, None | Some(BlockAttributes::Paragraph)))
        .unwrap()
        .id
        .clone();
    failure(&o, Some(&para), "selected-target-not-table");
    let c = output(&o, writer::PROFILE, Newline::Lf, true);
    assert!(
        c.report
            .diagnostics
            .iter()
            .any(|d| d.code == "OUTSIDE_SELECTED_TABLE")
    );
}
#[test]
fn fixed_revision_export_survives_later_edit_and_does_not_mark_it_saved() {
    let (mut o, _) = setup();
    import(&mut o, CSV, reader::Header::None);
    let id = table_id(&o);
    let mut j = begin(&o, writer::PROFILE);
    let revision = j.contract().revision.clone();
    let mut save = SaveTransition::begin(&j).unwrap();
    edit(&mut o, "later");
    let after = checkpoint(&o);
    let c = writer::export(
        &mut j,
        Some(&id),
        Dialect {
            newline: Newline::Lf,
        },
        false,
        || 0,
    )
    .unwrap();
    assert_eq!(c.artifact.revision(), &revision);
    assert_eq!(checkpoint(&o), after);
    let mut destination = Sink::default();
    assert!(
        !save
            .write_and_close(
                &c.artifact,
                &o.service().read(0).unwrap().revision,
                &mut destination
            )
            .unwrap()
    );
    assert_eq!(destination.0, c.artifact.bytes());
}
#[test]
fn cancel_timeout_and_output_budget_abort_without_live_changes() {
    let (mut o, _) = setup();
    import(&mut o, CSV, reader::Header::None);
    let id = table_id(&o);
    let before = checkpoint(&o);
    for timeout in [false, true] {
        let mut j = begin(&o, writer::PROFILE);
        if !timeout {
            j.cancellation().cancel();
        }
        let e = writer::export(
            &mut j,
            Some(&id),
            Dialect {
                newline: Newline::Lf,
            },
            false,
            || if timeout { 101 } else { 0 },
        )
        .err()
        .unwrap();
        assert_eq!(
            e.reason,
            if timeout {
                "job:Timeout"
            } else {
                "job:Cancelled"
            }
        );
        assert_eq!(checkpoint(&o), before);
    }
    let mut s = spec(&o, "limit", Direction::Export);
    s.profile = writer::PROFILE;
    s.limits.output_bytes = 3;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        writer::export(
            &mut j,
            Some(&id),
            Dialect {
                newline: Newline::Lf
            },
            false,
            || 0
        )
        .err()
        .unwrap()
        .reason,
        "output-budget"
    );
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn lower_node_budget_is_enforced() {
    let (mut o, _) = setup();
    import(&mut o, CSV, reader::Header::None);
    let id = table_id(&o);
    let mut s = spec(&o, "nodes", Direction::Export);
    s.profile = writer::PROFILE;
    s.limits.nodes = 8;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        writer::export(
            &mut j,
            Some(&id),
            Dialect {
                newline: Newline::Lf
            },
            false,
            || 0
        )
        .err()
        .unwrap()
        .reason,
        "node-budget"
    );
}
#[test]
fn wrong_profile_fails_without_mutation() {
    let (o, _) = setup();
    let mut j = begin(&o, profile_fixture());
    let before = checkpoint(&o);
    let e = writer::export(
        &mut j,
        None,
        Dialect {
            newline: Newline::Lf,
        },
        false,
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, "export-profile-required");
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn cancellation_and_deadline_during_serialization_release_only_job_resources() {
    let (mut o, _) = setup();
    import(&mut o, CSV, reader::Header::None);
    let id = table_id(&o);
    let before = checkpoint(&o);
    for cancel in [true, false] {
        let mut j = begin(&o, writer::PROFILE);
        let token = j.cancellation();
        let mut calls = 0;
        let e = writer::export(
            &mut j,
            Some(&id),
            Dialect {
                newline: Newline::Lf,
            },
            false,
            || {
                calls += 1;
                if calls == 12 && cancel {
                    token.cancel();
                }
                if calls >= 12 && !cancel { 101 } else { 0 }
            },
        )
        .err()
        .unwrap();
        assert_eq!(
            e.reason,
            if cancel {
                "job:Cancelled"
            } else {
                "job:Timeout"
            }
        );
        assert_eq!(checkpoint(&o), before);
        assert!(matches!(j.finish_export(0), Err(JobError::Finished)));
    }
}
fn object(xs: Vec<(&str, Any)>) -> Any {
    Any::Map(Arc::new(
        xs.into_iter().map(|(k, v)| (k.into(), v)).collect(),
    ))
}
fn array(xs: Vec<Any>) -> Any {
    Any::Array(xs.into())
}
fn rich(merged: bool, multiple: bool, style: bool) -> FragmentBlock {
    let p = object(vec![
        (
            "style",
            array(if style {
                vec![Any::from("heading"), Any::from(2u32)]
            } else {
                vec![Any::from("paragraph")]
            }),
        ),
        (
            "runs",
            array(vec![array(vec![
                Any::from("bold🙂"),
                array(vec![array(vec![Any::from("bold")])]),
            ])]),
        ),
    ]);
    let c = object(vec![
        (
            "paragraphs",
            array(if multiple {
                vec![p.clone(), p]
            } else {
                vec![p]
            }),
        ),
        ("rowSpan", Any::from(1u32)),
        ("columnSpan", Any::from(if merged { 2u32 } else { 1u32 })),
        ("header", Any::Bool(false)),
    ]);
    let data = object(vec![
        (
            "rows",
            array(vec![array(if merged {
                vec![c, Any::Null]
            } else {
                vec![c]
            })]),
        ),
        (
            "alignments",
            array(vec![Any::from("none"); if merged { 2 } else { 1 }]),
        ),
        ("source", Any::from("original rich table")),
    ]);
    FragmentBlock {
        runs: vec![FragmentRun {
            text: "bold🙂".into(),
            marks: vec![],
            opaque_marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(
            Content::RichTable { data }.tuple().unwrap(),
        )),
        containers: vec![],
        checked: None,
    }
}
#[test]
fn rich_v2_cell_marks_and_styles_are_reported_completely() {
    let (mut o, _) = setup();
    insert(&mut o, &[rich(false, false, true)]);
    failure(&o, Some(&table_id(&o)), "loss-approval-required");
    let c = output(&o, writer::PROFILE, Newline::Lf, true);
    assert_eq!(c.artifact.bytes(), "\"bold🙂\"\n".as_bytes());
    for code in ["CELL_MARKS_LOST", "CELL_STYLE_LOST"] {
        assert_eq!(
            c.report
                .diagnostics
                .iter()
                .filter(|d| d.code == code && d.lossy)
                .count(),
            1
        );
    }
}
#[test]
fn merged_and_multi_paragraph_cells_fail_even_with_loss_approval() {
    for (merged, multiple, reason) in [
        (true, false, "merged-table-unrepresentable"),
        (false, true, "multi-paragraph-cell-unrepresentable"),
    ] {
        let (mut o, _) = setup();
        insert(&mut o, &[rich(merged, multiple, false)]);
        let before = checkpoint(&o);
        let e = writer::export(
            &mut begin(&o, writer::PROFILE),
            Some(&table_id(&o)),
            Dialect {
                newline: Newline::Lf,
            },
            true,
            || 0,
        )
        .err()
        .unwrap();
        assert_eq!(e.reason, reason);
        assert_eq!(checkpoint(&o), before);
    }
}
#[test]
fn export_has_no_history_action_and_original_import_remains_undoable() {
    let (mut o, _) = setup();
    let initial = checkpoint(&o);
    import(&mut o, CSV, reader::Header::None);
    let captured = checkpoint(&o);
    let c = output(&o, writer::PROFILE, Newline::Lf, false);
    assert!(!c.artifact.bytes().is_empty());
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    assert_eq!(current(&o).contains("base"), true);
    assert_ne!(captured, initial);
    assert_eq!(
        output(&o, writer::PROFILE, Newline::Lf, false)
            .artifact
            .bytes(),
        c.artifact.bytes()
    );
}
