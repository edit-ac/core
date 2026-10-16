//! Optional syntax appearance over immutable source. No engine/document dependency.
//! Only the three pinned languages are admitted. All failures return untouched source.
use serde::Serialize;
use syntect::{
    easy::ScopeRegionIterator,
    parsing::{ParseState, ScopeStack, SyntaxSet},
    util::LinesWithEndings,
};

pub const BACKEND_ID: &str = "syntect-5.3.0/fancy/two-face-0.5.2+bat-0.26.1/newlines";
pub const MAX_SOURCE_BYTES: usize = 100 * 1024;
pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const MAX_LINES: usize = 4096;
pub const MAX_SPANS: usize = 16_384;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Highlighted,
    Disabled,
    UnknownLanguage,
    OverBudget,
    BackendError,
}

/// Derived, non-overlapping runs. Public offsets count UTF-16 code units.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TokenSpan {
    pub start: u32,
    pub end: u32,
    pub scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Highlight<'a> {
    pub source: &'a str,
    pub language: &'a str,
    pub backend: &'static str,
    pub status: Status,
    pub spans: Vec<TokenSpan>,
}

/// Explicitly constructed by optional consumers; never initialized by editac-core.
pub struct Backend {
    syntaxes: SyntaxSet,
}
impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}
impl Backend {
    pub fn new() -> Self {
        Self {
            syntaxes: two_face::syntax::extra_newlines(),
        }
    }

    pub fn highlight<'a>(
        &self,
        language: &'a str,
        source: &'a str,
        enabled: bool,
    ) -> Highlight<'a> {
        let mut result = Highlight {
            source,
            language,
            backend: BACKEND_ID,
            status: Status::Highlighted,
            spans: vec![],
        };
        if !enabled {
            result.status = Status::Disabled;
            return result;
        }
        let syntax_name = match language {
            "rust" => "Rust",
            "typescript" => "TypeScript",
            "json" => "JSON",
            _ => {
                result.status = Status::UnknownLanguage;
                return result;
            }
        };
        if source.len() > MAX_SOURCE_BYTES
            || source.split_inclusive('\n').count() > MAX_LINES
            || source
                .split_inclusive('\n')
                .any(|s| s.len() > MAX_LINE_BYTES)
        {
            result.status = Status::OverBudget;
            return result;
        }
        let Some(syntax) = self.syntaxes.find_syntax_by_name(syntax_name) else {
            result.status = Status::BackendError;
            return result;
        };
        let mut parser = ParseState::new(syntax);
        let mut stack = ScopeStack::new();
        let mut offset = 0u32;
        for line in LinesWithEndings::from(source) {
            let Ok(ops) = parser.parse_line(line, &self.syntaxes) else {
                result.status = Status::BackendError;
                result.spans.clear();
                return result;
            };
            for (text, op) in ScopeRegionIterator::new(&ops, line) {
                if stack.apply(op).is_err() {
                    result.status = Status::BackendError;
                    result.spans.clear();
                    return result;
                }
                let end = offset + text.encode_utf16().count() as u32;
                if end > offset {
                    if result.spans.len() == MAX_SPANS {
                        result.status = Status::OverBudget;
                        result.spans.clear();
                        return result;
                    }
                    result.spans.push(TokenSpan {
                        start: offset,
                        end,
                        scopes: stack.as_slice().iter().map(ToString::to_string).collect(),
                    });
                }
                offset = end;
            }
        }
        result
    }
}

/// Qualification binding only. Shipping worker scheduling is owned by RCH-1.4.
#[cfg(feature = "probe-wasm")]
mod wasm_probe {
    use super::*;
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    pub struct ProbeBackend(Backend);
    #[wasm_bindgen]
    impl ProbeBackend {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self(Backend::new())
        }
        pub fn highlight(&self, language: &str, source: &str, enabled: bool) -> String {
            serde_json::to_string(&self.0.highlight(language, source, enabled))
                .expect("serializable probe record")
        }
    }
}
