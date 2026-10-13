import { summarize, deltaPercent } from './statistics.mjs';

export function compatible(current, baseline) {
  return current.version === baseline.version && JSON.stringify(current.signature) === JSON.stringify(baseline.signature);
}

export function aggregate(result, config, baseline) {
  if (result.errors.length) throw Error('Cannot aggregate a failed run');
  if (!result.plan.metrics.length || !Number.isInteger(result.plan.runs) || result.plan.runs < 1) throw Error('Expected a nonempty measurement plan');
  const metrics = {};
  const expected = result.plan.metrics;
  for (const name of expected) {
    const runs = result.cases.filter(item => item.measured).map(item => item.metrics[name]).filter(Boolean);
    if (runs.length !== result.plan.runs) throw Error(`Missing measured runs for ${name}: ${runs.length}/${result.plan.runs}`);
    if (runs.some(samples => samples.length !== result.plan.sampleCounts[name])) throw Error(`Incomplete sample count for ${name}`);
    metrics[name] = summarize(runs);
  }
  const comparable = baseline && compatible(result, baseline);
  const findings = [];
  for (const [name, metric] of Object.entries(metrics)) {
    const budget = config.budgets[name] ?? (name.startsWith('typing.') ? config.budgets[name.split('.').slice(0, 2).join('.')]
      : name.startsWith('load.') && name.endsWith('.cold') ? config.budgets['load.cold'] : undefined);
    if (budget !== undefined && metric.p95 > budget) findings.push({ name, severity: 'budget', value: metric.p95, limit: budget });
    if (name.startsWith('typing.large') && metric.p95 > config.hardTypingLimitMs) findings.push({ name, severity: 'hard', value: metric.p95, limit: config.hardTypingLimitMs });
    metric.deltaPercent = comparable ? deltaPercent(metric.p95, baseline.metrics?.[name]?.p95) : null;
    if (metric.deltaPercent > config.latencyGrowthPercent) findings.push({ name, severity: 'regression', value: metric.deltaPercent, limit: config.latencyGrowthPercent });
  }
  for (const [name, bundle] of Object.entries(result.bundles)) {
    const key = `bundle.${name}`;
    if (bundle.brotliBytes > config.budgets[key]) findings.push({ name: key, severity: 'budget', value: bundle.brotliBytes, limit: config.budgets[key] });
    // Compression and entry point compatibility matter; timings need matching hardware as well.
    bundle.deltaPercent = baseline?.version === result.version && baseline?.bundleVersion === result.bundleVersion
      ? deltaPercent(bundle.brotliBytes, baseline.bundles?.[name]?.brotliBytes) : null;
    if (bundle.deltaPercent > config.bundleGrowthPercent) findings.push({ name: key, severity: 'regression', value: bundle.deltaPercent, limit: config.bundleGrowthPercent });
  }
  return { metrics, findings, comparison: !baseline ? 'No previous baseline' : comparable ? 'Compatible previous baseline' : 'Timing baseline incompatible; deltas omitted' };
}

export function markdown(result) {
  const rows = Object.entries(result.metrics ?? result.partialMetrics ?? {}).map(([name, value]) => `| ${name} | ${value.p50.toFixed(2)} | ${value.p95.toFixed(2)} | ${value.deltaPercent === null ? '—' : `${value.deltaPercent.toFixed(1)}%`} | ${value.count} |`);
  const sizes = Object.entries(result.bundles ?? {}).map(([name, value]) => `| ${name} | ${(value.gzipBytes / 1024).toFixed(1)} | ${(value.brotliBytes / 1024).toFixed(1)} | ${value.deltaPercent == null ? '—' : `${value.deltaPercent.toFixed(1)}%`} |`);
  const memoryRows = result.cases.filter(item => item.memory?.afterEdits).map(item => {
    const m = item.memory, mb = bytes => (bytes / 1048576).toFixed(1);
    const cycle = m.cycles?.at(-1);
    return `| ${item.measured ? 'measured' : 'warmup'} ${item.iteration + 1} | ${mb(m.loaded.usedSize)} | ${mb(m.afterEdits.usedSize)} | ${mb(m.afterEdits.usedSize - m.afterLargeOperations.usedSize)} | ${mb(m.afterEdits.backingStorageSize ?? 0)} | ${cycle ? mb(cycle.usedSize) : '—'} |`;
  });
  const memoryTable = memoryRows.length ? `\n| Memory snapshot | JS loaded MiB | JS after edits MiB | Edit growth MiB | Backing storage MiB | JS after cycles MiB |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${memoryRows.join('\n')}\n` : '\nMemory samples not yet available.\n';
  return `# edit.ac regression benchmarks\n\nStatus: **${result.status}** · ${result.mode} · ${result.metadata.revision} · dirty: ${result.metadata.dirty}\n\n${result.comparison ?? result.partialMetricsProvenance ?? 'Run incomplete'}\n\nChromium ${result.metadata.browser ?? 'unavailable'} · Playwright ${result.metadata.playwright} · Node ${result.metadata.node} · ${result.metadata.platform}/${result.metadata.arch}\n\nDispatch → synchronous DOM + layout; these timings do not include compositor paint or OS input. Cold startup includes module/WASM loading; warm startup reuses the initialized runtime. All correctness assertions must pass.\n\n| Metric (ms) | Median p50 | Median p95 | Previous p95 delta | Samples |\n| --- | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n| Production bundle | Gzip KiB | Brotli KiB | Previous delta |\n| --- | ---: | ---: | ---: |\n${sizes.join('\n')}\n\n${(result.findings ?? []).map(item => `- ${item.severity}: ${item.name} = ${item.value.toFixed(2)}, limit ${item.limit}`).join('\n')}\n${result.errors.map(error => `- Error: ${error}`).join('\n')}\n\n${memoryTable}\nMemory is diagnostic. Backing storage includes external buffers and is not exclusively WASM. No absolute memory gate is accepted yet. Structured fixtures cover nested lists, headings and code; tables and virtualization are not qualified here. React wrapper: ${result.deferred?.reactWrapper ?? "unmeasured"}. Peer React framework bytes are excluded. Tiptap and Lexical comparisons: **not yet measured**.\n\nQuick runs are development diagnostics, not performance qualification or approved baselines. JSON retains measured runs and discarded warmups, fixture and artifact hashes, and cleanup evidence.\n`;
}
