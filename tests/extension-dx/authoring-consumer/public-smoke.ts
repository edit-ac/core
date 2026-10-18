import { Extension, type ExtensionContextV1, type ExtensionCreateV1 } from '@edit-ac/web';
const definition: ExtensionCreateV1<{enabled:boolean}> = { apiVersion:1,
 feature:{id:'demo.typed',version:1,schemas:['editac.registry.editor.v5'],capabilities:[],permissions:[],requires:[],conflicts:[],bindings:[],qualification:'qualified',owner:'typed',ownership:{focus:'host',nestedControls:'exclude',drag:'host-text-or-block',composition:'exclude',selection:'prepared-result',history:'one-intent',presenters:[],cancellation:'abort-and-revision',teardown:'idempotent'}},
 semantics:{kind:'behavior'},defaults:{enabled:true},validateOptions:o=>o.enabled,loading:'required-input',interests:[],
 onAttach(options, context:ExtensionContextV1) {
 // @ts-expect-error Options cannot be mutated.
 options.enabled=false;
 // @ts-expect-error There is no writable engine port.
 context.engine.commit('raw');
 context.captureTarget()?.dispose();
 }};
const factory=Extension.create(definition);factory.configure({enabled:false});
// @ts-expect-error Option values retain their declared type.
factory.configure({enabled:'yes'});
// @ts-expect-error Unknown options are rejected.
factory.configure({unknown:1});
// @ts-expect-error Engine semantics are not browser authoring.
const semantics:ExtensionCreateV1<{}>['semantics']={kind:'engine'};
// @ts-expect-error Input cannot return a raw edit or a promise.
const input:NonNullable<ExtensionCreateV1<{}>['input']>=[{type:'key',key:'F8',priority:1,prepare:async()=>undefined}];
