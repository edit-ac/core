//! Public v1 imports reuse the qualified implementations, not new semantics.
use editac_core::modules::{
    EXTENSION_API_VERSION,
    v1::{
        Definition, EditorCommand, EditorCommit, EditorError, FragmentBlock, FragmentRun,
        FrozenRegistry, ModuleKind, PreparedEditorEdit, Registry, RegistryError,
    },
};

#[test]
fn public_v1_types_are_the_owning_types() {
    assert_eq!(EXTENSION_API_VERSION, 1);
    fn registry(value: Registry) -> editac_core::modules::registry::Registry {
        value
    }
    assert!(registry(Registry::default()).freeze().is_empty());
    fn same<T>() {
        assert!(std::mem::size_of::<T>() > 0);
    }
    same::<Definition>();
    same::<FrozenRegistry>();
    same::<ModuleKind>();
    same::<RegistryError>();
    same::<EditorCommand>();
    same::<EditorCommit>();
    same::<EditorError>();
    same::<PreparedEditorEdit>();
    same::<FragmentBlock>();
    same::<FragmentRun>();
}
