export function percentile(samples, fraction) {
  if (!samples.length || !samples.every(value => Number.isFinite(value) && value >= 0)) throw Error('Expected nonempty finite, nonnegative samples');
  if (!(fraction > 0 && fraction <= 1)) throw Error('Invalid percentile');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarize(runs) {
  if (!runs.length) throw Error('Missing measured runs');
  const summaries = runs.map(samples => ({ count: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) }));
  return { runs: summaries, count: summaries.reduce((sum, run) => sum + run.count, 0),
    p50: percentile(summaries.map(run => run.p50), 0.5), p95: percentile(summaries.map(run => run.p95), 0.5),
    max: Math.max(...summaries.map(run => run.max)) };
}

export function deltaPercent(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return (value / baseline - 1) * 100;
}
