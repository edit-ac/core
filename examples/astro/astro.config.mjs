import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
export default defineConfig({
  output: process.env.EDITAC_ASTRO_MODE === 'ssr' ? 'server' : 'static',
  adapter: process.env.EDITAC_ASTRO_MODE === 'ssr' ? node({mode:'standalone'}) : undefined,
  outDir: `./dist-${process.env.EDITAC_ASTRO_MODE ?? 'static'}`,
  vite: { plugins: process.env.PUBLIC_EDITAC_ASTRO_FIXTURE === '1' ? [{ name:'editac-prepared-fixture', transform(code,id) { if(id.endsWith('/src/client.js')) return `import './test-client.js';`; } }] : [], optimizeDeps: { exclude: ['@edit-ac/core', '@edit-ac/web', '@edit-ac/astro'] } },
});
