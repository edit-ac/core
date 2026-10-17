//! Shared prepared-fragment validation, independent of Markdown syntax.
use super::{
    editor::FragmentBlock,
    format::{Mark, normalize_link_url},
};
use crate::{document::BlockAttributes, modules::content::Content};
/// Inert attribute pair; this alias carries no formatting or host authority.
pub type OpaqueMark = (String, yrs::Any);
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportError {
    ResourceLimit,
    InvalidStructure,
}
pub fn validate(blocks: &[FragmentBlock]) -> Result<(), ImportError> {
    if blocks.len() > 128
        || blocks.iter().map(|b| b.runs.len()).sum::<usize>() > 1024
        || blocks
            .iter()
            .flat_map(|b| &b.runs)
            .map(|r| r.text.len())
            .sum::<usize>()
            > 1_048_576
    {
        return Err(ImportError::ResourceLimit);
    }
    let mut opaque_bytes = 0;
    for b in blocks {
        if b.containers.len() > 16 {
            return Err(ImportError::ResourceLimit);
        }
        match &b.attributes {
            Some(BlockAttributes::Heading(level)) if !(1..=6).contains(level) => {
                return Err(ImportError::InvalidStructure);
            }
            Some(BlockAttributes::Code(language))
                if language.len() > 64
                    || !language
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+._-".contains(&c)) =>
            {
                return Err(ImportError::InvalidStructure);
            }
            _ => {}
        }
        if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
            if Content::from_tuple(t)
                .map_err(|_| ImportError::InvalidStructure)?
                .is_none()
            {
                return Err(ImportError::InvalidStructure);
            }
        }
        for r in &b.runs {
            validate_opaque_marks(&r.opaque_marks)?;
            opaque_bytes += r
                .opaque_marks
                .iter()
                .map(|(k, v)| k.len() + crate::interchange::value(v).to_string().len())
                .sum::<usize>();
            if opaque_bytes > 1_048_576 {
                return Err(ImportError::ResourceLimit);
            }
            let mut seen = std::collections::BTreeSet::new();
            if r.marks.iter().any(|(m, _)| !seen.insert(m.key())) {
                return Err(ImportError::InvalidStructure);
            }
            if r.marks.len() > 6 {
                return Err(ImportError::ResourceLimit);
            }
            for (m, href) in &r.marks {
                if *m == Mark::Link {
                    normalize_link_url(href.as_deref().ok_or(ImportError::InvalidStructure)?)
                        .map_err(|_| ImportError::InvalidStructure)?;
                } else if href.is_some() {
                    return Err(ImportError::InvalidStructure);
                }
            }
        }
    }
    Ok(())
}

/// Inert JSON only: no permission, dispatch, module registration or execution.
/// Keys occupy the existing Yrs attribute namespace, disjoint from named marks.
pub fn validate_opaque_marks(marks: &[(String, yrs::Any)]) -> Result<(), ImportError> {
    use yrs::Any;
    fn visit(v: &Any, depth: usize, nodes: &mut usize) -> Result<(), ImportError> {
        *nodes += 1;
        if depth > 8 || *nodes > 256 {
            return Err(ImportError::ResourceLimit);
        }
        match v {
            Any::Null | Any::Bool(_) | Any::String(_) => Ok(()),
            Any::Number(n)
                if n.as_f64().is_some_and(|f| {
                    f.is_finite() && (f.fract() != 0.0 || f.abs() <= 9_007_199_254_740_991.0)
                }) =>
            {
                Ok(())
            }
            Any::Array(a) => {
                for x in a.iter() {
                    visit(x, depth + 1, nodes)?;
                }
                Ok(())
            }
            Any::Map(m) => {
                for x in m.values() {
                    visit(x, depth + 1, nodes)?;
                }
                Ok(())
            }
            _ => Err(ImportError::InvalidStructure),
        }
    }
    if marks.len() > 32 {
        return Err(ImportError::ResourceLimit);
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut bytes = 0;
    for (key, value) in marks {
        if key.is_empty()
            || key.len() > 128
            || key.chars().any(char::is_control)
            || ["bold", "italic", "strike", "underline", "code", "link"].contains(&key.as_str())
            || !seen.insert(key)
            || matches!(value, Any::Null)
        {
            return Err(ImportError::InvalidStructure);
        }
        visit(value, 0, &mut 0)?;
        let size = crate::interchange::value(value).to_string().len();
        if size > 16_384 {
            return Err(ImportError::ResourceLimit);
        }
        bytes += key.len() + size;
    }
    if bytes > 65_536 {
        return Err(ImportError::ResourceLimit);
    }
    Ok(())
}

#[cfg(test)]
mod opaque_tests {
    use super::*;
    use yrs::Any;
    fn v(v: serde_json::Value) -> Any {
        Any::from_json(&v.to_string()).unwrap()
    }
    #[test]
    fn opaque_descriptor_bounds_reject_duplicates_reserved_null_and_unsafe_values() {
        use serde_json::json;
        let mark = (
            "vendor-note".into(),
            v(json!({"type":"vendor.note","version":1,"payload":[true,"😀",42]})),
        );
        assert!(validate_opaque_marks(&[mark.clone()]).is_ok());
        for data in [
            vec![mark.clone(), mark.clone()],
            vec![("bold".into(), mark.1.clone())],
            vec![("".into(), mark.1.clone())],
            vec![("x".into(), Any::Null)],
            vec![("x".into(), Any::Undefined)],
            vec![mark.clone(); 33],
        ] {
            assert!(validate_opaque_marks(&data).is_err());
        }
        let mut deep = json!(true);
        for _ in 0..10 {
            deep = json!([deep]);
        }
        for value in [deep, json!(vec![true; 257]), json!("x".repeat(16385))] {
            assert!(validate_opaque_marks(&[("vendor".into(), v(value))]).is_err());
        }
        assert!(validate_opaque_marks(&[("x".into(), v(json!(false)))]).is_ok());
        assert!(validate_opaque_marks(&[("x".into(), v(json!(9_007_199_254_740_991i64)))]).is_ok());
        for value in [
            json!(9_007_199_254_740_992i64),
            json!(-9_007_199_254_740_992i64),
            json!(1e30),
        ] {
            assert!(validate_opaque_marks(&[("x".into(), v(value))]).is_err());
        }
    }
}
