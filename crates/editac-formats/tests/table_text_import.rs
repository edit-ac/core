include!("support/jobs_harness.rs");
use editac_core::{document::BlockAttributes, modules::content::Content};
use editac_formats::table_text::import::{self as table, *};
use yrs::Any;
const CSV: &[u8] = include_bytes!("../../../fixtures/formats/table-text/quoted.csv");
const TSV: &[u8] = include_bytes!("../../../fixtures/formats/table-text/quoted.tsv");
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
fn dialect() -> Dialect {
    Dialect {
        delimiter: Delimiter::Comma,
        newline: Newline::Lf,
        encoding: Encoding::Utf8,
        header: Header::FirstRow,
        ragged: Ragged::Reject,
    }
}
fn begin(o: &Owner, bytes: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    begin_d(o, bytes, id, dialect())
}
fn begin_d(o: &Owner, bytes: &[u8], id: &str, d: Dialect) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.profile = if d.delimiter == Delimiter::Tab {
        TSV_PROFILE
    } else {
        PROFILE
    };
    s.original = bytes;
    s.filename = "fixture.csv";
    s.media_type = "text/csv";
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
fn prepared(o: &Owner, bytes: &[u8], d: Dialect) -> (PreparedJob<MemoryStore>, Prepared) {
    let mut j = begin_d(o, bytes, "table", d);
    let p = table::prepare(&mut j, d, Budgets::default(), || 0).unwrap();
    (j, p)
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn data(attributes: &BlockAttributes) -> Any {
    let BlockAttributes::Unknown(t) = attributes else {
        panic!()
    };
    let Content::RichTable { data } = Content::from_tuple(t).unwrap().unwrap() else {
        panic!()
    };
    data
}
fn obj(a: &Any) -> &std::collections::HashMap<String, Any> {
    let Any::Map(v) = a else { panic!("{a:?}") };
    v
}
fn arr(a: &Any) -> &[Any] {
    let Any::Array(v) = a else { panic!() };
    v
}
fn cells(a: &Any) -> Vec<Vec<String>> {
    arr(&obj(a)["rows"])
        .iter()
        .map(|r| {
            arr(r)
                .iter()
                .map(|c| {
                    let p = &arr(&obj(c)["paragraphs"])[0];
                    let runs = arr(&obj(p)["runs"]);
                    let Any::String(s) = &arr(&runs[0])[0] else {
                        panic!()
                    };
                    s.to_string()
                })
                .collect()
        })
        .collect()
}
fn p_data(p: &Prepared) -> Any {
    data(p.blocks()[0].attributes.as_ref().unwrap())
}
fn failure_with(bytes: &[u8], d: Dialect, b: Budgets, code: &str) {
    let (o, _) = setup();
    let before = checkpoint(&o);
    let mut j = begin(&o, bytes, "failure");
    let e = table::prepare(&mut j, d, b, || 0).err().unwrap();
    assert_eq!(e.code, code, "{e:?}");
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert!(matches!(
        j.finish_import(&mut setup().0, &blocks("bad"), 0),
        Err(JobError::Finished)
    ));
}
fn failure(bytes: &[u8], code: &str) {
    failure_with(bytes, dialect(), Budgets::default(), code)
}
#[test]
fn exact_quoted_unicode_empty_and_formula_cells_match_reference() {
    let (o, _) = setup();
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/formats/table-text/expected.json"
    ))
    .unwrap();
    for (bytes, name, d) in [
        (CSV, "quoted.csv", dialect()),
        (
            TSV,
            "quoted.tsv",
            Dialect {
                delimiter: Delimiter::Tab,
                newline: Newline::CrLf,
                ..dialect()
            },
        ),
    ] {
        let (_, p) = prepared(&o, bytes, d);
        assert_eq!(
            serde_json::to_value(cells(&p_data(&p))).unwrap(),
            expected[name]
        );
        if let Ok(dir) = std::env::var("EDITAC_FORMATS_OUTPUT") {
            std::fs::write(
                std::path::Path::new(&dir).join(format!("observed-{name}.json")),
                serde_json::to_vec(&cells(&p_data(&p))).unwrap(),
            )
            .unwrap();
        }
        assert_eq!(p.report().scanned_bytes, bytes.len());
        assert_eq!(p.report().cells, 9);
        assert_eq!(p.report().rows, 3);
        assert_eq!(p.report().columns, 3);
        assert_eq!(p.original_sha256, <[u8; 32]>::from(Sha256::digest(bytes)));
    }
}
#[test]
fn one_prepared_session_commit_undo_redo_reopen_and_original_recovery() {
    let (mut o, store) = setup();
    let before = checkpoint(&o);
    let (mut j, p) = prepared(&o, CSV, dialect());
    let expected = cells(&p_data(&p));
    assert_eq!(checkpoint(&o), before);
    let result = p.commit(&mut j, &mut o, 0).unwrap().unwrap();
    assert!(result.assets.is_empty());
    assert_eq!(j.source().original(), CSV);
    let snapshot = o.service().read(0).unwrap().snapshot;
    let a = snapshot
        .visible
        .iter()
        .find_map(|n| {
            n.block_attributes
                .as_ref()
                .filter(|a| matches!(a, BlockAttributes::Unknown(_)))
        })
        .unwrap();
    assert_eq!(cells(&data(a)), expected);
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    let reopened = ConversionOwner::open(
        store,
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        policy(),
    )
    .unwrap();
    let snap = reopened.service().read(0).unwrap().snapshot;
    assert_eq!(
        cells(&data(
            snap.visible
                .iter()
                .find_map(|n| n
                    .block_attributes
                    .as_ref()
                    .filter(|a| matches!(a, BlockAttributes::Unknown(_))))
                .unwrap()
        )),
        expected
    );
    assert_eq!(current(&reopened), current(&o));
    println!(
        "TABLE_SESSION commits=1 undo=1 redo=1 reopen=1 original_bytes={} assets=0 network_calls=0",
        CSV.len()
    );
}
#[test]
fn header_none_and_first_row_are_explicit_without_dropping_data() {
    let (o, _) = setup();
    for header in [Header::None, Header::FirstRow] {
        let (_, p) = prepared(
            &o,
            b"a,b\nc,d",
            Dialect {
                header,
                ..dialect()
            },
        );
        let data = p_data(&p);
        let rows = arr(&obj(&data)["rows"]);
        assert_eq!(
            obj(&arr(&rows[0])[0])["header"],
            Any::Bool(header == Header::FirstRow)
        );
        assert_eq!(obj(&arr(&rows[1])[0])["header"], Any::Bool(false));
        assert_eq!(cells(&data), [["a", "b"], ["c", "d"]]);
    }
}
#[test]
fn optional_bom_is_reviewed_and_original_bytes_retained() {
    let (o, _) = setup();
    let bytes = b"\xef\xbb\xbfa,b";
    let (j, p) = prepared(
        &o,
        bytes,
        Dialect {
            encoding: Encoding::Utf8OptionalBom,
            ..dialect()
        },
    );
    assert!(p.report().bom_removed);
    assert_eq!(j.source().original(), bytes);
    assert_eq!(cells(&p_data(&p)), [["a", "b"]]);
}
#[test]
fn inert_strings_and_whitespace_never_infer_types() {
    let (o, _) = setup();
    let (_, p) = prepared(
        &o,
        b"=1+1,+2,-3,@SUM(A1),001,2026-10-18,  spaced  ,https://example.test",
        dialect(),
    );
    assert_eq!(
        cells(&p_data(&p))[0],
        [
            "=1+1",
            "+2",
            "-3",
            "@SUM(A1)",
            "001",
            "2026-10-18",
            "  spaced  ",
            "https://example.test"
        ]
    );
}
#[test]
fn escaped_quote_end_empty_field_and_final_newline() {
    let (o, _) = setup();
    for bytes in [b"\"a\"\"\",,\"\"".as_slice(), b"\"a\"\"\",,\"\"\n"] {
        let (_, p) = prepared(&o, bytes, dialect());
        assert_eq!(cells(&p_data(&p)), [["a\"", "", ""]]);
    }
}
#[test]
fn single_quoted_empty_cell_is_a_real_row() {
    let (o, _) = setup();
    let (_, p) = prepared(&o, b"\"\"", dialect());
    assert_eq!(cells(&p_data(&p)), [[""]]);
}
#[test]
fn exact_lf_inside_cell_survives_session() {
    let (mut o, _) = setup();
    let (mut j, p) = prepared(&o, b"\"a\nb\",c", dialect());
    p.commit(&mut j, &mut o, 0).unwrap();
    let snap = o.service().read(0).unwrap().snapshot;
    assert_eq!(
        cells(&data(
            snap.visible
                .iter()
                .find_map(|n| n
                    .block_attributes
                    .as_ref()
                    .filter(|a| matches!(a, BlockAttributes::Unknown(_))))
                .unwrap()
        )),
        [["a\nb", "c"]]
    );
}
macro_rules! bad {
    ($n:ident,$b:expr,$c:literal) => {
        #[test]
        fn $n() {
            failure($b, $c)
        }
    };
}
bad!(empty_input, b"", "EMPTY_INPUT");
bad!(blank_record, b"a\n\nb", "EMPTY_RECORD");
bad!(only_newline, b"\n", "EMPTY_RECORD");
bad!(unclosed, b"\"bad", "UNCLOSED_QUOTE");
bad!(quote_inside_unquoted, b"ab\"c", "QUOTE_POLICY");
bad!(text_after_quote, b"\"ab\"x", "QUOTE_POLICY");
bad!(backslash_is_not_quote_escape, b"\"a\\\"b\"", "QUOTE_POLICY");
bad!(bare_cr, b"a\rb", "NEWLINE_POLICY");
bad!(crlf_when_lf_selected, b"a\r\n", "NEWLINE_POLICY");
bad!(
    cr_in_quoted_cell,
    b"\"a\r\nb\"",
    "SHARED_CELL_CR_UNSUPPORTED"
);
bad!(invalid_utf8, b"\xff", "UTF8");
bad!(nul_control, b"a\0b", "CONTROL_CHARACTER");
bad!(bom_not_opted_in, b"\xef\xbb\xbfa", "BOM_POLICY");
bad!(ragged_short, b"a,b\nc", "RAGGED_ROW");
bad!(ragged_long, b"a\nb,c", "RAGGED_ROW");
#[test]
fn lf_when_crlf_selected() {
    failure_with(
        b"a\nb",
        Dialect {
            newline: Newline::CrLf,
            ..dialect()
        },
        Budgets::default(),
        "NEWLINE_POLICY",
    );
}
#[test]
fn lowered_limits_are_enforced() {
    for (b, code) in [
        (
            Budgets {
                rows: 1,
                ..Budgets::default()
            },
            "TABLE_BUDGET",
        ),
        (
            Budgets {
                columns: 1,
                ..Budgets::default()
            },
            "COLUMN_BUDGET",
        ),
        (
            Budgets {
                cells: 3,
                ..Budgets::default()
            },
            "TABLE_BUDGET",
        ),
        (
            Budgets {
                cell_utf16: 1,
                ..Budgets::default()
            },
            "TEXT_BUDGET",
        ),
        (
            Budgets {
                total_utf16: 3,
                ..Budgets::default()
            },
            "TEXT_BUDGET",
        ),
    ] {
        failure_with(b"aa,b\nc,d", dialect(), b, code);
    }
}
#[test]
fn hard_limits_cannot_be_raised() {
    failure_with(
        b"a",
        dialect(),
        Budgets {
            rows: 129,
            ..Budgets::default()
        },
        "INVALID_BUDGET",
    );
    failure_with(
        b"a",
        dialect(),
        Budgets {
            cells: 0,
            ..Budgets::default()
        },
        "INVALID_BUDGET",
    );
}
#[test]
fn hard_rows_columns_cells_and_utf16_limits() {
    failure(vec!["a"; 129].join("\n").as_bytes(), "TABLE_BUDGET");
    failure(vec!["a"; 33].join(",").as_bytes(), "COLUMN_BUDGET");
    failure(
        vec![vec!["a"; 32].join(","); 33].join("\n").as_bytes(),
        "TABLE_BUDGET",
    );
    failure("🙂".repeat(4097).as_bytes(), "TEXT_BUDGET");
    failure("a".repeat(32769).as_bytes(), "CELL_BUDGET");
}
#[test]
fn maximum_dimensions_and_cell_length_are_admitted() {
    let (o, _) = setup();
    for bytes in [
        vec![vec![""; 32].join(","); 32].join("\n"),
        "🙂".repeat(4096),
        vec!["a"; 128].join("\n"),
    ] {
        let (_, p) = prepared(&o, bytes.as_bytes(), dialect());
        assert!(p.report().cells <= 1024);
    }
}
#[test]
fn job_nodes_output_and_profile_enforced() {
    let (o, _) = setup();
    for (nodes, output, code) in [(1, 4096, "NODE_BUDGET"), (4096, 1, "OUTPUT_BUDGET")] {
        let mut s = spec(&o, "bounds", Direction::Import);
        s.profile = PROFILE;
        s.original = b"a,b";
        s.limits.nodes = nodes;
        s.limits.output_bytes = output;
        let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
        assert_eq!(
            table::prepare(&mut j, dialect(), Budgets::default(), || 0)
                .err()
                .unwrap()
                .code,
            code
        );
    }
    let mut j = begin(&o, b"a", "wrong");
    assert!(table::prepare(&mut j, dialect(), Budgets::default(), || 0).is_ok());
    let s = spec(&o, "wrong-profile", Direction::Import);
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        table::prepare(&mut j, dialect(), Budgets::default(), || 0)
            .err()
            .unwrap()
            .code,
        "TABLE_TEXT_PROFILE"
    );
}
#[test]
fn cancellation_deadline_and_scan_cancellation_are_atomic() {
    for late in [false, true] {
        let (o, _) = setup();
        let before = checkpoint(&o);
        let mut j = begin(&o, CSV, "cancel");
        if !late {
            j.cancellation().cancel();
        }
        assert_eq!(
            table::prepare(&mut j, dialect(), Budgets::default(), || if late {
                101
            } else {
                0
            })
            .err()
            .unwrap()
            .code,
            if late { "TIMEOUT" } else { "CANCELLED" }
        );
        assert_eq!(checkpoint(&o), before);
    }
    let (o, _) = setup();
    let bytes = "a".repeat(8192);
    let mut j = begin(&o, bytes.as_bytes(), "scan");
    let cancel = j.cancellation();
    let mut calls = 0;
    let e = table::prepare(&mut j, dialect(), Budgets::default(), || {
        calls += 1;
        if calls == 4 {
            cancel.cancel();
        }
        0
    })
    .err()
    .unwrap();
    assert_eq!(e.code, "CANCELLED");
}
#[test]
fn stale_revision_and_disabled_codec_leave_state_unchanged() {
    for disabled in [true, false] {
        let (mut o, _) = setup();
        let (mut j, p) = prepared(&o, CSV, dialect());
        if disabled {
            o.service_mut().set_policy(HostPolicy::default());
        } else {
            edit(&mut o, "later");
        }
        let before = checkpoint(&o);
        assert!(p.commit(&mut j, &mut o, 0).is_err());
        assert_eq!(checkpoint(&o), before);
    }
}
#[test]
fn cancellation_after_preparation_is_atomic() {
    let (mut o, _) = setup();
    let (mut j, p) = prepared(&o, CSV, dialect());
    let before = checkpoint(&o);
    j.cancellation().cancel();
    assert!(p.commit(&mut j, &mut o, 0).is_err());
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn foreign_prepared_job_is_rejected() {
    let (mut o, _) = setup();
    let (mut j, p) = prepared(&o, CSV, dialect());
    let mut other = begin(&o, b"x", "other");
    assert_eq!(
        p.commit(&mut other, &mut o, 0).err().unwrap().code,
        "FOREIGN_JOB"
    );
    assert!(other.finish_import(&mut o, &blocks("x"), 0).is_ok());
    j.abort().unwrap();
}

#[test]
fn selected_profile_and_delimiter_cannot_disagree() {
    let (o, _) = setup();
    let mut j = begin(&o, b"a\tb", "mismatch");
    assert_eq!(
        table::prepare(
            &mut j,
            Dialect {
                delimiter: Delimiter::Tab,
                ..dialect()
            },
            Budgets::default(),
            || 0
        )
        .err()
        .unwrap()
        .code,
        "TABLE_TEXT_PROFILE"
    );
}
