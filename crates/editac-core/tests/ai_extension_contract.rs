//! Prepared protocol/admission only. No provider, SDK or network dependency.
use editac_core::{
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    extensions::ai::*,
    history::HistoryConfig,
};
use serde_json::Value;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/extensions/ai/contract-v1.json"
    ))
    .unwrap()
}
fn cell(id: &str) {
    let corpus = corpus();
    let (index, c) = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .find(|(_, c)| c["id"] == id)
        .unwrap();
    let identity = DocumentIdentity::v5(
        &format!("{:08x}-1111-4111-8111-111111111111", index + 1),
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap();
    let mut document = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "Unchanged שלום 🧪".into(),
        }],
    )
    .unwrap();
    document.enable_history(HistoryConfig::default()).unwrap();
    let before = document.checkpoint().bytes;
    let history = document.history_state();
    let revision = document.revision();
    let descriptor: Option<Descriptor> = serde_json::from_value(c["descriptor"].clone()).unwrap();
    let request: Request = serde_json::from_value(c["request"].clone()).unwrap();
    let policy = Policy {
        allow_remote: c["policy"]["allowRemote"].as_bool().unwrap(),
        protected_document: c["policy"]["protectedDocument"].as_bool().unwrap(),
    };
    let mut admission = Admission::default();
    for _ in 0..c["prior"].as_u64().unwrap() {
        admission
            .admit(descriptor.as_ref(), true, &request, policy, false)
            .unwrap();
    }
    struct Prepared {
        calls: usize,
    }
    impl Transport for Prepared {
        fn send(
            &mut self,
            request: &Request,
            _: &Limits,
            cancellation: &Cancellation,
            emit: &mut dyn FnMut(Response) -> Result<(), Error>,
        ) -> Result<(), Error> {
            assert!(!cancellation.is_canceled());
            self.calls += 1;
            emit(Response::Finish {
                version: AI_VERSION,
                request_id: request.request_id.clone(),
                sequence: 0,
                usage: None,
            })
        }
    }
    let mut prepared = Prepared { calls: 0 };
    let cancellation = Cancellation::default();
    if c["canceled"].as_bool().unwrap() {
        cancellation.cancel();
    }
    let transport: Option<&mut dyn Transport> = if c["transport"].as_bool().unwrap() {
        Some(&mut prepared)
    } else {
        None
    };
    let mut responses = Vec::new();
    let result = admission.dispatch(
        descriptor.as_ref(),
        transport,
        &request,
        policy,
        &cancellation,
        &mut |e| {
            responses.push(e);
            Ok(())
        },
    );
    let actual = match result {
        Ok(()) => "ok".into(),
        Err(e) => serde_json::to_value(e)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned(),
    };
    assert_eq!(actual, c["expected"].as_str().unwrap(), "{id}");
    assert_eq!(prepared.calls, usize::from(c["expected"] == "ok"));
    assert_eq!(responses.len(), prepared.calls);
    assert_eq!(document.checkpoint().bytes, before, "{id}: persistence");
    assert_eq!(document.history_state(), history, "{id}: history");
    assert_eq!(document.revision(), revision, "{id}: revision");
}

#[test]
fn valid_ask() {
    cell("valid-ask");
}

#[test]
fn valid_fill() {
    cell("valid-fill");
}

#[test]
fn valid_continue() {
    cell("valid-continue");
}

#[test]
fn valid_rewrite() {
    cell("valid-rewrite");
}

#[test]
fn valid_completion() {
    cell("valid-completion");
}

#[test]
fn absent() {
    cell("absent");
}

#[test]
fn disabled() {
    cell("disabled");
}

#[test]
fn invalid_descriptor_version() {
    cell("invalid-descriptor-version");
}

#[test]
fn invalid_request_version() {
    cell("invalid-request-version");
}

#[test]
fn missing_transport() {
    cell("missing-transport");
}

#[test]
fn missing_limits() {
    cell("missing-limits");
}

#[test]
fn zero_requests() {
    cell("zero-requests");
}

#[test]
fn zero_instructionbytes() {
    cell("zero-instructionBytes");
}

#[test]
fn zero_contextbytes() {
    cell("zero-contextBytes");
}

#[test]
fn zero_outputbytes() {
    cell("zero-outputBytes");
}

#[test]
fn zero_timeoutms() {
    cell("zero-timeoutMs");
}

#[test]
fn quota_exhausted() {
    cell("quota-exhausted");
}

#[test]
fn protected() {
    cell("protected");
}

#[test]
fn unauthorized() {
    cell("unauthorized");
}

#[test]
fn unsupported_format() {
    cell("unsupported-format");
}

#[test]
fn oversized_context() {
    cell("oversized-context");
}

#[test]
fn oversized_instruction() {
    cell("oversized-instruction");
}

#[test]
fn oversized_output() {
    cell("oversized-output");
}

#[test]
fn missing_id() {
    cell("missing-id");
}

#[test]
fn canceled() {
    cell("canceled");
}

#[test]
fn unregistered_operation() {
    cell("unregistered-operation");
}

#[test]
fn response_roundtrip_and_unknown_executable_payload_rejection() {
    let r = Response::Finish {
        version: AI_VERSION,
        request_id: "prepared-1".into(),
        sequence: 1,
        usage: Some(Usage {
            input_tokens: Some(12),
            output_tokens: None,
        }),
    };
    let value = serde_json::to_value(&r).unwrap();
    assert_eq!(value["usage"]["inputTokens"], 12);
    assert!(value["usage"]["outputTokens"].is_null());
    assert!(serde_json::from_value::<Response>(value).is_ok());
    assert!(serde_json::from_value::<Response>(serde_json::json!({"type":"tool-call","version":1,"requestId":"prepared-1","sequence":0,"script":"execute"})).is_err());
    let mut request = corpus()["cases"][0]["request"].clone();
    request["credentials"] = "forbidden".into();
    assert!(serde_json::from_value::<Request>(request).is_err());
}

#[test]
fn canceled_host_work_is_not_refunded_or_retried() {
    struct Prepared {
        calls: usize,
    }
    impl Transport for Prepared {
        fn send(
            &mut self,
            _: &Request,
            _: &Limits,
            cancellation: &Cancellation,
            _: &mut dyn FnMut(Response) -> Result<(), Error>,
        ) -> Result<(), Error> {
            self.calls += 1;
            cancellation.cancel();
            Err(Error::Canceled)
        }
    }
    let c = corpus();
    let descriptor: Descriptor =
        serde_json::from_value(c["cases"][0]["descriptor"].clone()).unwrap();
    let request: Request = serde_json::from_value(c["cases"][0]["request"].clone()).unwrap();
    let mut admission = Admission::default();
    let mut transport = Prepared { calls: 0 };
    let cancellation = Cancellation::default();
    assert_eq!(
        admission.dispatch(
            Some(&descriptor),
            Some(&mut transport),
            &request,
            Policy {
                allow_remote: true,
                protected_document: false
            },
            &cancellation,
            &mut |_| Ok(())
        ),
        Err(Error::Canceled)
    );
    assert_eq!(transport.calls, 1);
    assert_eq!(admission.used(), 1);
    assert!(cancellation.is_canceled());
}

fn invalid_stream(kind: &str) {
    struct Prepared<'a>(&'a str);
    impl Transport for Prepared<'_> {
        fn send(
            &mut self,
            request: &Request,
            _: &Limits,
            _: &Cancellation,
            emit: &mut dyn FnMut(Response) -> Result<(), Error>,
        ) -> Result<(), Error> {
            if self.0 == "missing-terminal" {
                return Ok(());
            }
            // Deliberately ignore callback failures: the boundary still rejects.
            for index in 0..2 {
                let _ = emit(Response::Delta {
                    version: if self.0 == "version" { 2 } else { 1 },
                    request_id: if self.0 == "identity" {
                        "late".into()
                    } else {
                        request.request_id.clone()
                    },
                    sequence: if self.0 == "duplicate" { 0 } else { index },
                    text: "a".repeat(60),
                });
            }
            Ok(())
        }
    }
    let c = corpus();
    let descriptor: Descriptor =
        serde_json::from_value(c["cases"][0]["descriptor"].clone()).unwrap();
    let request: Request = serde_json::from_value(c["cases"][0]["request"].clone()).unwrap();
    let mut admission = Admission::default();
    let cancellation = Cancellation::default();
    assert_eq!(
        admission.dispatch(
            Some(&descriptor),
            Some(&mut Prepared(kind)),
            &request,
            Policy {
                allow_remote: true,
                protected_document: false
            },
            &cancellation,
            &mut |_| Ok(())
        ),
        Err(Error::InvalidResponse)
    );
    assert!(cancellation.is_canceled());
    assert_eq!(admission.used(), 1);
}
#[test]
fn cumulative_response_bound() {
    invalid_stream("oversized");
}
#[test]
fn response_identity_binding() {
    invalid_stream("identity");
}
#[test]
fn response_version_binding() {
    invalid_stream("version");
}
#[test]
fn duplicate_response_sequence() {
    invalid_stream("duplicate");
}
#[test]
fn missing_terminal_response() {
    invalid_stream("missing-terminal");
}
