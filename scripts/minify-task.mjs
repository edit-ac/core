import { minify } from 'terser';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const taskMinifier = Object.freeze({ name: 'terser', version: require('terser/package.json').version,
  module: true, compress: { passes: 3 }, mangle: true, format: { comments: false } });
/** Standard compression and lexical renaming only. Public properties, required
 * features and runtime checks stay intact; unsafe transforms are not enabled. */
export async function minifyTask(source) {
  const { name, version, ...options } = taskMinifier;
  const result = await minify(source, options);
  if (!result.code) throw new Error('Task minifier produced no executable code');
  return result.code + '\n';
}
