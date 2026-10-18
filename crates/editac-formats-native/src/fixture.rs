//! Qualification-only checkpoint fixtures created through real shared jobs.
use super::*;
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
    },
    modules::content::{Alignment, Content},
};
fn run(text: &str, marks: Vec<(Mark, Option<String>)>) -> FragmentRun {
    FragmentRun {
        opaque_marks: vec![],
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

pub fn make() -> Value {
    let id = DocumentIdentity::v5(
        "27000000-0000-4000-8000-000000000099",
        "27000000-0000-4000-8000-000000000000",
    )
    .unwrap();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p.codecs.images = true;
    let mut o = ConversionOwner::create(
        store,
        id.clone(),
        &[InitialNode {
            kind: "block".into(),
            text: "base".into(),
        }],
        p,
    )
    .unwrap();
    let d = o.service().session().document();
    let node = d.snapshot().unwrap().visible[0].id.clone();
    let a = d.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let spec = JobSpec {
        id: "fixture",
        profile: rtf::PROFILE,
        direction: Direction::Import,
        original: b"",
        filename: "fixture.rtf",
        media_type: "application/rtf",
        target: Some(Selection {
            anchor: a.clone(),
            focus: a,
        }),
        limits: LIMITS,
        timeout: 4000,
        memory_bytes: 32 * 1024 * 1024,
    };
    let mut j =
        PreparedJob::begin(&o, spec, &JobPool::new(1).unwrap(), Box::new(NativePort), 0).unwrap();
    let kind = std::env::args().nth(2).unwrap_or_default();
    let bs = if kind == "loss" {
        vec![
            FragmentBlock {
                attributes: Some(BlockAttributes::Heading(2)),
                ..para(vec![
                    run("code", vec![(Mark::Code, None)]),
                    run(
                        "link",
                        vec![(Mark::Link, Some("https://example.test/a".into()))],
                    ),
                ])
            },
            FragmentBlock {
                attributes: Some(BlockAttributes::Unknown(
                    Content::Image {
                        url: "https://example.invalid/image.png".into(),
                        alt: "x^2".into(),
                        title: "".into(),
                        source: "x^2".into(),
                    }
                    .tuple()
                    .unwrap(),
                )),
                ..para(vec![run("x^2", vec![])])
            },
        ]
    } else if kind == "marks" {
        vec![para(
            (0..16)
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
                .collect(),
        )]
    } else {
        fixture()
    };
    j.finish_import(&mut o, &bs, 0).unwrap();
    let cp = o.service().session().document().checkpoint();
    json!({"documentId":"27000000-0000-4000-8000-000000000099","epoch":id.epoch,"writerId":cp.writer_id,"checkpointSha256":hash(&cp.bytes),"checkpoint":cp.bytes})
}
