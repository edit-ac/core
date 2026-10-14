//! EXT-1.8 bridge facts from the owning shared catalog, no transport or IO port.
use editac_core::document::DocumentIdentity;
use editac_session::locator::*;
#[test]
fn reference_catalog_allowlist_and_policy_facts() {
    let id = "12345678-1234-4234-8234-123456789abc";
    let mut catalog = Catalog::default();
    catalog.configure_authority("team-1").unwrap();
    catalog
        .configure_app_host("app.example.test", "team-1")
        .unwrap();
    let identity = DocumentIdentity::v5(id, "23456789-2345-4345-8345-23456789abcd").unwrap();
    let target = format!("ac://team-1/{id}");
    let locator = catalog.parse(&target).unwrap();
    catalog
        .insert(
            locator.clone(),
            CatalogEntry {
                identity,
                source: SourceBinding::Cached,
                access: AccessState::Allowed,
            },
        )
        .unwrap();
    assert_eq!(
        catalog
            .resolve(&locator, Connectivity::Offline)
            .unwrap()
            .state,
        ResolutionState::Cached
    );
    assert_eq!(
        catalog
            .parse(&format!("https://app.example.test/ac/{id}"))
            .unwrap(),
        locator
    );
    let rejected = [
        format!("ac://evil/{id}"),
        format!("ac://user:SECRET@team-1/{id}"),
        format!("ac://team-1/{id}?token=SECRET"),
        "file:///tmp/private.md".into(),
        format!("https://evil.test/ac/{id}"),
    ];
    for input in &rejected {
        assert!(catalog.parse(input).is_err());
    }
    let output = std::path::PathBuf::from(
        std::env::var("EDITAC_EXTENSION_REFERENCES_OUTPUT").expect("isolated output required"),
    );
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("catalog.json"),format!(r#"{{"targetId":{target:?},"status":"cached","rejected":{rejected:?},"mappingCount":{}}}"#,catalog.len())).unwrap();
}
