#[cfg(test)]
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod mapping;

#[cfg(test)]
mod tests {
    use super::mapping;
    use editac_core::{
        Utf16Offset,
        anchors::Bias,
        commands::text::{TextCommand, TextOrigin},
        document::{Document, DocumentIdentity, InitializedCheckpoint},
        history::HistoryConfig,
    };
    use editac_highlighting::{
        BACKEND_ID, Backend,
        cache::{BlockInput, HighlightCache, Limits},
    };

    fn text(d: &Document, block: &str) -> String {
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|b| b.id == block)
            .unwrap()
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect()
    }
    fn appearance(d: &Document, cache: &mut HighlightCache, backend: &Backend, revision: u64) {
        let checkpoint = d.checkpoint().bytes;
        let before = d.history_state();
        let content = text(d, "n:11:1");
        let input = BlockInput {
            block: "n:11:1".into(),
            revision,
            language: "rust".into(),
            grammar: BACKEND_ID.into(),
            query: "scope-v1".into(),
            theme: "light-v1".into(),
            enabled: true,
            source: content.clone(),
        };
        let job = cache.begin(input).unwrap();
        let result = cache.publish(job.compute(backend)).unwrap();
        let cold = backend.highlight("rust", &content, true);
        assert_eq!(result.projection.spans, cold.spans);
        assert_eq!(result.projection.status, cold.status);
        assert_eq!(
            d.checkpoint().bytes,
            checkpoint,
            "zero CRDT/checkpoint effects"
        );
        assert_eq!(d.history_state().undo_groups, before.undo_groups);
        assert_eq!(d.history_state().redo_groups, before.redo_groups);
        assert_eq!(text(d, "n:11:1"), content);
    }
    #[test]
    fn actual_engine_edit_undo_redo_has_no_highlighting_crdt_or_history_effects() {
        let identity = DocumentIdentity::v5(
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
        )
        .unwrap();
        let mut d = Document::restore(
            &identity,
            &InitializedCheckpoint {
                identity: identity.clone(),
                initialized: true,
                writer_id: 11,
                bytes: mapping::bytes(&mapping::seed()),
            },
            &[],
        )
        .unwrap();
        d.enable_history(HistoryConfig::default()).unwrap();
        let backend = Backend::new();
        let mut cache = HighlightCache::new(Limits::default()).unwrap();
        appearance(&d, &mut cache, &backend, 1);
        appearance(&d, &mut cache, &backend, 1);
        let original = text(&d, "n:11:1");
        let at = d.anchor("n:11:1", Utf16Offset(0), Bias::Right).unwrap();
        let prepared = d
            .prepare_text(
                &TextCommand::Insert {
                    at,
                    text: "/* 🦀\n*/\n".into(),
                },
                &TextOrigin::new("highlight:fixture").unwrap(),
            )
            .unwrap();
        d.commit_text(prepared).unwrap();
        let edited = text(&d, "n:11:1");
        assert_ne!(edited, original);
        appearance(&d, &mut cache, &backend, 2);
        d.undo().unwrap().unwrap();
        assert_eq!(text(&d, "n:11:1"), original);
        appearance(&d, &mut cache, &backend, 3);
        d.redo().unwrap().unwrap();
        assert_eq!(text(&d, "n:11:1"), edited);
        appearance(&d, &mut cache, &backend, 4);
        println!(
            "WCF-16 actual engine: 5 projection checks, zero checkpoint/history changes; {:?}",
            cache.counters()
        );
    }
}
