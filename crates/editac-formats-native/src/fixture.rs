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
    let kind = std::env::args().nth(2).unwrap_or_default();
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
            text: if kind == "odt" || kind == "docx" {
                ""
            } else {
                "base"
            }
            .into(),
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
    let bs = if kind == "docx" {
        let mut blocks = odt_fixture();
        blocks[0].runs[0].text = "DOCX 🙂 heading".into();
        blocks
    } else if kind == "odt" {
        odt_fixture()
    } else if kind == "odt-loss" || kind == "docx-loss" {
        let mut blocks = odt_fixture();
        blocks[2].attributes = Some(BlockAttributes::Code("rust".into()));
        blocks.push(FragmentBlock {
            attributes: Some(BlockAttributes::Unknown(
                Content::Image {
                    url: "https://example.invalid/image.png".into(),
                    alt: "unsupported image".into(),
                    title: String::new(),
                    source: "unsupported image".into(),
                }
                .tuple()
                .unwrap(),
            )),
            ..para(vec![run("unsupported image", vec![])])
        });
        blocks
    } else if kind == "loss" {
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
    } else if kind == "table" || kind == "table-multiple" {
        let cells = [
            ["name", "formula", "empty"],
            ["🙂 e\u{301}", "=1+1", ""],
            ["a\nb", "+SUM(A1)", "he said \"yes\""],
            ["tab\there", "-42", "@cmd"],
        ];
        let source = cells
            .iter()
            .map(|r| r.join("\t"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut blocks = vec![
            para(vec![run("Outside selected table", vec![])]),
            FragmentBlock {
                runs: vec![run(&source, vec![])],
                attributes: Some(BlockAttributes::Unknown(
                    Content::Table {
                        rows: cells
                            .iter()
                            .map(|r| {
                                r.iter()
                                    .map(|c| vec![run(c, vec![(Mark::Bold, None)])])
                                    .collect()
                            })
                            .collect(),
                        alignments: vec![Alignment::None; 3],
                        source,
                    }
                    .tuple()
                    .unwrap(),
                )),
                containers: vec![],
                checked: None,
            },
            para(vec![run("Tail", vec![])]),
        ];
        if kind == "table-multiple" {
            blocks.push(blocks[1].clone());
        }
        blocks
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
    let selected = o
        .service()
        .read(0)
        .unwrap()
        .snapshot
        .visible
        .iter()
        .find(|n| matches!(&n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .map(|n| n.id.clone());
    json!({"nonTableBlock":o.service().read(0).unwrap().snapshot.visible[0].id,"selectedTable":selected,"documentId":"27000000-0000-4000-8000-000000000099","epoch":id.epoch,"writerId":cp.writer_id,"checkpointSha256":hash(&cp.bytes),"checkpoint":cp.bytes})
}

fn odt_fixture() -> Vec<FragmentBlock> {
    use editac_core::commands::lists::ContainerStyle;
    use editac_core::modules::assets::*;
    let mut heading = para(vec![run("ODT 🙂 heading", vec![])]);
    heading.attributes = Some(BlockAttributes::Heading(2));
    let linked = para(vec![
        run("Bold & <literal>", vec![(Mark::Bold, None)]),
        run(
            " linked",
            vec![(Mark::Link, Some("https://example.test/safe".into()))],
        ),
    ]);
    let unicode = para(vec![
        run(
            "Unicode e\u{301} العربية\tline\nlast\rreturn",
            vec![
                (Mark::Italic, None),
                (Mark::Underline, None),
                (Mark::Strike, None),
            ],
        ),
        run(" code literal", vec![(Mark::Code, None)]),
    ]);
    let mut first = para(vec![run("First item", vec![])]);
    first.containers = vec![("list".into(), ContainerStyle::Ordered { start: 3 })];
    let mut nested = para(vec![run("Nested bullet 🙂", vec![])]);
    nested.containers = vec![
        ("list".into(), ContainerStyle::Ordered { start: 3 }),
        ("nested".into(), ContainerStyle::Unordered),
    ];
    let mut second = para(vec![run("Second item", vec![])]);
    second.containers = first.containers.clone();
    let descriptor = AssetDescriptor {
        identity: AssetIdentity {
            host: "fixture-host".into(),
            key: "docx-original".into(),
        },
        kind: AssetKind::Image,
        metadata: AssetMetadata {
            filename: "pixel.png".into(),
            media_type: "image/png".into(),
            byte_length: Some(70),
            sha256: Some("4ff6ab670a58c14270e034e2090d9a432caa263a14e0a25785386b0c12f880b5".into()),
            width: Some(1),
            height: Some(1),
            duration_ms: None,
            alt: "Original pixel 🙂".into(),
            caption: "local original".into(),
        },
        fallback: "Original pixel 🙂".into(),
        source: String::new(),
    };
    let mut image = para(vec![run("Original pixel 🙂", vec![])]);
    image.attributes = Some(BlockAttributes::Unknown(
        Content::Asset { descriptor }.tuple().unwrap(),
    ));
    let mut table = para(vec![run("Cell A\tCell 🙂", vec![])]);
    table.attributes = Some(BlockAttributes::Unknown(
        Content::Table {
            alignments: vec![Alignment::None; 2],
            rows: vec![vec![
                vec![run("Cell A", vec![])],
                vec![run("Cell 🙂", vec![])],
            ]],
            source: String::new(),
        }
        .tuple()
        .unwrap(),
    ));
    vec![
        heading, linked, unicode, first, nested, second, image, table,
    ]
}
