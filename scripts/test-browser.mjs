import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Explicit named suites: an unknown name must fail instead of matching zero tests.
const [suite, ...options] = process.argv.slice(2);
const suites = { keyboard: ['tests/browser/keyboard.spec.ts'], recovery: ['tests/browser/entry.spec.ts', 'tests/browser/recovery.spec.ts'], render: ['tests/browser/render.spec.ts'], selection: ['tests/browser/selection.spec.ts'], 'input-policy': ['tests/browser/input-policy.spec.ts'], input: ['tests/browser/input.spec.ts'], reconcile: ['tests/browser/reconcile.spec.ts'], composition: ['tests/browser/composition.spec.ts'], 'composition-remote': ['tests/browser/composition-remote.spec.ts'] };
suites['offline-collaboration'] = ['tests/browser/offline-collaboration.spec.ts'];
suites['markdown-collaboration'] = ['tests/browser/markdown-collaboration.spec.ts'];
suites['clipboard-formats'] = ['tests/browser/clipboard-formats.spec.ts'];
suites['shortcuts'] = ['tests/browser/shortcuts.spec.ts'];
suites['large-paste'] = ['tests/browser/large-paste.spec.ts'];
suites['html-paste'] = ['tests/browser/html-paste.spec.ts'];
suites['markdown-extensions'] = ['tests/browser/markdown-extensions.spec.ts'];
suites['math'] = ['tests/browser/math.spec.ts'];
suites['content-modules'] = ['tests/browser/content-modules.spec.ts'];
suites['reorder'] = ['tests/browser/reorder.spec.ts'];
suites['references'] = ['tests/browser/references.spec.ts'];
suites['slash'] = ['tests/browser/slash.spec.ts'];
suites['module-runtime'] = ['tests/browser/module-runtime.spec.ts'];
suites['module-contract'] = ['tests/browser/module-contract.spec.ts'];
suites['extension-entry'] = ['tests/browser/extension-entry.spec.ts'];
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
suites['history-review'] = ['tests/browser/history-review.spec.ts'];
suites['history-selection'] = ['tests/browser/history-selection.spec.ts'];
suites.baseline = [...suites.render, ...suites.keyboard, ...suites.example];
if (!suites[suite]) throw new Error(`Expected browser suite: ${Object.keys(suites).join(', ')}`);
if (suite === 'baseline' && options.length) {
  throw new Error('The baseline gate requires the complete renderer, keyboard and example suites');
}
const engines = !['recovery', 'offline-collaboration'].includes(suite) ? ['chromium', 'firefox', 'webkit'] : [null];
for (const engine of engines) {
  const env = { ...process.env };
  if (engine) {
    for (const group of suite === 'baseline' ? ['render', 'keyboard', 'example'] : [suite]) {
      const key = `EDITAC_${group.toUpperCase().replaceAll("-", "_")}`;
      env[`${key}_BROWSER`] = engine;
      if (suite === 'baseline' && env.EDITAC_BASELINE_OUTPUT) env[`${key}_OUTPUT`] = join(env.EDITAC_BASELINE_OUTPUT, engine, group);
      else if (env[`${key}_OUTPUT`]) env[`${key}_OUTPUT`] = join(env[`${key}_OUTPUT`], engine);
    }
    console.log(`${suite} browser: ${engine}`);
  }
  const result = spawnSync(process.execPath, ['--test', ...(suite === 'baseline' ? ['--test-concurrency=1', '--test-reporter=tap'] : []), ...options, ...suites[suite]], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
