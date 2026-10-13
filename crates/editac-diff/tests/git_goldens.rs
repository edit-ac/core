use editac_diff::{representation::*, text::*};
use serde::Deserialize;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};
#[derive(Deserialize)]
struct Goldens {
    git: String,
    args: Vec<String>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    before: String,
    after: String,
    identical: bool,
    git_exit: i32,
    git_output: String,
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "editac-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn git(t: &Temp, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(&t.0)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("LC_ALL", "C")
        .output()
        .unwrap()
}
fn qualified_git_result(out: &Output) -> bool {
    matches!(out.status.code(), Some(0 | 1)) && out.stderr.is_empty()
}
fn revision(bytes: &[u8]) -> ImmutableRevision {
    ImmutableRevision::capture(
        RevisionScope {
            document: "git-goldens".into(),
            epoch: "1".into(),
            schema: "v5".into(),
            module_profile: "task".into(),
            observed_token: [1; 65],
        },
        RevisionInput::ExactSource(bytes),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn conventional(wire: &str) -> String {
    let body = wire.split_once('\n').unwrap().1;
    body.split_terminator('\n')
        .map(|line| {
            if line.starts_with("@@ ") {
                line.replace(",1 ", " ").replace(",1 @@", " @@")
            } else {
                line.into()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
#[test]
fn pinned_git_goldens_and_git_apply_round_trip_exact_hashes() {
    let g: Goldens =
        serde_json::from_str(include_str!("../../../fixtures/diff/git-goldens.json")).unwrap();
    let t = Temp::new();
    assert_eq!(
        String::from_utf8(git(&t, &["--version"]).stdout)
            .unwrap()
            .trim(),
        g.git,
        "Qualification requires the pinned Git version"
    );
    for c in &g.cases {
        fs::write(t.0.join("before"), &c.before).unwrap();
        fs::write(t.0.join("after"), &c.after).unwrap();
        let output = git(&t, &g.args.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(output.status.code(), Some(c.git_exit), "{}", c.id);
        assert_eq!(output.stdout, c.git_output.as_bytes(), "{}", c.id);
        assert!(qualified_git_result(&output), "{}", c.id);
        assert_eq!(c.git_exit, if c.before == c.after { 0 } else { 1 });
        let l = PatchLimits::default();
        let p = TextPatch::between(
            &revision(c.before.as_bytes()),
            &revision(c.after.as_bytes()),
            l,
        )
        .unwrap();
        let wire = p.encode(l).unwrap();
        let decoded = TextPatch::decode(wire.as_bytes(), l).unwrap();
        let result = decoded.apply(c.before.as_bytes(), l).unwrap();
        assert_eq!(result, c.after.as_bytes(), "{}", c.id);
        assert_eq!(ContentHash::of(&result).hex(), p.metadata.after_hash);
        assert_eq!(
            ContentHash::of(c.before.as_bytes()).hex(),
            p.metadata.before_hash
        );
        if c.before == c.after {
            assert!(p.hunks.is_empty());
            continue;
        }
        let body = conventional(&wire);
        if c.identical {
            let expected = c
                .git_output
                .split_once("--- a/before\n+++ b/after\n")
                .unwrap()
                .1;
            assert_eq!(
                body.split_once("--- before\n+++ after\n").unwrap().1,
                expected,
                "{}",
                c.id
            );
        }
        // Independent Git application: both names target the same existing fixture file.
        fs::write(t.0.join("document.txt"), &c.before).unwrap();
        fs::write(
            t.0.join("change.patch"),
            body.replace(
                "--- before\n+++ after\n",
                "--- document.txt\n+++ document.txt\n",
            ),
        )
        .unwrap();
        let applied = git(
            &t,
            &[
                "-c",
                "core.autocrlf=false",
                "apply",
                "--whitespace=nowarn",
                "-p0",
                "change.patch",
            ],
        );
        assert_eq!(
            applied.status.code(),
            Some(0),
            "{}: {}",
            c.id,
            String::from_utf8_lossy(&applied.stderr)
        );
        assert_eq!(
            fs::read(t.0.join("document.txt")).unwrap(),
            c.after.as_bytes(),
            "{}",
            c.id
        );
    }
}
#[test]
fn git_error_is_not_a_difference_or_a_pass() {
    let t = Temp::new();
    let out = git(&t, &["diff", "--no-index", "--", "missing-a", "missing-b"]);
    // Git 2.53 can also return 1 for a missing path: diagnostics disqualify it.
    assert!(!out.stderr.is_empty());
    assert!(!qualified_git_result(&out));
    let invalid = git(&t, &["diff", "--no-index", "--invalid-option", "a", "b"]);
    assert!(!matches!(invalid.status.code(), Some(0 | 1)));
    assert!(!qualified_git_result(&invalid));
}
#[test]
fn measured_large_replacement_and_limit_rejection() {
    let a = (0..1500)
        .map(|i| format!("before {i:04} 🙂\r\n"))
        .collect::<String>();
    let b = (0..1500)
        .map(|i| format!("after {i:04} é\n"))
        .collect::<String>();
    let l = PatchLimits::default();
    let start = Instant::now();
    let p = TextPatch::between(&revision(a.as_bytes()), &revision(b.as_bytes()), l).unwrap();
    let wire = p.encode(l).unwrap();
    let restored = p.apply(a.as_bytes(), l).unwrap();
    assert_eq!(restored, b.as_bytes());
    let elapsed = start.elapsed().as_micros();
    let a2 = a.repeat(2);
    let b2 = b.repeat(2);
    let start = Instant::now();
    assert_eq!(
        TextPatch::between(&revision(a2.as_bytes()), &revision(b2.as_bytes()), l),
        Err(PatchError::ResourceLimit)
    );
    let measurement = serde_json::json!({"fixture":"large-replacement-1500-v1","beforeBytes":a.len(),"afterBytes":b.len(),"wireBytes":wire.len(),"elapsedMicros":elapsed,"overBudgetBeforeBytes":a2.len(),"overBudgetAfterBytes":b2.len(),"rejectionMicros":start.elapsed().as_micros(),"comparisonCellLimit":l.max_comparison_cells,"wireByteLimit":l.max_wire_bytes,"beforeHash":p.metadata.before_hash,"afterHash":p.metadata.after_hash,"profile":"prepared host desktop; no release latency threshold claimed"});
    if let Ok(path) = std::env::var("EDITAC_DIFF_LARGE_OUTPUT") {
        fs::write(path, serde_json::to_vec_pretty(&measurement).unwrap()).unwrap();
    }
}

#[test]
fn measured_five_mib_source_replacement_and_source_byte_ceiling() {
    let l = PatchLimits::default();
    let a = "a".repeat(l.max_source_bytes);
    let b = "b".repeat(l.max_output_bytes);
    let start = Instant::now();
    let patch = TextPatch::between(&revision(a.as_bytes()), &revision(b.as_bytes()), l).unwrap();
    let wire = patch.encode(l).unwrap();
    assert_eq!(patch.apply(a.as_bytes(), l).unwrap(), b.as_bytes());
    let elapsed = start.elapsed().as_micros();
    let over = a.clone() + "x";
    let start = Instant::now();
    assert_eq!(
        TextPatch::between(&revision(over.as_bytes()), &revision(b.as_bytes()), l),
        Err(PatchError::ResourceLimit)
    );
    let measurement = serde_json::json!({"fixture":"five-mib-single-line-replacement-v1","beforeBytes":a.len(),"afterBytes":b.len(),"wireBytes":wire.len(),"elapsedMicros":elapsed,"overBudgetBeforeBytes":over.len(),"rejectionMicros":start.elapsed().as_micros(),"sourceByteLimit":l.max_source_bytes,"outputByteLimit":l.max_output_bytes,"comparisonCellLimit":l.max_comparison_cells,"beforeHash":patch.metadata.before_hash,"afterHash":patch.metadata.after_hash,"profile":"single prepared desktop sample; no mixed-block/device/release performance claim"});
    if let Ok(path) = std::env::var("EDITAC_DIFF_FIVE_MIB_OUTPUT") {
        fs::write(path, serde_json::to_vec_pretty(&measurement).unwrap()).unwrap();
    }
}
