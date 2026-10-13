// Fixed semantic fixture; byte count is exact and does not depend on a provider.
export const seed = 'editac-paste-v1-20261013';
export function fixedPaste(bytes) {
  const prefix='**fixed** é😀 ', size=new TextEncoder().encode(prefix).length;
  if(bytes<size)throw Error('fixture-too-small');return prefix+'x'.repeat(bytes-size);
}
export function summary(samples) {
  const sorted=[...samples].sort((a,b)=>a-b);
  return {count:sorted.length,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],min:sorted[0],max:sorted.at(-1)};
}
