import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { waitForOptionalBootstrap } from '../scripts/optional-loading-latency.mjs';

test('optional module bootstrap remains observable while animation frames are suspended', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script>
      window.requestAnimationFrame = () => {
        setTimeout(() => { window.loadingRun = Promise.resolve({ ready: true }); }, 0);
        return 0;
      };
    </script>`);
    // The old wait can never observe readiness in this environment.
    await assert.rejects(page.waitForFunction(() => !!window.loadingRun, undefined, { timeout: 150 }), /Timeout/);
    await waitForOptionalBootstrap(page);
    assert.deepEqual(await page.evaluate(() => window.loadingRun), { ready: true });
  } finally { await browser.close(); }
});
