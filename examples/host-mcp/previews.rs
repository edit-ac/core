//! Shared fixture presentation; shared Session retains every executable plan.
use editac_diff::{
    portable::{ChangeInput, ChangeModel},
    representation::{ImmutableRevision, RepresentationLimits, RevisionInput, RevisionScope},
    semantic::{self, SemanticLimits},
    text::{PatchLimits, TextPatch},
};
use editac_session::edit_service::{EditService, PreparedEdit, SourceTarget};
use serde_json::Value;
pub fn previews<S: editac_session::session::SessionStore>(
    service: &EditService<S>,
    target: &SourceTarget,
    candidate: &str,
    plan: &PreparedEdit,
) -> Result<(Value, Value, Vec<String>), String> {
    let identity = service.session().document().identity();
    let scope = RevisionScope {
        document: identity.document_id.clone(),
        epoch: identity.epoch.clone(),
        schema: identity.schema.clone(),
        module_profile: "markdown-v1/images-disabled".into(),
        observed_token: plan.expected_revision().to_bytes(),
    };
    let limits = RepresentationLimits {
        max_bytes: 262144,
        max_nodes: 1024,
        max_depth: 64,
    };
    let before = ImmutableRevision::capture(
        scope.clone(),
        RevisionInput::ExactSource(target.source().as_bytes()),
        limits,
    )
    .map_err(|e| format!("{e:?}"))?;
    let after = ImmutableRevision::capture(
        scope.clone(),
        RevisionInput::ExactSource(candidate.as_bytes()),
        limits,
    )
    .map_err(|e| format!("{e:?}"))?;
    let patch = TextPatch::between(&before, &after, PatchLimits::default())
        .map_err(|e| format!("{e:?}"))?;
    let wire = patch
        .encode(PatchLimits::default())
        .map_err(|e| format!("{e:?}"))?;
    let source =
        ChangeModel::new(ChangeInput::ExactSource { wire }).map_err(|e| format!("{e:?}"))?;
    let before =
        semantic::capture_projection(scope.clone(), &service.read(0).unwrap().snapshot, limits)
            .map_err(|e| format!("{e:?}"))?;
    let after = semantic::capture_projection(scope, plan.preview(), limits)
        .map_err(|e| format!("{e:?}"))?;
    let model = semantic::compare(
        &before,
        &after,
        SemanticLimits {
            input: limits,
            max_changes: 1024,
            max_output_bytes: 524288,
        },
    )
    .map_err(|e| format!("{e:?}"))?;
    let ids = model
        .changes
        .iter()
        .map(|change| change.id.clone())
        .collect();
    let semantic =
        ChangeModel::new(ChangeInput::Semantic { model }).map_err(|e| format!("{e:?}"))?;
    Ok((
        serde_json::to_value(source).unwrap(),
        serde_json::to_value(semantic).unwrap(),
        ids,
    ))
}
