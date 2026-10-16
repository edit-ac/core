use editac_highlighting::{
    BACKEND_ID, Backend, MAX_SOURCE_BYTES, Status, TokenSpan,
    cache::{
        BlockInput, HighlightCache, Limits, Projection, Published, Rejection, utf8_to_utf16,
        utf16_to_utf8, validate_projection,
    },
};
use serde_json::Value;

fn input(block: &str, revision: u64, language: &str, source: &str) -> BlockInput {
    BlockInput {
        block: block.into(),
        revision,
        language: language.into(),
        grammar: BACKEND_ID.into(),
        query: "scope-v1".into(),
        theme: "light-v1".into(),
        enabled: true,
        source: source.into(),
    }
}
fn resolve(cache: &mut HighlightCache, backend: &Backend, i: BlockInput) -> Published {
    let job = cache.begin(i).unwrap();
    cache.publish(job.compute(backend)).unwrap()
}
fn assert_cold(backend: &Backend, result: &Published) {
    let i = &result.input;
    let cold = backend.highlight(&i.language, &i.source, i.enabled);
    assert_eq!(result.projection.status, cold.status);
    assert_eq!(result.projection.spans, cold.spans);
    validate_projection(&i.source, &result.projection).unwrap();
}
fn corpus() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/highlighting/corpus.json")).unwrap()
}

#[test]
fn wcf16_multiline_unicode_edit_undo_redo_matches_cold_and_reuses_unrelated_blocks() {
    let backend = Backend::new();
    let mut cache = HighlightCache::new(Limits::default()).unwrap();
    let c = corpus();
    for (n, case) in c["cases"].as_array().unwrap().iter().enumerate() {
        let language = case["language"].as_str().unwrap();
        let source = case["source"].as_str().unwrap();
        let id = format!("block-{n}");
        let original = input(&id, 1, language, source);
        assert_cold(&backend, &resolve(&mut cache, &backend, original.clone()));
        assert_cold(&backend, &resolve(&mut cache, &backend, original.clone()));
        // Open/close multiline comment/string state and retain Unicode/CRLF source.
        let changed = match language {
            "rust" => format!("/* open 🦀\n{source}\nclose */\nlet z = \"é🧑‍💻\";\n"),
            "typescript" => format!("const t = `🦀\n{source}\nclosed`;\n// שלום\n"),
            "json" => "{\"unicode\":\"🦀éשלום\",\r\n\"x\": [1,2,3]}\r\n".into(),
            _ => panic!("pinned corpus language"),
        };
        for (revision, text) in [(2, changed.as_str()), (3, source), (4, changed.as_str())] {
            assert_cold(
                &backend,
                &resolve(&mut cache, &backend, input(&id, revision, language, text)),
            );
        }
    }
    let base = cache.counters();
    // Reuse each untouched final block while another block changes.
    let other = input("unrelated", 1, "rust", "let unrelated = 1;\n");
    resolve(&mut cache, &backend, other.clone());
    let mut edited = other.clone();
    edited.block = "edited".into();
    resolve(&mut cache, &backend, edited.clone());
    edited.source.push_str("/* multiline\n🦀 */");
    edited.revision += 1;
    assert_cold(&backend, &resolve(&mut cache, &backend, edited));
    let before = cache.counters();
    assert_cold(&backend, &resolve(&mut cache, &backend, other));
    assert_eq!(cache.counters().recomputed_blocks, before.recomputed_blocks);
    assert_eq!(cache.counters().hits, before.hits + 1);
    assert_eq!(base.recomputed_blocks, 12);
    assert_eq!(base.hits, 3);
    assert_eq!(cache.counters().recomputed_blocks, 15);
    println!(
        "WCF-16 multiline/undo/redo {:?}; unrelated reuse: 0 recomputed blocks",
        cache.counters()
    );
}
#[test]
fn wcf16_all_identity_keys_invalidate_and_same_revision_different_source_is_safe() {
    let backend = Backend::new();
    let mut cache = HighlightCache::new(Limits::default()).unwrap();
    let initial = input("block", 1, "rust", "let s = \"🦀\";\n");
    resolve(&mut cache, &backend, initial.clone());
    let mut variants = vec![];
    let mut i = initial.clone();
    i.revision += 1;
    variants.push(i);
    let mut i = initial.clone();
    i.block = "other".into();
    variants.push(i);
    let mut i = initial.clone();
    i.language = "typescript".into();
    variants.push(i);
    let mut i = initial.clone();
    i.query = "scope-v2".into();
    variants.push(i);
    let mut i = initial.clone();
    i.theme = "dark-v2".into();
    variants.push(i);
    let mut i = initial.clone();
    i.source = "/* open\n🦀".into();
    variants.push(i);
    for i in variants {
        resolve(&mut cache, &backend, initial.clone());
        let before = cache.counters().recomputed_blocks;
        assert_cold(&backend, &resolve(&mut cache, &backend, i));
        assert_eq!(cache.counters().recomputed_blocks, before + 1);
    }
    let mut future = initial.clone();
    future.grammar = "future-grammar".into();
    let result = resolve(&mut cache, &backend, future);
    assert_eq!(result.projection.status, Status::UnsupportedGrammar);
    assert!(result.projection.spans.is_empty());
    assert_eq!(result.input.source, initial.source);
    assert_cold(&backend, &resolve(&mut cache, &backend, initial));
    println!("WCF-16 keys {:?}", cache.counters());
}
#[test]
fn wcf16_superseded_completions_cannot_publish_or_erase_new_pending_work() {
    let backend = Backend::new();
    let mut cache = HighlightCache::new(Limits::default()).unwrap();
    let old = cache
        .begin(input("a", 1, "rust", "/* open"))
        .unwrap()
        .compute(&backend);
    let next = cache
        .begin(input("a", 2, "rust", "let closed = 1;\n"))
        .unwrap();
    assert_eq!(cache.publish(old).unwrap_err(), Rejection::Stale);
    assert_eq!(cache.pending(), 1);
    assert_cold(&backend, &cache.publish(next.compute(&backend)).unwrap());
    assert_eq!(cache.pending(), 0);
    assert_eq!(cache.counters().rejected, 1);
}
#[test]
fn wcf16_session_handles_and_late_results_never_alias() {
    let backend = Backend::new();
    let mut old = HighlightCache::new(Limits::default()).unwrap();
    let i = input("same-id", 1, "json", "{\"x\":1}");
    let first = resolve(&mut old, &backend, i.clone());
    let handle = first.cache.unwrap();
    let late = old.begin(i.clone()).unwrap().compute(&backend);
    old.dispose();
    let mut fresh = HighlightCache::new(Limits::default()).unwrap();
    assert!(!fresh.contains(handle));
    assert_eq!(
        fresh.begin_with_prior(i.clone(), Some(handle)).err(),
        Some(Rejection::ForeignSession)
    );
    assert_eq!(fresh.publish(late).unwrap_err(), Rejection::ForeignSession);
    let result = resolve(&mut fresh, &backend, i);
    assert_cold(&backend, &result);
    assert_ne!(result.cache, Some(handle));
    assert_eq!(fresh.counters().hits, 0);
}
#[test]
fn cancellation_is_cooperative_atomic_and_disposal_clears_ownership() {
    let backend = Backend::new();
    let mut checks = 0;
    let r = backend.highlight_cancellable("rust", "let x = 1;\n/* open\n🦀 */\n", true, || {
        checks += 1;
        checks == 5
    });
    assert_eq!(r.status, Status::Cancelled);
    assert!(r.spans.is_empty());
    assert_eq!(checks, 5);
    let mut cache = HighlightCache::new(Limits::default()).unwrap();
    let i = input("a", 1, "rust", "let x = 1;\n");
    let job = cache.begin(i.clone()).unwrap();
    job.cancel();
    assert_eq!(
        cache.publish(job.compute(&backend)).unwrap_err(),
        Rejection::Cancelled
    );
    assert_eq!(cache.pending(), 0);
    assert_eq!(cache.counters().recomputed_blocks, 0);
    let done = cache.begin(i.clone()).unwrap().compute(&backend);
    cache.cancel_block("a");
    assert_eq!(cache.publish(done).unwrap_err(), Rejection::Stale);
    resolve(&mut cache, &backend, i.clone());
    let late = cache.begin(i.clone()).unwrap();
    cache.dispose();
    assert_eq!(cache.retained_entries(), 0);
    assert_eq!(cache.retained_bytes(), 0);
    assert_eq!(cache.pending(), 0);
    assert_eq!(cache.begin(i).err(), Some(Rejection::Disposed));
    assert_eq!(
        cache.publish(late.compute(&backend)).unwrap_err(),
        Rejection::Disposed
    );
}
#[test]
fn utf16_offsets_reject_partial_scalars_and_out_of_range() {
    let s = "a🦀é\r\nשלום";
    for (byte, _) in s.char_indices().chain(std::iter::once((s.len(), '\0'))) {
        assert_eq!(
            utf16_to_utf8(s, utf8_to_utf16(s, byte).unwrap()).unwrap(),
            byte
        );
    }
    assert_eq!(utf8_to_utf16(s, 2), Err(Rejection::InvalidSpans));
    assert_eq!(utf8_to_utf16(s, s.len() + 1), Err(Rejection::InvalidSpans));
    assert_eq!(utf16_to_utf8(s, 2), Err(Rejection::InvalidSpans));
    assert_eq!(utf16_to_utf8(s, 100), Err(Rejection::InvalidSpans));
}
#[test]
fn invalid_overlapping_gapped_or_partial_spans_reject() {
    let span = |start, end| TokenSpan {
        start,
        end,
        scopes: vec!["source.rust".into()],
    };
    let valid = vec![span(0, 1), span(1, 3), span(3, 4)];
    validate_projection(
        "a🦀b",
        &Projection {
            status: Status::Highlighted,
            spans: valid.clone(),
        },
    )
    .unwrap();
    for spans in [
        vec![span(0, 2), span(2, 4)],
        vec![span(0, 3), span(1, 4)],
        vec![span(0, 1), span(3, 4)],
        vec![span(0, 5)],
        vec![span(0, 0)],
        vec![],
    ] {
        assert_eq!(
            validate_projection(
                "a🦀b",
                &Projection {
                    status: Status::Highlighted,
                    spans
                }
            ),
            Err(Rejection::InvalidSpans)
        );
    }
    assert_eq!(
        validate_projection(
            "a🦀b",
            &Projection {
                status: Status::OverBudget,
                spans: valid
            }
        ),
        Err(Rejection::InvalidSpans)
    );
}
#[test]
fn wcf16_lru_entry_token_byte_and_pending_limits_hold_during_churn() {
    let backend = Backend::new();
    let limits = Limits {
        entries: 3,
        bytes: 10_000,
        spans: 30,
        pending: 2,
    };
    let mut cache = HighlightCache::new(limits).unwrap();
    let mut handles = vec![];
    for n in 0..40 {
        let result = resolve(
            &mut cache,
            &backend,
            input(&format!("b{n}"), 1, "rust", "let x = 1;\n"),
        );
        assert_cold(&backend, &result);
        handles.push(result.cache);
        assert!(cache.retained_entries() <= limits.entries);
        assert!(cache.retained_bytes() <= limits.bytes);
        assert!(cache.retained_spans() <= limits.spans);
    }
    assert!(cache.counters().evictions > 0);
    assert!(!cache.contains(handles[0].unwrap()));
    let a = cache.begin(input("a", 1, "json", "{}")).unwrap();
    let b = cache.begin(input("b", 1, "json", "{}")).unwrap();
    assert_eq!(
        cache.begin(input("c", 1, "json", "{}")).err(),
        Some(Rejection::Busy)
    );
    let next = cache.begin(input("a", 2, "json", "[]")).unwrap();
    assert_eq!(
        cache.publish(a.compute(&backend)).unwrap_err(),
        Rejection::Stale
    );
    cache.publish(next.compute(&backend)).unwrap();
    cache.publish(b.compute(&backend)).unwrap();
    assert_eq!(cache.pending(), 0);
    println!(
        "WCF-16 bounded {:?} bytes={} spans={} entries={}",
        cache.counters(),
        cache.retained_bytes(),
        cache.retained_spans(),
        cache.retained_entries()
    );
}
#[test]
fn prior_handles_eviction_removal_and_oversize_results_are_safe() {
    let backend = Backend::new();
    let mut cache = HighlightCache::new(Limits {
        entries: 1,
        ..Limits::default()
    })
    .unwrap();
    let i = input("a", 1, "rust", "let x = 1;");
    let first = resolve(&mut cache, &backend, i.clone()).cache.unwrap();
    resolve(&mut cache, &backend, input("b", 1, "json", "{}"));
    assert!(!cache.contains(first));
    let job = cache.begin_with_prior(i, Some(first)).unwrap();
    assert_cold(&backend, &cache.publish(job.compute(&backend)).unwrap());
    cache.remove_block("a");
    assert_eq!(cache.retained_entries(), 0);
    let mut no_cache = HighlightCache::new(Limits {
        bytes: 1,
        ..Limits::default()
    })
    .unwrap();
    let output = resolve(&mut no_cache, &backend, input("x", 1, "rust", "let x = 1;"));
    assert_cold(&backend, &output);
    assert!(output.cache.is_none());
    assert_eq!(no_cache.retained_bytes(), 0);
}
#[test]
fn invalid_admission_preserves_current_job_and_fallbacks_preserve_bytes() {
    let backend = Backend::new();
    let mut cache = HighlightCache::new(Limits::default()).unwrap();
    let i = input("a", 1, "rust", "🦀\0\r\n");
    let job = cache.begin(i.clone()).unwrap();
    let mut invalid = i.clone();
    invalid.theme = "x".repeat(257);
    assert_eq!(cache.begin(invalid).err(), Some(Rejection::InvalidInput));
    let mut invalid = i.clone();
    invalid.source = "x".repeat(MAX_SOURCE_BYTES + 1);
    assert_eq!(cache.begin(invalid).err(), Some(Rejection::InvalidInput));
    assert_cold(&backend, &cache.publish(job.compute(&backend)).unwrap());
    for (language, enabled, source) in [
        ("unknown", true, "🦀\0"),
        ("rust", false, "🦀\r\n"),
        ("rust", true, &"x".repeat(17 * 1024)),
    ] {
        let mut i = input("fallback", 1, language, source);
        i.enabled = enabled;
        let r = resolve(&mut cache, &backend, i.clone());
        assert_eq!(r.input, i);
        assert_cold(&backend, &r);
        assert!(r.projection.spans.is_empty());
    }
    assert!(matches!(
        HighlightCache::new(Limits {
            pending: 0,
            ..Limits::default()
        }),
        Err(Rejection::InvalidLimits)
    ));
}
