//! Optional local RTF directions qualify independently.
#[cfg(feature = "rtf-export")]
pub mod export;
#[cfg(feature = "rtf-import")]
pub mod import;
