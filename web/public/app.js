// Vanilla JS on purpose — no framework, no build step, no CDN script. Fetches
// the one JSON endpoint once on load and renders three views from it: the
// runs table, a cost trend chart, and the aggregate cost breakdown. See
// DECISIONS.md for why this stays this narrow in v1.

const usd = (n) => `$${n.toFixed(6)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const int = (n) => Math.round(n).toLocaleString('en-US');

function relativeTime(ms) {
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function renderHeader(breakdowns) {
  document.getElementById('header').textContent = `${breakdowns.length} run(s)`;
}

function renderRunsTable(breakdowns) {
  const table = document.getElementById('runs-table');
  table.replaceChildren();

  const head = el('tr', {}, [
    el('th', { textContent: 'id' }),
    el('th', { textContent: 'name' }),
    el('th', { textContent: 'status' }),
    el('th', { textContent: 'started' }),
    el('th', { textContent: 'tokens' }),
    el('th', { textContent: 'cost' }),
  ]);
  table.append(el('thead', {}, [head]));

  const body = el('tbody');
  for (const run of breakdowns) {
    body.append(
      el('tr', {}, [
        el('td', { textContent: run.runId.slice(0, 8) }),
        el('td', { textContent: run.name }),
        el('td', { textContent: run.status }),
        el('td', { textContent: relativeTime(run.startedAt) }),
        el('td', { textContent: int(run.totalInputTokens + run.totalOutputTokens) }),
        el('td', { textContent: usd(run.totalCostUsd) }),
      ]),
    );
  }
  table.append(body);
}

function renderTrend(breakdowns) {
  const container = document.getElementById('trend');
  container.replaceChildren();

  if (breakdowns.length === 0) {
    container.append(el('p', { className: 'muted', textContent: '(no runs to trend)' }));
    return;
  }

  const chronological = [...breakdowns].reverse();
  const costs = chronological.map((run) => run.totalCostUsd);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const avg = costs.reduce((sum, c) => sum + c, 0) / costs.length;
  const flat = max === min;

  const width = 100;
  const height = 60;
  const barGap = 2;
  const barWidth = costs.length > 0 ? width / costs.length - barGap : width;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  costs.forEach((cost, i) => {
    const level = flat ? 0.1 : (cost - min) / (max - min);
    const barHeight = Math.max(1, level * height);
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('class', 'bar');
    rect.setAttribute('x', String(i * (barWidth + barGap)));
    rect.setAttribute('y', String(height - barHeight));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(barHeight));
    const title = document.createElementNS(svgNs, 'title');
    title.textContent = `${usd(cost)} — ${new Date(chronological[i].startedAt).toLocaleString()}`;
    rect.append(title);
    svg.append(rect);
  });

  container.append(svg);
  container.append(
    el('p', {
      className: 'trend-summary',
      textContent: `oldest → newest, ${chronological.length} runs — min ${usd(min)}  ·  max ${usd(max)}  ·  avg ${usd(avg)}`,
    }),
  );
}

function renderBreakdown(aggregate) {
  const summary = document.getElementById('breakdown-summary');
  const label = aggregate.runName ? `"${aggregate.runName}"` : 'all runs';
  const lines = [];
  lines.push(`last ${aggregate.runCount} runs of ${label} · ${aggregate.llmCallCount} llm calls`);

  if (aggregate.pricingMode === 'hypothetical') {
    lines.push(`⚠⚠ HYPOTHETICAL COST — priced as ${aggregate.pricedAsModel}, NOT real spend ⚠⚠`);
  } else if (aggregate.pricingMode === 'mixed') {
    lines.push('⚠⚠ MIXED PRICING BASES — these runs were not all priced the same way ⚠⚠');
  }

  lines.push(
    `input ${int(aggregate.totalInputTokens)} tok · output ${int(aggregate.totalOutputTokens)} tok · total ${usd(aggregate.totalCostUsd)}`,
  );

  if (aggregate.cacheSupport === 'no') {
    lines.push('cache: not applicable — none of these runs used a provider with a caching concept.');
  } else if (aggregate.cacheSupport === 'mixed') {
    lines.push('note: some runs used a provider with no caching concept — see per-run breakdown.');
  }

  summary.replaceChildren(...lines.flatMap((line, i) => (i === 0 ? [line] : ['\n', line])));

  const table = document.getElementById('breakdown-table');
  table.replaceChildren();
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'segment' }),
        el('th', { textContent: 'avg/run' }),
        el('th', { textContent: 'pooled' }),
        el('th', { textContent: 'tokens' }),
        el('th', { textContent: 'cost' }),
      ]),
    ]),
  );

  const body = el('tbody');
  for (const segment of aggregate.segments) {
    if (segment.tokens < 0.5) continue;
    body.append(
      el('tr', {}, [
        el('td', { textContent: segment.label }),
        el('td', { textContent: pct(segment.meanRunShare) }),
        el('td', { textContent: pct(segment.pooledShare) }),
        el('td', { textContent: int(segment.tokens) }),
        el('td', { textContent: usd(segment.costUsd) }),
      ]),
    );
  }
  table.append(body);
}

async function main() {
  const res = await fetch('/api/summary');
  if (!res.ok) {
    document.getElementById('header').textContent = `fyren: request failed (${res.status})`;
    return;
  }
  const { breakdowns, aggregate } = await res.json();

  if (breakdowns.length === 0) {
    document.getElementById('header').textContent =
      'fyren: no runs found. Record one first — see examples/basic-run.ts.';
    return;
  }

  renderHeader(breakdowns);
  renderRunsTable(breakdowns);
  renderTrend(breakdowns);
  renderBreakdown(aggregate);
}

main().catch((err) => {
  document.getElementById('header').textContent = `fyren: ${err instanceof Error ? err.message : String(err)}`;
});
