import { createEditor, mountEditorSurface, openEditorStorage, DocumentSearch, BlockReorder, Images, Tables, MathNotation, References, SlashCommands, Markdown, defaultPreset, documentPreset, taskPreset } from '@edit-ac/web';
import type { EditorOptions, EditorSurfaceOptions, EditorFacadeOptionsV1 } from '@edit-ac/web';
// Declaration checks run in the installed consumer, with no private source paths.
const facade: EditorFacadeOptionsV1 = { extensions: [DocumentSearch.configure(), BlockReorder.configure()],
  platform: { spellcheck: 'platform', autocorrection: 'inherit' }, formatting: { marks: { bold: { shortcuts: false, controls: false } } } };
const surface: EditorSurfaceOptions = facade;
const configured: Partial<EditorOptions> = facade;
void [MathNotation.configure(), References.configure({host:()=>[],triggers:['@']}), SlashCommands.configure({commands:[]}), openEditorStorage, Images.configure(), Tables.configure(), Markdown.configure(), Markdown.configure({input:false}), createEditor, mountEditorSurface, openEditorStorage, taskPreset(), surface, configured, defaultPreset(), documentPreset()];
// @ts-expect-error unknown portable option
DocumentSearch.configure({ unknown: true });
// @ts-expect-error invalid platform mode
const invalid: EditorSurfaceOptions = { extensions: [], platform: { spellcheck: 'yes' } };
void invalid;

// @ts-expect-error Markdown input is a boolean, never an arbitrary load policy
Markdown.configure({input:'lazy'});

// @ts-expect-error an explicit reference host is required
References.configure({triggers:['@']});
// @ts-expect-error slash actions are prepared callbacks
SlashCommands.configure({commands:[{id:'x',label:'X',prepare:'invalid'}]});
