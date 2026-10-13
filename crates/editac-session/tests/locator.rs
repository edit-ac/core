mod support;
use editac_core::document::{Document, DocumentIdentity};
use editac_session::locator::*;
use std::path::PathBuf;

const ID: &str = "12345678-1234-4234-8234-123456789abc";
const OTHER: &str = "34567890-3456-4456-8456-34567890abcd";
const EPOCH: &str = "23456789-2345-4345-8345-23456789abcd";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(ID, EPOCH).unwrap()
}
fn entry(source: SourceBinding) -> CatalogEntry {
    CatalogEntry {
        identity: identity(),
        source,
        access: AccessState::Allowed,
    }
}
fn catalog() -> Catalog {
    let mut catalog = Catalog::default();
    catalog.configure_authority("team-1").unwrap();
    catalog
        .configure_app_host("app.example.test", "team-1")
        .unwrap();
    catalog
}
fn qualified() -> Locator {
    Locator::parse(&format!("ac://team-1/{ID}")).unwrap()
}

#[test]
fn canonical_forms_round_trip_without_changing_identity() {
    for value in [format!("ac://{ID}"), format!("ac://team-1/{ID}")] {
        let locator = Locator::parse(&value).unwrap();
        assert_eq!(locator.document_id().as_str(), ID);
        assert_eq!(locator.to_string(), value);
        assert_eq!(Locator::parse(&locator.to_string()).unwrap(), locator);
    }
    assert!(
        Locator::parse(&format!("ac://{ID}"))
            .unwrap()
            .authority()
            .is_none()
    );
    assert_eq!(qualified().authority().unwrap().as_str(), "team-1");
}

#[test]
fn ambiguous_encoding_traversal_unicode_and_credentials_reject() {
    let rejected = [
        "",
        "ac://",
        "ac:///",
        "AC://team-1/id",
        "file:///tmp/document.md",
        "/tmp/document.md",
        "../document.md",
        "ac://short-hash",
        "ac://é",
        "ac://e\u{301}",
        "ac://team-1/..",
        "ac://team-1/.",
        "ac://team-1/%2e%2e",
        "ac://team-1/%252e%252e",
        "ac://team-1/%2f",
        "ac://team-1/%5c",
        "ac://team-1/%00",
        "ac://team-1/%zz",
        "ac://team-1/id/extra",
        "ac://team-1//id",
        "ac://user:secret@team-1/id",
        "ac://token@team-1/id",
        "ac://team-1:443/id",
        "ac://team-1\\id",
        "ac://team-1/id?token=x",
        "ac://team-1/id#key=x",
        "ac:// team-1/id",
        "ac://team-1/id\n",
        "ac://team-1/id\0",
        "ac://TEAM-1/id",
        "ac://team_1/id",
        "ac://-team/id",
        "ac://team-/id",
        "ac://1team/id",
    ];
    for value in rejected {
        assert!(Locator::parse(value).is_err(), "accepted {value:?}");
    }
    for value in [
        format!("ac://{}", ID.to_uppercase()),
        format!("ac://team-1/{ID}/"),
        format!("ac://team-1/{ID}?version=1"),
        format!("ac://team-1/{ID}?token=secret"),
        format!("ac://team-1/{ID}#key=secret"),
        format!(" ac://{ID}"),
        format!("ac://{ID} "),
        format!("ac://team-1/%31{}", &ID[1..]),
    ] {
        assert!(Locator::parse(&value).is_err(), "accepted {value:?}");
    }
}

#[test]
fn authority_configuration_is_bounded_and_exact() {
    let mut catalog = catalog();
    for value in [
        "",
        "Team",
        "team.",
        "team/other",
        "token@team",
        "https://team",
        "é",
    ] {
        assert!(catalog.configure_authority(value).is_err());
    }
    assert!(catalog.configure_authority(&"a".repeat(63)).is_ok());
    assert!(catalog.configure_authority(&"a".repeat(64)).is_err());
    assert_eq!(
        catalog.parse(&format!("ac://unknown/{ID}")),
        Err(LocatorError::UnknownAuthority)
    );
    let unknown = Locator::parse(&format!("ac://unknown/{ID}")).unwrap();
    assert_eq!(
        catalog.insert(unknown.clone(), entry(SourceBinding::Cached)),
        Err(LocatorError::UnknownAuthority)
    );
    assert_eq!(
        catalog.resolve(&unknown, Connectivity::Offline),
        Err(LocatorError::UnknownAuthority)
    );
    assert!(catalog.is_empty());
}

#[test]
fn configured_https_links_share_the_exact_catalog_lookup() {
    let mut catalog = catalog();
    let locator = qualified();
    catalog
        .insert(
            locator.clone(),
            entry(SourceBinding::Hosted { cached: true }),
        )
        .unwrap();
    let link = catalog
        .parse(&format!("https://app.example.test/ac/{ID}"))
        .unwrap();
    assert_eq!(link, locator);
    assert_eq!(
        catalog.resolve(&link, Connectivity::Offline).unwrap(),
        catalog.resolve(&locator, Connectivity::Offline).unwrap()
    );
    for value in [
        format!("https://evil.test/ac/{ID}"),
        format!("http://app.example.test/ac/{ID}"),
        format!("https://app.example.test.evil/ac/{ID}"),
        format!("https://APP.example.test/ac/{ID}"),
        format!("https://secret@app.example.test/ac/{ID}"),
        format!("https://app.example.test:443/ac/{ID}"),
        format!("https://app.example.test/ac/{ID}?token=secret"),
        format!("https://app.example.test/ac/{ID}#key=secret"),
        format!("https://app.example.test/ac/{ID}/"),
        format!("https://app.example.test/other/{ID}"),
        format!("https://app.example.test/../ac/{ID}"),
        format!("https://app.example.test/ac/%31{}", &ID[1..]),
    ] {
        assert!(catalog.parse(&value).is_err(), "accepted {value}");
    }
}

#[test]
fn app_host_configuration_cannot_smuggle_urls_or_credentials() {
    let mut catalog = catalog();
    for host in [
        "",
        ".test",
        "test.",
        "-test",
        "test-",
        "test..test",
        "TEST",
        "é.test",
        "user@test",
        "test:443",
        "https://test",
        "test/path",
        "test?token=x",
    ] {
        assert_eq!(
            catalog.configure_app_host(host, "team-1"),
            Err(LocatorError::InvalidAppHost)
        );
    }
    assert_eq!(
        catalog.configure_app_host("other.test", "unknown"),
        Err(LocatorError::UnknownAuthority)
    );
    assert_eq!(
        catalog.configure_app_host("app.example.test", "team-1"),
        Err(LocatorError::DuplicateMapping)
    );
    assert_eq!(
        catalog.configure_app_host(&format!("{}.test", "a".repeat(64)), "team-1"),
        Err(LocatorError::InvalidAppHost)
    );
    assert_eq!(
        catalog.configure_app_host(&vec!["a".repeat(63); 4].join("."), "team-1"),
        Err(LocatorError::InvalidAppHost)
    );
}

#[test]
fn offline_cached_populated_and_initialized_empty_checkpoints_preserve_identity() {
    for populated in [false, true] {
        let mut document = support::document();
        if populated {
            support::insert(&mut document, 0, "offline 😀 content");
        }
        let checkpoint = document.checkpoint();
        let before = checkpoint.bytes.clone();
        let mut catalog = catalog();
        let locator = qualified();
        catalog
            .insert(
                locator.clone(),
                CatalogEntry {
                    identity: checkpoint.identity.clone(),
                    source: SourceBinding::Hosted { cached: true },
                    access: AccessState::Allowed,
                },
            )
            .unwrap();
        let result = catalog.resolve(&locator, Connectivity::Offline).unwrap();
        assert_eq!(result.state, ResolutionState::Cached);
        let restored =
            Document::restore(&result.entry.unwrap().identity, &checkpoint, &[]).unwrap();
        assert!(restored.is_initialized());
        assert_eq!(restored.identity(), document.identity());
        assert_eq!(
            support::text(&restored),
            if populated {
                "offline 😀 content"
            } else {
                ""
            }
        );
        assert_eq!(checkpoint.bytes, before);
        assert_eq!(catalog.len(), 1);
    }
}

#[test]
fn offline_misses_and_uncached_hosted_do_not_create_or_fetch() {
    let mut catalog = catalog();
    let locator = qualified();
    assert_eq!(
        catalog.resolve(&locator, Connectivity::Offline).unwrap(),
        Resolution {
            state: ResolutionState::Unavailable,
            entry: None
        }
    );
    assert!(catalog.is_empty());
    catalog
        .insert(
            locator.clone(),
            entry(SourceBinding::Hosted { cached: false }),
        )
        .unwrap();
    let before = catalog
        .resolve(&locator, Connectivity::Offline)
        .unwrap()
        .entry
        .unwrap()
        .clone();
    for _ in 0..3 {
        assert_eq!(
            catalog
                .resolve(&locator, Connectivity::Offline)
                .unwrap()
                .state,
            ResolutionState::Unavailable
        );
        // Online only returns metadata; it still cannot perform network/engine creation.
        assert_eq!(
            catalog
                .resolve(&locator, Connectivity::Online)
                .unwrap()
                .state,
            ResolutionState::Hosted
        );
    }
    assert_eq!(catalog.len(), 1);
    assert_eq!(
        catalog
            .resolve(&locator, Connectivity::Offline)
            .unwrap()
            .entry
            .unwrap(),
        &before
    );
    let missing = catalog.parse(&format!("ac://team-1/{OTHER}")).unwrap();
    assert_eq!(
        catalog
            .resolve(&missing, Connectivity::Online)
            .unwrap()
            .entry,
        None
    );
    assert_eq!(catalog.len(), 1);
}

#[test]
fn aliases_link_only_an_explicit_matching_full_identity() {
    let mut catalog = catalog();
    let unqualified = Locator::parse(&format!("ac://{ID}")).unwrap();
    catalog
        .insert(unqualified.clone(), entry(SourceBinding::Cached))
        .unwrap();
    catalog
        .insert(qualified(), entry(SourceBinding::Hosted { cached: true }))
        .unwrap();
    for locator in [&unqualified, &qualified()] {
        assert_eq!(
            catalog
                .resolve(locator, Connectivity::Offline)
                .unwrap()
                .entry
                .unwrap()
                .identity,
            identity()
        );
    }
    assert_eq!(
        catalog.insert(unqualified.clone(), entry(SourceBinding::Cached)),
        Err(LocatorError::DuplicateMapping)
    );
    catalog.configure_authority("other").unwrap();
    let alias = catalog.parse(&format!("ac://other/{ID}")).unwrap();
    let mut wrong_epoch = entry(SourceBinding::Cached);
    wrong_epoch.identity.epoch = OTHER.into();
    assert_eq!(
        catalog.insert(alias.clone(), wrong_epoch),
        Err(LocatorError::ConflictingIdentity)
    );
    let mut wrong_profile = entry(SourceBinding::Cached);
    wrong_profile.identity = DocumentIdentity::v4(ID, EPOCH).unwrap();
    assert_eq!(
        catalog.insert(alias, wrong_profile),
        Err(LocatorError::ConflictingIdentity)
    );
    assert_eq!(catalog.len(), 2);
}

#[test]
fn identities_reject_mismatched_ids_and_invalid_metadata_without_admission() {
    let mut catalog = catalog();
    let locator = qualified();
    let mut other = entry(SourceBinding::Cached);
    other.identity.document_id = OTHER.into();
    assert_eq!(
        catalog.insert(locator.clone(), other),
        Err(LocatorError::ConflictingIdentity)
    );
    for field in 0..7 {
        let mut bad = entry(SourceBinding::Cached);
        match field {
            0 => bad.identity.document_id = "short".into(),
            1 => bad.identity.epoch = EPOCH.to_uppercase(),
            2 => bad.identity.schema = "unknown".into(),
            3 => bad.identity.profile = "unknown".into(),
            4 => bad.identity.protocol_version = 99,
            5 => bad.identity.update_encoding = 99,
            _ => bad.identity.offsets = "utf8".into(),
        }
        assert_eq!(
            catalog.insert(locator.clone(), bad),
            Err(LocatorError::InvalidIdentity)
        );
    }
    assert!(catalog.is_empty());
}

#[test]
fn all_existing_engine_profiles_are_preserved_without_implicit_upgrade() {
    let identities = [
        DocumentIdentity::v1(ID, EPOCH),
        DocumentIdentity::v2(ID, EPOCH),
        DocumentIdentity::v3(ID, EPOCH),
        DocumentIdentity::v4(ID, EPOCH),
        DocumentIdentity::v5(ID, EPOCH),
    ];
    for identity in identities {
        let identity = identity.unwrap();
        let mut catalog = catalog();
        catalog
            .insert(
                qualified(),
                CatalogEntry {
                    identity: identity.clone(),
                    source: SourceBinding::Cached,
                    access: AccessState::Allowed,
                },
            )
            .unwrap();
        assert_eq!(
            catalog
                .resolve(&qualified(), Connectivity::Offline)
                .unwrap()
                .entry
                .unwrap()
                .identity,
            identity
        );
    }
}

#[test]
fn local_paths_are_host_bindings_separate_from_uri_text() {
    let mut catalog = catalog();
    let locator = Locator::parse(&format!("ac://{ID}")).unwrap();
    assert_eq!(
        catalog.insert(
            locator.clone(),
            entry(SourceBinding::LocalPath(PathBuf::from("relative.md")))
        ),
        Err(LocatorError::InvalidLocalPath)
    );
    assert_eq!(
        catalog.insert(
            locator.clone(),
            entry(SourceBinding::Hosted { cached: false })
        ),
        Err(LocatorError::UnknownAuthority)
    );
    let host_path = PathBuf::from("/host-granted/notes with spaces/😀.md");
    catalog
        .insert(
            locator.clone(),
            entry(SourceBinding::LocalPath(host_path.clone())),
        )
        .unwrap();
    let result = catalog.resolve(&locator, Connectivity::Offline).unwrap();
    assert_eq!(result.state, ResolutionState::Local);
    assert_eq!(
        result.entry.unwrap().source,
        SourceBinding::LocalPath(host_path)
    );
    assert_eq!(result.entry.unwrap().identity, identity());
    assert!(catalog.parse("ac:///host-granted/notes.md").is_err());
}

#[test]
fn policy_states_precede_cached_and_network_readiness() {
    for (access, expected) in [
        (AccessState::Locked, ResolutionState::Locked),
        (AccessState::Unauthorized, ResolutionState::Unauthorized),
        (AccessState::Incompatible, ResolutionState::Incompatible),
    ] {
        for cached in [true, false] {
            let mut catalog = catalog();
            let mut record = entry(SourceBinding::Hosted { cached });
            record.access = access;
            catalog.insert(qualified(), record).unwrap();
            for connectivity in [Connectivity::Offline, Connectivity::Online] {
                let result = catalog.resolve(&qualified(), connectivity).unwrap();
                assert_eq!(result.state, expected);
                assert_eq!(result.entry.unwrap().identity, identity());
            }
        }
    }
}

#[test]
fn invalid_input_diagnostics_never_echo_credentials() {
    let error = catalog()
        .parse(&format!("https://secret-token@app.example.test/ac/{ID}"))
        .unwrap_err();
    assert!(!error.to_string().contains("secret-token"));
}
