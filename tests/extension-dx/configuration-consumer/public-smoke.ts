import { createEditor, mountEditorSurface, DocumentSearch, BlockReorder, defaultPreset, documentPreset, taskPreset } from '@edit-ac/web';
import type { EditorOptions, EditorSurfaceOptions, EditorFacadeOptionsV1 } from '@edit-ac/web';
// Declaration checks run in the installed consumer, with no private source paths.
const facade: EditorFacadeOptionsV1 = { extensions: [DocumentSearch.configure(), BlockReorder.configure()],
  platform: { spellcheck: 'platform', autocorrection: 'inherit' }, formatting: { marks: { bold: { shortcuts: false, controls: false } } } };
const surface: EditorSurfaceOptions = facade;
const configured: Partial<EditorOptions> = facade;
void [createEditor, mountEditorSurface, taskPreset(), surface, configured, defaultPreset(), documentPreset()];
// @ts-expect-error unknown portable option
DocumentSearch.configure({ unknown: true });
// @ts-expect-error invalid platform mode
const invalid: EditorSurfaceOptions = { extensions: [], platform: { spellcheck: 'yes' } };
void invalid;
