import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as human from './host-agent-product-human.mjs';
export async function modelCases(check,context){
  await human.modelCases(check,context);
  await check('composed-current-services',async()=>{
    const inventory=await context.server.owner.inventory();
    assert.deepEqual(inventory.tools.map(t=>t.name).sort(),['editac_v1_observe','editac_v1_read']);
    assert.ok(inventory.scope.documentId);
    context.facts.workspace={currentTools:inventory.tools.map(t=>t.name),actualOwner:true};
  });
}
export async function browserCases(context){
  await human.browserCases(context);
  const {page,server,check,facts}=context;
  const click=async id=>{await page.locator('#'+id).click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&!document.querySelector('#human-scope').disabled);};
  await check('workspace-discover-edit-read',async()=>{
    assert.match(await page.title(),/host-agent workspace/);
    assert.equal(await page.locator('#human-publish').isDisabled(),true);
    assert.equal(await page.locator('#human-pull').isDisabled(),true);
    assert.equal(await page.locator('#human-undo').isDisabled(),true);
    await click('refresh');
    assert.deepEqual(await page.locator('#tools li').allTextContents(),['read: available','prepare: unavailable','apply: unavailable','receipt: unavailable','observe: available']);
    await click('human-open');
    const before=await page.evaluate(()=>window.humanWorkspace.evidence());
    await page.locator('#human-editor').click();await page.keyboard.press('Home');await page.keyboard.type('WORKSPACE');
    await click('human-publish');await click('read');
    const after=await page.evaluate(()=>window.humanWorkspace.evidence()),owner=await server.owner.send({op:'state'});
    assert.deepEqual(after.texts,owner.texts);assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.ids,before.ids);
    assert.equal(after.texts.join('').length,before.texts.join('').length+9);
    const source=after.texts.join('\n\n')+'\n',meta=JSON.parse(await page.locator('#export-metadata').textContent());
    assert.equal(await page.locator('#export-source').textContent(),source);
    assert.equal(meta.sourceHash,'sha256:'+createHash('sha256').update(source).digest('hex'));
    assert.equal(meta.revision,owner.revision);assert.ok(after.journal.length>0);assert.ok(after.history.undoGroups>0);
    assert.equal(after.storage.saved,true);assert.equal(await page.locator('#human-undo').isDisabled(),false);
    facts.composed={identity:after.identity,revision:owner.revision,sourceHash:meta.sourceHash,journal:after.journal.length,history:after.history};
  });
  await check('workspace-unavailable-controls',async()=>{
    await click('human-close');
    for(const id of ['human-pull','human-publish','human-undo','human-close'])assert.equal(await page.locator('#'+id).isDisabled(),true,id);
    await page.locator('#policy').selectOption('revoked');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    assert.equal(await page.locator('#read').isDisabled(),true);assert.equal(await page.locator('#copy').isDisabled(),true);
    assert.equal(await page.locator('#export-source').textContent(),'');
    assert.equal(await page.locator('#human-open').isDisabled(),true);assert.equal(await page.evaluate(()=>window.humanWorkspace.mounted),false);
    for(const id of ['human-pull','human-publish','human-undo','human-close'])assert.equal(await page.locator('#'+id).isDisabled(),true,id);
    await page.locator('#policy').selectOption('authorized');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    await click('human-open');assert.equal(await page.evaluate(()=>window.humanWorkspace.mounted),true);
    await page.locator('#policy').selectOption('revoked');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&!document.querySelector('#human-scope').disabled);
    assert.equal(await page.evaluate(()=>window.humanWorkspace.mounted),false);assert.equal(await page.locator('#human-editor').textContent(),'');
    assert.equal(await page.locator('#human-publish').isDisabled(),true);
    await page.locator('#policy').selectOption('authorized');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    await click('human-open');await click('human-close');
  });
}
