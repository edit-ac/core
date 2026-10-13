//! Trusted, ordered semantic hooks after the qualified whole-document parser.
use crate::{
    FragmentBlock,
    import::{ImportError, PreparedContent},
    optional::{Codecs, import_with_codecs},
};
use editac_core::{
    commands::format::{Mark, normalize_link_url},
    document::BlockAttributes,
    modules::content::Content,
};

pub trait Extension {
    fn name(&self) -> &str;
    fn import(
        &self,
        _prepared: &PreparedContent,
    ) -> Result<Option<Vec<FragmentBlock>>, ImportError> {
        Ok(None)
    }
    fn export(&self, _blocks: &[FragmentBlock]) -> Option<String> {
        None
    }
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
pub fn import(
    source: &str,
    codecs: Codecs,
    extensions: &[&dyn Extension],
) -> Result<PreparedContent, ImportError> {
    if extensions.len() > 32 {
        return Err(ImportError::ResourceLimit);
    }
    let mut p = import_with_codecs(source, codecs)?;
    let mut names = std::collections::BTreeSet::new();
    for extension in extensions {
        let name = extension.name();
        if name.is_empty() || name.len() > 64 || !names.insert(name) {
            return Err(ImportError::InvalidStructure);
        }
        if let Some(blocks) = extension.import(&p)? {
            validate(&blocks)?;
            p.ranges = blocks.iter().map(|_| 0..source.len()).collect();
            p.blocks = blocks;
        }
    }
    Ok(p)
}
pub fn export(
    blocks: &[FragmentBlock],
    extensions: &[&dyn Extension],
) -> Result<crate::export::ExportResult, ImportError> {
    validate(blocks)?;
    for e in extensions {
        if let Some(markdown) = e.export(blocks) {
            if markdown.len() > 1_048_576 {
                return Err(ImportError::ResourceLimit);
            }
            let parsed = import(
                &markdown,
                Codecs {
                    images: true,
                    tables: true,
                    callouts: true,
                },
                extensions,
            )?;
            let equivalent = crate::export::equivalent(blocks, &parsed.blocks);
            return Ok(crate::export::ExportResult {
                markdown,
                diagnostics: if equivalent {
                    vec![]
                } else {
                    vec![crate::import::Diagnostic {
                        code: "extension-unrepresentable",
                        range: 0..0,
                    }]
                },
                recovery: if equivalent { vec![] } else { blocks.to_vec() },
            });
        }
    }
    Ok(crate::export::export(blocks))
}
