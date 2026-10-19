import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Explicit named suites: an unknown name must fail instead of matching zero tests.
const [suite, ...options] = process.argv.slice(2);
const suites = { keyboard: ['tests/browser/keyboard.spec.ts'], recovery: ['tests/browser/entry.spec.ts', 'tests/browser/recovery.spec.ts'], render: ['tests/browser/render.spec.ts'], selection: ['tests/browser/selection.spec.ts'], 'input-policy': ['tests/browser/input-policy.spec.ts'], input: ['tests/browser/input.spec.ts'], reconcile: ['tests/browser/reconcile.spec.ts'], composition: ['tests/browser/composition.spec.ts'], 'composition-remote': ['tests/browser/composition-remote.spec.ts'] };
suites['assistive-dictation'] = ['tests/browser/assistive-dictation.spec.ts'];
suites['assistive-presenter'] = ['tests/browser/assistive-presenter.spec.ts'];
suites['document-search'] = ['tests/browser/document-search.spec.ts'];
suites['reference-presenters'] = ['tests/browser/reference-presenters.spec.ts'];
suites['controlled-embeds'] = ['tests/browser/controlled-embeds.spec.ts'];
suites['attachment-actions'] = ['tests/browser/attachment-actions.spec.ts'];
suites['image-lifecycle'] = ['tests/browser/image-lifecycle.spec.ts'];
suites['mobile-extension-formatting'] = ['tests/browser/mobile-extension-formatting.spec.ts'];
suites['extension-formatting'] = ['tests/browser/extension-formatting.spec.ts','tests/browser/extension-formatting-mixed.spec.ts'];
suites['registered-inline-transfer'] = ['tests/browser/registered-inline-transfer.spec.ts'];
suites['shared-rich-transfer'] = [...suites['extension-formatting'], ...suites['registered-inline-transfer']];
suites['table-invalidation'] = ['tests/browser/table-invalidation.spec.ts'];
suites['table-selection'] = ['tests/browser/table-selection.spec.ts'];
suites['table-command'] = ['tests/browser/table-command.spec.ts'];
suites['code-highlight'] = ['tests/browser/code-highlight.spec.ts'];
suites['offline-collaboration'] = ['tests/browser/offline-collaboration.spec.ts'];
suites['markdown-collaboration'] = ['tests/browser/markdown-collaboration.spec.ts'];
suites['clipboard-formats'] = ['tests/browser/clipboard-formats.spec.ts'];
suites['shortcuts'] = ['tests/browser/shortcuts.spec.ts'];
suites['large-paste'] = ['tests/browser/large-paste.spec.ts'];
suites['html-paste'] = ['tests/browser/html-paste.spec.ts'];
suites['markdown-extensions'] = ['tests/browser/markdown-extensions.spec.ts'];
suites['math'] = ['tests/browser/math.spec.ts'];
suites['content-modules'] = ['tests/browser/content-modules.spec.ts'];
suites['reorder-pointer'] = ['tests/browser/reorder-pointer.spec.ts'];
suites['reorder'] = ['tests/browser/reorder.spec.ts'];
suites['link-enrichment'] = ['tests/browser/link-enrichment.spec.ts'];
suites['private-link-display'] = ['tests/browser/private-link-display.spec.ts'];
suites['references'] = ['tests/browser/references.spec.ts'];
suites['interaction-text-transfer'] = ['tests/browser/interactions/text-transfer.spec.ts'];
suites['interaction-text-drag'] = ['tests/browser/interactions/text-drag.spec.ts'];
suites['interaction-pointer-selection'] = ['tests/browser/interactions/pointer-selection.spec.ts'];
suites['interaction-accessibility'] = ['tests/browser/interactions/accessibility.spec.ts'];
suites['interaction-history'] = ['tests/browser/interactions/history.spec.ts'];
suites['interaction-parsing'] = ['tests/browser/interactions/parsing.spec.ts'];
suites['interaction-paste'] = ['tests/browser/interactions/paste.spec.ts', 'tests/browser/interactions/paste-tables.spec.ts'];
suites['interaction-slash'] = ['tests/browser/interactions/slash.spec.ts'];
suites['slash-context'] = ['tests/browser/slash-context.spec.ts'];
suites['slash'] = ['tests/browser/slash.spec.ts'];
suites['module-runtime'] = ['tests/browser/module-runtime.spec.ts'];
suites['module-contract'] = ['tests/browser/module-contract.spec.ts'];
suites['extension-entry'] = ['tests/browser/extension-entry.spec.ts'];
suites['shared-resources'] = ['tests/browser/shared-editor-resources.spec.ts'];
suites['shared-site-resources'] = ['tests/browser/shared-site-resources.spec.ts'];
suites['asset-ingest'] = ['tests/browser/asset-ingest.spec.ts'];
suites['source-table-format'] = ['tests/browser/source-table-format.spec.ts'];
suites['optional-markdown'] = ['tests/browser/optional-markdown.spec.ts'];
suites['markdown-paste'] = ['tests/browser/markdown-paste.spec.ts'];
suites.clipboard = ['tests/browser/clipboard.spec.ts'];
suites.lifecycle = ['tests/browser/lifecycle.spec.ts'];
suites.sdk = ['tests/browser/sdk.spec.ts'];
suites.astro = ['tests/browser/astro.spec.ts'];
suites.react = ['tests/browser/react.spec.ts', 'tests/react-ssr.test.mjs'];
suites.dispose = ['tests/browser/dispose.spec.ts'];
suites.accessibility = ['tests/browser/accessibility.spec.ts'];
suites.example = ['tests/browser/web-example.test.mjs'];
suites.review = ['tests/browser/review.spec.ts'];
suites['review-concurrent'] = ['tests/browser/review-concurrent.spec.ts'];
suites['capture-compare'] = ['tests/browser/capture-compare.spec.ts'];
suites['history-review'] = ['tests/browser/history-review.spec.ts'];
suites['editing-presenters'] = ['tests/browser/editing-presenters.spec.ts'];
suites['editing-lifetime'] = ['tests/browser/editing-lifetime.spec.ts'];
suites['interaction-whitespace'] = ['tests/browser/interactions/whitespace.spec.ts'];
suites['interaction-command-surfaces'] = ['tests/browser/interactions/command-surfaces.spec.ts'];
suites['interaction-replacement'] = ['tests/browser/interactions/replacement.spec.ts'];
suites['interaction-keyboard'] = ['tests/browser/interactions/keyboard.spec.ts'];
suites['interaction-keyboard-tables'] = ['tests/browser/interactions/keyboard-tables.spec.ts'];
suites['interaction-navigation'] = ['tests/browser/interactions/navigation.spec.ts'];
suites['interaction-deletion'] = ['tests/browser/interactions/deletion.spec.ts'];
suites['interaction-formatting'] = ['tests/browser/interactions/formatting.spec.ts'];
suites['interaction-breaks'] = ['tests/browser/interactions/breaks.spec.ts'];
suites['interaction-break-tables'] = ['tests/browser/interactions/break-tables.spec.ts'];
suites['interaction-cell-multiline'] = ['tests/browser/interactions/cell-multiline.spec.ts'];
suites['interaction-harness'] = ['tests/browser/interactions/harness.spec.ts'];
suites['editing-input'] = ['tests/browser/editing-input.spec.ts'];
suites['history-selection'] = ['tests/browser/history-selection.spec.ts'];
suites['agent-realtime'] = ['tests/browser/agent-realtime.spec.ts'];
suites.baseline = [...suites.render, ...suites.keyboard, ...suites.example];
if (!suites[suite]) throw new Error(`Expected browser suite: ${Object.keys(suites).join(', ')}`);
if (suite === 'baseline' && options.length) {
  throw new Error('The baseline gate requires the complete renderer, keyboard and example suites');
}
const engines = !['recovery', 'offline-collaboration'].includes(suite) ? ['chromium', 'firefox', 'webkit'] : [null];
for (const engine of engines) {
  const env = { ...process.env };
  if (engine) {
    for (const group of suite === 'baseline' ? ['render', 'keyboard', 'example'] : suite === 'interaction-paste' ? [suite,'interaction-paste-tables'] : ['extension-formatting','shared-rich-transfer'].includes(suite) ? ['extension-formatting','extension-formatting-mixed',...(suite==='shared-rich-transfer'?['registered-inline-transfer']:[])] : suite === 'slash-context' ? [suite,'interaction-slash'] : [suite]) {
      const key = `EDITAC_${group.toUpperCase().replaceAll("-", "_")}`;
      env[`${key}_BROWSER`] = engine;
      if (suite === 'baseline' && env.EDITAC_BASELINE_OUTPUT) env[`${key}_OUTPUT`] = join(env.EDITAC_BASELINE_OUTPUT, engine, group);
      else if (group === 'interaction-slash' && suite === 'slash-context' && env.EDITAC_SLASH_CONTEXT_OUTPUT) env[`${key}_OUTPUT`] = join(process.env.EDITAC_SLASH_CONTEXT_OUTPUT, engine, 'baseline');
      else if (suite === 'shared-rich-transfer' && env.EDITAC_SHARED_RICH_TRANSFER_OUTPUT) env[`${key}_OUTPUT`] = join(process.env.EDITAC_SHARED_RICH_TRANSFER_OUTPUT, engine, group);
      else if (group === 'extension-formatting-mixed' && env.EDITAC_EXTENSION_FORMATTING_OUTPUT) env[`${key}_OUTPUT`] = join(process.env.EDITAC_EXTENSION_FORMATTING_OUTPUT, engine, 'mixed');
      else if (env[`${key}_OUTPUT`]) env[`${key}_OUTPUT`] = join(env[`${key}_OUTPUT`], engine);
    }
    console.log(`${suite} browser: ${engine}`);
  }
  const result = spawnSync(process.execPath, ['--test', ...(suite === 'baseline' ? ['--test-concurrency=1'] : []), ...(suite === 'baseline' || process.env.EDITAC_EDITING_ALL_OUTPUT ? ['--test-reporter=tap'] : []), ...options, ...suites[suite]], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
