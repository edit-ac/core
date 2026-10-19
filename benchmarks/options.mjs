import { fixtureSizes } from './fixtures.mjs';

export function options(args) {
  const result = { quick: false, enforce: false, fixtures: Object.keys(fixtureSizes), build: true, presets: ['baseline'] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--quick') result.quick = true;
    else if (argument === '--fitness') result.fitness = true;
    else if (argument === '--prepare-only') result.prepareOnly = true;
    else if (argument === '--enforce') result.enforce = true;
    else if (['--baseline', '--save-baseline', '--output', '--fixtures', '--presets', '--seed-directory'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${argument}`);
      result[{ '--baseline': 'baseline', '--save-baseline': 'saveBaseline', '--output': 'output', '--fixtures': 'fixtures', '--presets': 'presets', '--seed-directory': 'seedDirectory' }[argument]] = ['--fixtures', '--presets'].includes(argument) ? value.split(',') : value;
    } else throw Error(`Unknown benchmark option ${argument}`);
  }
  if (!result.fixtures.length || new Set(result.fixtures).size !== result.fixtures.length || result.fixtures.some(name => !fixtureSizes[name])) throw Error('Expected unique, known fixtures');
  if (!result.presets.length || new Set(result.presets).size !== result.presets.length || result.presets.some(name => !['baseline', 'task'].includes(name))) throw Error('Expected unique, known presets');
  if (result.saveBaseline && (result.quick || result.fixtures.length !== Object.keys(fixtureSizes).length)) throw Error('Only a complete full run can save a baseline');
  if (result.prepareOnly && (!result.fitness || result.fixtures.length !== 2 || !['Task', 'Long'].every(name => result.fixtures.includes(name))
    || result.baseline || result.saveBaseline || result.enforce)) throw Error('Seed preparation requires the full fitness Task/Long fixtures and cannot compare, enforce or save a baseline');
  return result;
}
