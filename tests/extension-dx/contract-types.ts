import { defineExtensionContract, prepareEditorExtensionConfiguration } from '@edit-ac/web';
import type { EditorExtensionConfigurationV1, ExtensionDefinitionV1, ExtensionStatusV1, ExtensionAuthoringV1, ExtensionCallbackContextV1, PlatformPreferencesV1 } from '@edit-ac/web';
import type { ProfileFeature } from '@edit-ac/core/extensions';
declare const feature: ProfileFeature;
const definition: ExtensionDefinitionV1<{ literal: boolean }> = {
  apiVersion: 1, feature, semantics: { kind: 'behavior' }, defaults: { literal: true },
  validateOptions: value => typeof value.literal === 'boolean', loading: 'required-input',
  interests: [{ kinds: ['Text'], range: { source: 'body', start: 0, end: 40 }, selection: false }],
};
const Markdown = defineExtensionContract(definition);
const first = Markdown.configure({ literal: false });
const second = Markdown.configure();
const plain: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], formatting: { marks: { bold: { commands: false, shortcuts: false, controls: false } } }, collaboration: false };
const formatted: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [first, second], preset: 'document', platform: { spellcheck: 'platform', autocorrection: 'off' }, assets: { baseURL: 'https://assets.example/v1/' } };
const collaborative: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], collaboration: { readiness: 'local', connect: async ({signal, generation}) => { void signal; void generation; throw Error('prepared fixture only'); }, presence: { awareness: true, peerCarets: false } } };
prepareEditorExtensionConfiguration(plain, {schema: 'rich-text', capabilities: []});
void formatted; void collaborative;
const states: ExtensionStatusV1[] = [{state:'loading',generation:1}, {state:'failed',generation:2,code:'denied',retryable:false}]; void states;
const callbacks: ExtensionAuthoringV1<{ literal: boolean }> = { onAttach: (options, context) => { void options.literal; context.subscribe({ kinds: ['Format'] }, () => {}); return () => {}; } }; void callbacks;
declare const context: ExtensionCallbackContextV1;
// @ts-expect-error callbacks cannot reach a mutable engine/document
context.engine;
// @ts-expect-error callbacks cannot write DOM as document state
context.root;
// @ts-expect-error unknown option
Markdown.configure({ dictionary: true });
// @ts-expect-error wrong option value
Markdown.configure({ literal: 'yes' });
// @ts-expect-error configured options are readonly
first.options.literal = false;
// @ts-expect-error future API versions require explicit migration
const future: EditorExtensionConfigurationV1 = { apiVersion: 2, extensions: [] }; void future;
// @ts-expect-error operation names follow the existing engine patch union
const badInterest: ExtensionDefinitionV1<{}> = { ...definition, interests: [{ kinds: ['Any'] }] }; void badInterest;
// @ts-expect-error new engine semantics are not arbitrary JS registration
const engineSemantic: ExtensionDefinitionV1<{}> = { ...definition, semantics: { kind: 'engine' } }; void engineSemantic;
// @ts-expect-error no unqualified PDF import direction
const pdf: ExtensionDefinitionV1<{}> = { ...definition, loading: 'pdf-import' }; void pdf;
// @ts-expect-error only core-admitted basic marks are offered
const marks: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], formatting: { marks: { rainbow: {} } } }; void marks;
// @ts-expect-error presence has separate explicitly typed controls
const presence: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], collaboration: { connect: () => { throw 0; }, presence: true } }; void presence;
// @ts-expect-error no implicit provider name or credentials in configuration
const provider: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], collaboration: { provider: 'ambient' } }; void provider;
// @ts-expect-error use exactly one asset override
const assets: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], assets: { baseURL: 'https://a/', manifest: {} } }; void assets;
// @ts-expect-error product use cases are not feature tiers
const tier: EditorExtensionConfigurationV1 = { apiVersion: 1, extensions: [], preset: 'comment-only' }; void tier;
// @ts-expect-error observed platform support cannot be inferred as a preference
const platform: PlatformPreferencesV1 = { spellcheck: 'supported' }; void platform;
// @ts-expect-error failure diagnostics are required for failure state
const failed: ExtensionStatusV1 = {state:'failed',generation:1}; void failed;
// @ts-expect-error document callbacks are separate from serializable configuration options
defineExtensionContract({ ...definition, defaults: { resolve: () => null } });

const Nested = defineExtensionContract({ ...definition, defaults: { nested: { limit: 1 } }, validateOptions: () => true });
// @ts-expect-error nested options also preserve typed immutability
Nested.configure().options.nested.limit = 2;

declare const prepared: ReturnType<typeof prepareEditorExtensionConfiguration>;
// @ts-expect-error prepared formatting policy is immutable too
prepared.configuration.formatting!.marks!.bold = { controls: true };
