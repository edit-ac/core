import assert from 'node:assert/strict';
import { rawSummary } from './architecture-budgets.mjs';
const finite = n => Number.isFinite(n) && n >= 0;
const geometry = r => r && ['x','y','width','height'].every(k => Number.isFinite(r[k])) && r.width >= 0 && r.height > 0;
export function inspectNativeInput(profile, receipt, result, accessibility) {
  assert.equal(profile.id, 'native-input-v1'); assert.equal(profile.version, 1);
  assert.equal(profile.scenario, 'ascii-keyboard-append/native-marked-cancel/checkpoint-reopen/accessibility-query-v1');
  assert.equal(profile.device, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17');
  assert.equal(profile.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(profile.runtimeBuildVersion, '23F77'); assert.equal(profile.initialTextUtf8Bytes, 9); assert.equal(profile.initialUtf16Units, 6);
  assert.equal(profile.fixture, 'tests/native/fixtures/bounded-abi.json');
  assert.deepEqual(profile.features, ['v5-native-engine','UITextView-TextKit1','generated-Swift-FFI','XCTest-OS-keyboard','XCTest-accessibility-client']);
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
  assert.deepEqual(receipt.xctestCounts, {totalTestCount:2,passedTests:2,failedTests:0,skippedTests:0});
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

export function inspectNativeCJK(profile, receipt, result, ax) {
  assert.equal(profile.cjk.scenario,'os-pinyin-ni-candidate-commit/hao-host-cancel/checkpoint-reopen-v1');
  assert.equal(profile.cjk.keyboard,'zh_Hans-Pinyin'); assert.equal(profile.cjk.inputMode,'zh-Hans');
  assert.deepEqual(profile.cjk.commitKeys,['n','i']); assert.deepEqual(profile.cjk.cancelKeys,['h','a','o']);
  assert.equal(profile.cjk.candidate,'你'); assert.equal(profile.cjk.committed,'A😀éZ你'); assert.equal(profile.cjk.samples,1);
  assert.equal(profile.minimumTailSamples,100); assert.equal(profile.qualification,'unqualified');
  assert(Date.parse(profile.reviewedAt) <= Date.parse(receipt.startedUtc));
  assert.equal(receipt.state,'diagnostic-delivered'); assert.equal(receipt.metadata.physical,false);
  assert.equal(receipt.metadata.runtime.identifier,profile.runtime); assert.equal(receipt.cleanup.simulatorDeleted,true);
  assert.deepEqual(receipt.xctestCounts,{totalTestCount:2,passedTests:2,failedTests:0,skippedTests:0});
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
  assert.deepEqual(result.cases[1].observed,{typed:'你',committed:expected,selectionUtf16:expected.length});
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
