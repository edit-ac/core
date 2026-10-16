import { expectedSemantics, projectedSemantics, overwriteTarget } from '../benchmarks/fixtures.mjs';
import assert from 'node:assert/strict';
import { rawSummary, digest } from './architecture-budgets.mjs';
const finite = n => Number.isFinite(n) && n >= 0;
const geometry = r => r && ['x','y','width','height'].every(k => Number.isFinite(r[k])) && r.width >= 0 && r.height > 0;
// Fresh target execution, never an exemption for changed workspace manifests.
export function inspectNativeBuild(receipt, { graph, rustc, library, app }) {
  const b = receipt.nativeBuild;
  assert.deepEqual(b, { target:'aarch64-apple-ios-sim', package:'editac-ffi', profile:'release', features:'fitness-trace',
    graphHash:digest(graph), rustcHash:digest(rustc), libraryHash:digest(library), measurementReuse:false });
  assert.match(graph.toString(), /^editac-ffi v0\.0\.0 /);
  assert.match(graph.toString(), /editac-core feature "default"/);
  assert.match(rustc.toString(), /^rustc 1\.97\.1 /);
  for (const [path, bytes] of [['native-target-graph.log',graph],['native-target-graph-after.log',graph],
    ['native-rustc.log',rustc],['libeditac_ffi.a',library],['NativeFitness',app]]) {
    assert.equal(receipt.artifacts[path],digest(bytes), 'Changed native build artifact '+path);
  }
  assert.equal(receipt.libraryHash,b.libraryHash);
  for (const id of ['native-target-graph','native-target-graph-after','native-rustc','native-build','xcode-build']) {
    const check = receipt.checks.find(c=>c.id===id);
    assert(check && check.exit===0 && check.timeout===false, 'Unexecuted native build proof '+id);
  }
  const build = receipt.checks.find(c=>c.id==='native-build').command;
  for (const flag of ['+1.97.1','--lib','--release','--locked','--offline','--target aarch64-apple-ios-sim','-p editac-ffi']) assert(build.includes(flag));
  assert(/--features fitness-trace(?:\s|$)/.test(build));
  assert.equal((build.match(/--features/g)||[]).length,1);
  assert(!/--(?:all-features|no-default-features)(?:\s|=|$)/.test(build));
  assert.match(graph.toString(), /editac-ffi v0\.0\.0 .*fitness-trace/);
}
export function inspectAppendFocus(result, mode, initialUnits) {
  const r = result.focusReadiness;
  assert(r && finite(r.keyboardDidShowAt) && finite(r.selectionInstalledAt) && finite(r.readyAt), 'missing native append focus clocks');
  assert(r.keyboardDidShowAt <= r.readyAt && r.selectionInstalledAt <= r.readyAt, 'reversed native append focus clocks');
  assert(finite(r.requestedAt) && r.keyboardDidShowAt >= r.requestedAt && r.selectionInstalledAt >= r.requestedAt, 'stale native input-session readiness');
  assert.equal(r.applicationActive, true); assert.equal(r.sceneActive, true);
  assert.equal(r.keyWindow, true); assert.equal(r.inputMode, mode);
  assert.deepEqual(r.selectionUtf16, [initialUnits, 0]);
}
export function inspectNativeInput(profile, receipt, result, accessibility) {
  inspectAppendFocus(result, 'en-US', profile.initialUtf16Units);
  const focusRequests = result.cases?.find(c => c.id === 'os-keyboard-committed-source')?.observed?.focusRequests;
  assert(Number.isSafeInteger(focusRequests) && focusRequests >= 1 && focusRequests <= 3, 'missing actual native focus acknowledgment');
  assert.equal(profile.id, 'native-input-v1'); assert.equal(profile.version, 1);
  assert.equal(profile.scenario, 'ascii-keyboard-append/native-marked-cancel/checkpoint-reopen/accessibility-query-v1');
  assert.equal(profile.device, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17');
  assert.equal(profile.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(profile.runtimeBuildVersion, '23F77'); assert.equal(profile.initialTextUtf8Bytes, 9); assert.equal(profile.initialUtf16Units, 6);
  assert.equal(profile.fixture, 'tests/native/fixtures/bounded-abi.json');
  assert.deepEqual(profile.features, ['v5-native-engine','UITextView-TextKit1','generated-Swift-FFI','XCTest-OS-keyboard','XCTest-accessibility-client','native-fitness-trace']);
  assert.equal(profile.typed, 'abcdefghijkl'); assert.equal(profile.samples, 12); assert.equal(profile.warmups, 0);
  assert.equal(profile.minimumTailSamples, 100); assert(Number.isFinite(Date.parse(profile.reviewedAt)));
  assert(Date.parse(profile.reviewedAt) <= Date.parse(receipt.startedUtc));
  assert.equal(receipt.state, 'diagnostic-delivered'); assert.equal(receipt.qualification, 'unqualified');
  assert.equal(result.qualification, 'unqualified'); assert.equal(profile.qualification, 'unqualified');
  assert.equal(receipt.metadata.provenance, 'iOS Simulator'); assert.equal(receipt.metadata.physical, false); assert.equal(receipt.metadata.machine, 'arm64');
  for (const key of ['cpu','hostOS','machine','xcode','swift','revision']) assert.equal(typeof receipt.metadata[key], 'string');
  assert(['cpu','hostOS','machine','xcode','swift','revision'].every(k => receipt.metadata[k].trim().length > 0));
  assert.match(receipt.libraryHash,/^[a-f0-9]{64}$/);
  assert(receipt.metadata.memoryBytes > 0 && receipt.metadata.cores > 0);
  assert.deepEqual(receipt.metadata.runtime,{identifier:profile.runtime,version:'26.5',buildversion:profile.runtimeBuildVersion,isAvailable:true});
  assert.equal(receipt.metadata.simulator.device, profile.device); assert.equal(receipt.metadata.simulator.runtime, profile.runtime);
  assert.equal(receipt.cleanup.simulatorDeleted, true);
  assert.deepEqual(receipt.counts, {executed:5,passed:5,failed:0,skipped:0}); assert.deepEqual(result.counts, receipt.counts);
  assert.deepEqual(receipt.xctestCounts, {totalTestCount:4,passedTests:4,failedTests:0,skippedTests:0});
  for (const id of ['native-build','xcode-build','xctest','xcresult-summary','attachments','simulator-shutdown','simulator-delete']) assert(receipt.checks.some(c => c.id === id && c.exit === 0 && c.timeout === false && Number.isSafeInteger(c.pid) && c.pid > 0));
  assert.deepEqual(result.cases.map(c => c.id), ['os-keyboard-committed-source','response-frame-and-caret','marked-text-cancellation-source-preservation','native-checkpoint-reopen','disposal']);
  assert(result.cases.every(c => c.state === 'passed')); assert.deepEqual(result.errors, []);
  const expected = 'A😀éZ' + profile.typed;
  assert.equal(result.cases[0].observed.typed, profile.typed); assert.equal(result.cases[0].observed.committed, expected);
  assert.equal(result.cases[0].observed.selectionUtf16, expected.length);
  assert.equal(result.cases[2].observed.before, expected); assert.equal(result.cases[2].observed.after, expected);
  assert(geometry(result.cases[2].observed.markedRect)); assert.equal(result.cases[3].observed.text, expected);
  assert(result.cases[3].observed.checkpointBytes > 0);
  assert.deepEqual(result.cases[4].observed, {displayLinkInvalidated:true,keyboardObserverRemoved:true});
  assert.equal(result.host.physical, false); assert.equal(result.host.system, '26.5');
  assert.equal(typeof result.host.locale, 'string'); assert(result.host.refreshMaximum > 0);
  for (const k of ['thermalStart','thermalEnd']) assert([0,1,2,3].includes(result.host[k]));
  assert(result.host.thermalScope.includes('physical thermal behavior unavailable'));
  assert(result.keyboards.length > 0 && result.keyboards.every(k => finite(k.at) && geometry(k.frame) && k.local));
  assert.equal(accessibility.client, 'XCTest XCUIElement OS accessibility query/action');
  assert.equal(accessibility.value, expected); assert.equal(accessibility.status, 'verified'); assert(geometry(accessibility.frame));
  assert.equal(accessibility.driverClock,'ProcessInfo.systemUptime; independent clock, no cross-process timestamp join');
  assert.equal(accessibility.driverSamples.length,profile.samples);
  for (const [i,s] of accessibility.driverSamples.entries()) { assert(finite(s.before) && s.after >= s.before); assert.equal(s.value,'A😀éZ'+profile.typed.slice(0,i+1)); }
  assert.equal(accessibility.screenReader, 'not observed'); assert.equal(accessibility.keyboardVisible, true);
  assert.equal(result.samples.length, profile.samples); assert.equal(result.frames.length, profile.samples);
  assert.equal(new Set(result.samples.map(s=>s.displayTimestamp)).size, profile.samples);
  assert.equal(result.cases[1].observed.samples, profile.samples); assert.equal(result.cases[1].observed.frameCallbacks,result.frames.length);
  let previous = 0;
  for (const [i,s] of result.samples.entries()) {
    for (const k of ['inputAt','engineDoneAt','projectionDoneAt','frameCallbackAt','displayTimestamp','displayTargetTimestamp']) assert(finite(s[k]));
    assert(s.inputAt > previous); previous = s.inputAt;
    assert(s.inputAt <= s.engineDoneAt && s.engineDoneAt <= s.projectionDoneAt && s.projectionDoneAt <= s.frameCallbackAt);
    assert(s.displayTargetTimestamp > s.displayTimestamp);
    assert(result.frames.some(f => f.timestamp === s.displayTimestamp && f.targetTimestamp === s.displayTargetTimestamp));
    assert(geometry(s.caretRect)); assert.equal(s.rangeUtf16, 6+i); assert.equal(s.replacementUtf16, 1); assert.equal(s.committedUtf16, 7+i);
    assert([0,1,2,3].includes(s.thermal)); assert.equal(typeof s.inputMode, 'string'); assert.notEqual(s.inputMode, 'unavailable');
    assert.equal(s.firstResponderBeforeAndAfterCommit, true);
    assert.equal(s.firstResponderAtFrame, true);
  }
  for (const f of result.frames) assert(finite(f.callbackAt) && finite(f.timestamp) && f.targetTimestamp > f.timestamp);
  assert.deepEqual(result.gaps, ['CJK candidate window selection not observed','XCTest accessibility tree/action is not VoiceOver exploration',
    'display callback is not compositor paint','12 input samples below unchanged 100-sample tail bar','no physical thermal inference','bounded fixture, not Task/Long qualification']);
  return {qualification:'unqualified', limits:profile.limits, comparison:'delegate/display callbacks only; no compositor or cross-process clock calibration', sizes:{initialTextUtf8Bytes:Buffer.byteLength('A😀éZ'), finalTextUtf8Bytes:Buffer.byteLength(expected), initialUtf16Units:6, finalUtf16Units:expected.length, checkpointBytes:result.cases[3].observed.checkpointBytes}, inputToCallbackMs:rawSummary(result.samples.map(s => (s.frameCallbackAt-s.inputAt)*1000),100),
    driverDispatchAndAXMs:rawSummary(accessibility.driverSamples.map(s=>(s.after-s.before)*1000),100),
    nativeCommitMs:rawSummary(result.samples.map(s => (s.engineDoneAt-s.inputAt)*1000),100),
    nativeProjectionMs:rawSummary(result.samples.map(s => (s.projectionDoneAt-s.engineDoneAt)*1000),100),
    nativeLayoutCallbackMs:rawSummary(result.samples.map(s => (s.frameCallbackAt-result.frames.find(f => f.timestamp === s.displayTimestamp).callbackAt)*1000),100), gaps:result.gaps};
}

export function inspectPinyinDispatches(dispatches) {
  assert.deepEqual(dispatches.map(d=>d.key),['n','i','h','a','o'], 'missing or reordered Pinyin software-key dispatch');
  let previous=0;
  const contains=(outer,inner)=>inner.x>=outer.x && inner.y>=outer.y &&
    inner.x+inner.width<=outer.x+outer.width && inner.y+inner.height<=outer.y+outer.height;
  for(const d of dispatches) {
    assert.equal(d.transport,'single ordinary OS touch at observed software-key center; no replay or setter');
    for(const key of ['frame','keyboardFrame','windowFrame']) assert(geometry(d[key]) && d[key].width>0 && d[key].height>0,'invalid Pinyin dispatch geometry');
    assert(contains(d.keyboardFrame,d.frame) && contains(d.windowFrame,d.frame),'Pinyin key outside keyboard/window');
    assert.equal(d.point?.x,d.frame.x+d.frame.width/2); assert.equal(d.point?.y,d.frame.y+d.frame.height/2);
    assert(finite(d.before) && d.before>=previous && finite(d.after) && d.after>=d.before,'invalid Pinyin dispatch ordering');
    previous=d.after;
  }
}

export function inspectNativeCJK(profile, receipt, result, ax, dispatches) {
  assert.equal(profile.cjk.scenario,'os-pinyin-ni-candidate-commit/hao-host-cancel/checkpoint-reopen-v1');
  assert.equal(profile.cjk.keyboard,'zh_Hans-Pinyin'); assert.equal(profile.cjk.inputMode,'zh-Hans');
  assert.deepEqual(profile.cjk.commitKeys,['n','i']); assert.deepEqual(profile.cjk.cancelKeys,['h','a','o']);
  assert.equal(profile.cjk.candidate,'你'); assert.equal(profile.cjk.committed,'A😀éZ你'); assert.equal(profile.cjk.samples,1);
  assert.equal(profile.minimumTailSamples,100); assert.equal(profile.qualification,'unqualified');
  assert(Date.parse(profile.reviewedAt) <= Date.parse(receipt.startedUtc));
  assert.equal(receipt.state,'diagnostic-delivered'); assert.equal(receipt.metadata.physical,false);
  assert.equal(receipt.metadata.runtime.identifier,profile.runtime); assert.equal(receipt.cleanup.simulatorDeleted,true);
  assert.deepEqual(receipt.xctestCounts,{totalTestCount:4,passedTests:4,failedTests:0,skippedTests:0});
  assert.deepEqual(receipt.cjkCounts,{executed:6,passed:6,failed:0,skipped:0}); assert.deepEqual(result.counts,receipt.cjkCounts);
  assert.equal(result.qualification,'unqualified'); assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.cases.map(c=>c.id),['os-pinyin-marked-isolation','os-candidate-committed-source','os-composition-cancellation','cjk-response-frame-and-caret','cjk-checkpoint-reopen','cjk-disposal']);
  assert(result.cases.every(c=>c.state==='passed'));
  const initial='A😀éZ', expected=profile.cjk.committed;
  assert.equal(result.host.system,'26.5'); assert.equal(result.host.physical,false); assert(result.host.inputModes.includes('zh-Hans'));
  assert.equal(typeof result.host.locale,'string'); for(const k of ['thermalStart','thermalEnd']) assert([0,1,2,3].includes(result.host[k]));
  const marked=result.compositionEvents.filter(e=>e.marked);
  assert(marked.length>=2); assert(marked.some(e=>e.committedBefore===initial)); assert(marked.some(e=>e.committedBefore===expected));
  let previous=0;
  for(const e of result.compositionEvents) {
    assert(finite(e.at) && e.at>=previous); previous=e.at;
    assert.equal(e.inputMode,'zh-Hans'); assert(geometry(e.caretRect));
    assert(['setMarkedText','setAttributedMarkedText','replace','unmarkText','insertText','deleteBackward','textViewDidChange'].includes(e.kind));
    assert([initial,expected].includes(e.committedBefore)); assert([initial,expected].includes(e.committedAfter));
    if(e.marked) {assert.equal(e.committedBefore,e.committedAfter); assert(e.markedText.length>0); assert(geometry(e.markedRect)); assert(e.projected.startsWith(e.committedBefore));}
  }
  assert.equal(result.cases[0].observed.inputMode,'zh-Hans'); assert.equal(result.cases[0].observed.events,marked.length);
  inspectAppendFocus(result, 'zh-Hans', profile.initialUtf16Units);
  assert.equal(ax.transport, 'single ordinary OS touch at observed software-key center; one dispatch per key, no replay or setter');
  inspectPinyinDispatches(dispatches);
  const focusRequests = result.cases[1].observed.focusRequests;
  assert(Number.isSafeInteger(focusRequests) && focusRequests >= 1 && focusRequests <= 3, 'missing actual CJK focus acknowledgment');
  assert.deepEqual(result.cases[1].observed,{typed:'你',focusRequests,committed:expected,selectionUtf16:expected.length});
  const cancel=result.cases[2].observed;
  assert.equal(cancel.before,expected); assert.equal(cancel.after,expected); assert.equal(cancel.projectedAfter,expected); assert.equal(cancel.markedAfter,false);
  assert(cancel.projectedBefore.startsWith(expected) && cancel.projectedBefore!==expected); assert(geometry(cancel.markedRect)); assert(finite(cancel.at));
  assert.deepEqual(result.cases[3].observed,{samples:1,frameCallbacks:1});
  assert.equal(result.cases[4].observed.text,expected); assert(result.cases[4].observed.checkpointBytes>0);
  assert.deepEqual(result.cases[5].observed,{displayLinkInvalidated:true,keyboardObserverRemoved:true});
  assert.equal(result.samples.length,1); assert.equal(result.frames.length,1);
  const s=result.samples[0],f=result.frames[0];
  for(const k of ['inputAt','engineDoneAt','projectionDoneAt','frameCallbackAt','displayTimestamp','displayTargetTimestamp']) assert(finite(s[k]));
  assert(s.inputAt<=s.engineDoneAt && s.engineDoneAt<=s.projectionDoneAt && s.projectionDoneAt<=s.frameCallbackAt);
  assert(s.displayTargetTimestamp>s.displayTimestamp); assert.equal(f.timestamp,s.displayTimestamp); assert.equal(f.targetTimestamp,s.displayTargetTimestamp); assert(finite(f.callbackAt));
  assert.equal(s.rangeUtf16,initial.length); assert.equal(s.replacementUtf16,1); assert.equal(s.committedUtf16,expected.length); assert.equal(s.inputMode,'zh-Hans');
  assert([0,1,2,3].includes(s.thermal)); assert(geometry(s.caretRect));
  assert(result.keyboards.length>0 && result.keyboards.every(k=>finite(k.at)&&geometry(k.frame)&&k.local));
  assert.equal(ax.client,'XCTest OS Pinyin candidate accessibility query/action'); assert.equal(ax.candidate.label,'你'); assert.equal(ax.candidate.hittable,true);
  assert(Number.isSafeInteger(ax.candidate.elementType)); assert(geometry(ax.candidate.frame)); assert(ax.candidate.frame.width>0); assert(geometry(ax.candidate.keyboardFrame));
  assert.equal(ax.committed,expected); assert.equal(ax.value,expected); assert.equal(ax.status,'verified'); assert.equal(ax.screenReader,'not observed');
  assert.equal(ax.cancelAction,'native host cancels actual OS marked text');
  assert.equal(ax.driverClock,'ProcessInfo.systemUptime; independent clock, no cross-process timestamp join');
  assert(finite(ax.candidateDispatchBefore) && ax.candidateAXAfter>=ax.candidateDispatchBefore);
  assert.deepEqual(ax.keys.map(k=>k.key),['n','i','h','a','o']);
  for(const [i,k] of ax.keys.entries()) {assert.equal(k.source,i<2?initial:expected); assert(k.projected.startsWith(k.source)&&k.projected!==k.source); assert(finite(k.at));}
  assert.deepEqual(result.gaps,['single Pinyin candidate and host cancellation only','callback is not compositor paint','one commit below 100-sample tail bar','XCTest accessibility is not VoiceOver exploration','not Task/Long or full SDK qualification']);
  return {qualification:'unqualified',scenario:profile.cjk.scenario,candidate:ax.candidate,markedEvents:marked.length,
    comparison:'native callback after UIKit mutation -> Rust acknowledgment -> display callback; OS projection precedes this clock span; driver dispatch/AX is separate and not clock-calibrated',
    postMutationToCallbackMs:rawSummary([(s.frameCallbackAt-s.inputAt)*1000],100),nativeCommitMs:rawSummary([(s.engineDoneAt-s.inputAt)*1000],100),
    candidateDispatchAndAXMs:rawSummary([(ax.candidateAXAfter-ax.candidateDispatchBefore)*1000],100),gaps:result.gaps};
}

// Actual Task/Long runtime proof; twelve samples remain diagnostic. A receipt
// with only the small keyboard fixture cannot satisfy this envelope.
export function inspectNativeEditWindows(samples, resources) {
  assert(Array.isArray(samples)&&samples.length>0,'missing native edit windows');
  assert(Array.isArray(resources)&&resources.length===samples.length+4,'missing native edit resources');
  for(const [i,s] of samples.entries()) {
    assert(finite(s.inputAt)&&finite(s.layoutDoneAt)&&s.inputAt<=s.layoutDoneAt,'invalid native edit window');
    assert(i===0||samples[i-1].layoutDoneAt<=s.inputAt,'overlapping or reordered native workload samples');
  }
  for(const [i,s] of samples.entries()) {
    const at=resources[i+2].at;
    assert(finite(at)&&at>=s.layoutDoneAt&&
      (i===samples.length-1||at<=samples[i+1].inputAt),'native resource outside acknowledged edit window');
  }
}
export function inspectNativeWorkload(profile, receipt, result, fixture, initial, final, reopened, checkpoint, metadata) {
  assert(Number.isSafeInteger(result.focusRequests) && result.focusRequests >= 1 && result.focusRequests <= 3, 'missing actual workload focus acknowledgment');
  const p = profile.workloads, i = p.names.indexOf(result.name);
  assert(i >= 0); assert.deepEqual(p.names,['Task','Long']); assert.deepEqual(p.blocks,[20,2000]);
  assert.deepEqual(p.textUtf8Bytes,[10240,1048576]); assert.equal(p.samples,12); assert.equal(p.warmups,0);
  assert.equal(p.minimumTailSamples,100); assert.deepEqual(p.limits,{inputVisiblePhoneMs:33});
  assert.equal(p.qualification,'unqualified'); assert.equal(result.qualification,'unqualified');
  assert.equal(p.layout,'TextKit1 noncontiguous layout enabled; initial full container layout outside input window; measured one-unit changed-character layout with retained full corpus and caret geometry');
  assert(Number.isFinite(Date.parse(p.layoutReviewedAt))&&Date.parse(p.layoutReviewedAt)<=Date.parse(receipt.startedUtc));
  assert.equal(result.setup.allowsNonContiguousLayout,true,'missing incremental TextKit mode');
  assert.equal(receipt.state,'diagnostic-delivered'); assert.equal(receipt.cleanup.simulatorDeleted,true);
  assert.equal(receipt.metadata.physical,false); assert.equal(receipt.metadata.runtime.identifier,profile.runtime);
  const counts={executed:3,passed:3,failed:0,skipped:0};
  assert.deepEqual(result.counts,counts); assert.deepEqual(receipt.workloadCounts[result.name],counts);
  assert.deepEqual(result.cases.map(c=>[c.id,c.state]),['full-corpus-os-keyboard','exact-checkpoint-reopen','resources-and-disposal'].map(id=>[id,'passed']));
  assert.deepEqual(result.errors,[]); assert.equal(result.typed,profile.typed);
  assert.deepEqual(projectedSemantics(initial),expectedSemantics(fixture));
  const expected=expectedSemantics(fixture), last=expected.at(-1);
  const target=overwriteTarget(last.text,'end');
  assert.equal(result.setup.nodeOffsetUtf16,target.at); assert.equal(result.setup.originalTarget,target.original);
  last.text=last.text.slice(0,target.at)+'l'+last.text.slice(target.at+1); last.runs[0].text=last.text;
  assert.deepEqual(projectedSemantics(final),expected); const committed=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['revision','changedNodes','touchedRanges'].includes(k)));
  assert.deepEqual(committed(reopened),committed(final)); assert.equal(final.revision,12); assert.equal(reopened.revision,0);
  assert(checkpoint.length>0); assert.deepEqual(metadata.identity,final.identity);
  const setup=result.setup, text=fixture.blocks.map(b=>b.runs.map(r=>r.text).join(''));
  assert.equal(setup.blocks,p.blocks[i]); assert.equal(fixture.blocks.length,p.blocks[i]);
  assert.equal(setup.textUtf8Bytes,p.textUtf8Bytes[i]); assert.equal(setup.textUtf8Bytes,text.reduce((n,t)=>n+Buffer.byteLength(t),0));
  assert.equal(setup.textUtf16Units,text.reduce((n,t)=>n+t.length,0)); assert.equal(setup.projectedUtf16Units,text.join('\n').length);
  assert.equal(setup.targetOffsetUtf16,text.join('\n').length-text.at(-1).length+target.at);
  assert.equal(p.scenario,'os-keyboard-overwrite-fixed-corpus-v1');
  assert(Number.isFinite(Date.parse(p.reviewedAt))&&Date.parse(p.reviewedAt)<=Date.parse(receipt.startedUtc));
  assert.equal(receipt.metadata.node,'v24.19.0');
  assert.equal(setup.fullSnapshotRestored,true); assert(setup.checkpointBytes>0);
  assert(finite(setup.restoreStartAt)&&setup.restoreStartAt<=setup.restoredAt&&setup.restoredAt<=setup.projectionLayoutDoneAt);
  assert.equal(result.samples.length,12);
  inspectNativeEditWindows(result.samples,result.resources);
  for(const [j,s] of result.samples.entries()) {
    const times=['inputAt','engineDoneAt','projectionDoneAt','layoutStartAt','layoutDoneAt'].map(k=>s[k]);
    assert(times.every(finite)&&times.every((t,k)=>k===0||t>=times[k-1]));
    const spans=['inputAt','anchorDoneAt','focusDoneAt','batchStartAt','engineDoneAt','decodedAt','storageDoneAt','selectionDoneAt','scrollDoneAt','projectionDoneAt'].map(k=>s[k]);
    assert(spans.every(finite)&&spans.every((t,k)=>k===0||t>=spans[k-1]),'native attribution timeline');
    assert.equal(s.rustTrace?.version,1,'missing native Rust trace version');
    const rustKeys=['prepareMs','commitMs','patchBuildMs','patchJsonMs','resultJsonMs'];
    assert(rustKeys.every(k=>finite(s.rustTrace[k])),'missing native Rust span');
    const rustTotal=rustKeys.reduce((sum,k)=>sum+s.rustTrace[k],0);
    assert(rustTotal<=(s.engineDoneAt-s.batchStartAt)*1000+0.1,'Rust spans exceed enclosing actual FFI call');
    assert.deepEqual(s.layoutRangeUtf16,[setup.targetOffsetUtf16,1],'changed-character layout range');
    assert.equal(s.changedBlocks,1); assert.equal(s.replacementUtf16,1); assert.equal(s.rangeUtf16,setup.targetOffsetUtf16); assert.equal(s.removedUtf16,1);
    assert.equal(s.firstResponder,true); assert.equal(s.firstResponderAtFrame,true); assert.equal(s.inputMode,'en-US');
    assert(geometry(s.caretRect)); assert([0,1,2,3].includes(s.thermal)); assert(s.targetTimestamp>s.displayTimestamp);
  }
  assert.deepEqual(result.resources.map(r=>r.phase),['before-restore','after-projection-layout',...Array.from({length:12},(_,i)=>`input-${i+1}`),'before-disposal','after-disposal']);
  for(const [j,r] of result.resources.entries()) {
    assert.equal(r.status,0); assert(Number.isSafeInteger(r.residentBytes)&&r.residentBytes>0);
    assert(Number.isSafeInteger(r.virtualBytes)&&r.virtualBytes>=r.residentBytes); assert(finite(r.at));
    assert(j===0||r.at>=result.resources[j-1].at);
  }
  assert.equal(result.host.physical,false); assert.equal(result.host.system,'26.5'); assert(result.host.refreshMaximum>0);
  assert.deepEqual(result.gaps,['plain-text projection; mixed-block native renderer not qualified','callback is not compositor','12 samples below 100-sample tail minimum','sampled resident memory is not peak or plateau','no VoiceOver or physical thermal claim']);
  return {qualification:'unqualified',name:result.name,sizes:setup,limits:p.limits,
    restoration:{scope:'every snapshot field except session-local revision/changedNodes/touchedRanges; raw snapshots retained',beforeRevision:final.revision,reopenedRevision:reopened.revision},
    inputToLayoutCallbackMs:rawSummary(result.samples.map(s=>(s.layoutDoneAt-s.inputAt)*1000),100),
    nativeCommitMs:rawSummary(result.samples.map(s=>(s.engineDoneAt-s.inputAt)*1000),100),
    anchorMs:rawSummary(result.samples.map(s=>(s.anchorDoneAt-s.inputAt)*1000),100),
    focusMs:rawSummary(result.samples.map(s=>(s.focusDoneAt-s.anchorDoneAt)*1000),100),
    requestConstructionMs:rawSummary(result.samples.map(s=>(s.batchStartAt-s.focusDoneAt)*1000),100),
    callbackWaitMs:rawSummary(result.samples.map(s=>(s.layoutStartAt-s.projectionDoneAt)*1000),100),
    rust:Object.fromEntries(['prepareMs','commitMs','patchBuildMs','patchJsonMs','resultJsonMs'].map(k=>[k,rawSummary(result.samples.map(s=>s.rustTrace[k]),100)])),
    ffiExecutorAndInstrumentationResidualMs:rawSummary(result.samples.map(s=>Math.max(0,(s.engineDoneAt-s.batchStartAt)*1000-['prepareMs','commitMs','patchBuildMs','patchJsonMs','resultJsonMs'].reduce((sum,k)=>sum+s.rustTrace[k],0))),100),
    decodeMs:rawSummary(result.samples.map(s=>(s.decodedAt-s.engineDoneAt)*1000),100),
    projectionMs:rawSummary(result.samples.map(s=>(s.projectionDoneAt-s.decodedAt)*1000),100),
    storageMutationMs:rawSummary(result.samples.map(s=>(s.storageDoneAt-s.decodedAt)*1000),100),
    selectionMs:rawSummary(result.samples.map(s=>(s.selectionDoneAt-s.storageDoneAt)*1000),100),
    scrollMs:rawSummary(result.samples.map(s=>(s.scrollDoneAt-s.selectionDoneAt)*1000),100),
    layoutMs:rawSummary(result.samples.map(s=>(s.layoutDoneAt-s.layoutStartAt)*1000),100),
    resources:result.resources,gaps:result.gaps};
}
