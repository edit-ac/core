import type {EngineHandle, SourceBaseline, PlanToken, Checkpoint} from '@edit-ac/core';
import type {BrowserEditor} from '@edit-ac/web';
import {initMarkdown} from '@edit-ac/markdown';
declare const engine: EngineHandle, editor: BrowserEditor, opening: Checkpoint;
const source = '| a |\n| - |\n| b |';
const baseline: SourceBaseline = engine.captureSourceBaseline(source, ['table'], {tables:true}, opening);
const prepared = baseline.prepareTableFormat('table', 'local:table-source');
const plan: PlanToken = prepared.plan;
engine.releasePlan(plan);
const publicBaseline = editor.captureSourceBaseline(source, ['table'], {tables:true}, opening);
const edit = publicBaseline.prepareTableFormat('table', 'local:table-source');
editor.commitPrepared(edit.plan);editor.releasePlan(edit.plan);
const retained: string = publicBaseline.sourceWithCurrentTable('table');
void retained;void initMarkdown;
// @ts-expect-error baseline original source is immutable
baseline.originalSource = 'changed';
// @ts-expect-error plans are opaque, engine-owned tokens
editor.commitPrepared('invented');
// @ts-expect-error codec admission is explicit boolean data
engine.captureSourceBaseline(source, ['table'], {tables:'yes'});
baseline.dispose();publicBaseline.dispose();
