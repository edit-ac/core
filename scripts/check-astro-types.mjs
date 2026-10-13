// Astro's checker has an independent supported TypeScript range. Keep this
// consumer toolchain isolated from the SDK's pinned compiler.
import { check } from '../examples/astro/node_modules/@astrojs/check/dist/index.js';
const failed = await check({ root: new URL('../examples/astro', import.meta.url).pathname,
  watch: false, minimumFailingSeverity: 'error', minimumSeverity: 'hint' });
if (failed === true) process.exitCode = 1;
