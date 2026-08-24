// Vanilla JS on purpose — no framework, no build step, no CDN script.
//
// Everything on screen comes from two endpoints (`/api/meta`, `/api/summary`)
// plus one per-run fetch when a row is opened. The browser computes no
// numbers of its own: every figure here is a field the library produced, so
// the UI and the CLI can never quietly disagree about what a run cost.
//
// All text goes in through `textContent`. Run names, model ids and error
// strings are user data that happens to travel through this page, and building
// any of it into innerHTML would make a stray `<` in an agent name a bug.

const SEGMENT_ORDER = ['toolDefs', 'system', 'history', 'toolResults', 'latest'];

const usd = (n) => `$${Number(n).toFixed(6)}`;
const pct = (n) => `${(Number(n) * 100).toFixed(1)}%`;
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');

function relativeTime(ms) {
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function durationOf(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const segmentColor = (segment) => `var(--seg-${Math.max(0, SEGMENT_ORDER.indexOf(segment))})`;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */

const state = {
  meta: null,
  summary: null,
  tab: 'overview',
  selectedRunId: null,
  autoTimer: null,
};

function query() {
  const params = new URLSearchParams();
  params.set('limit', $('filter-limit').value);
  params.set('name', $('filter-name').value);
  params.set('priceAs', $('filter-price-as').value.trim());
  return params.toString();
}

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `request failed (${res.status})`);
  return body;
}

/* ------------------------------------------------------------------- kpis */

function renderKpis(aggregate, waste) {
  const cards = [
    ['total cost', usd(aggregate.totalCostUsd)],
    ['avoidable', usd(waste.totalAvoidableCostUsd), waste.totalAvoidableCostUsd > 0],
    ['input tokens', int(aggregate.totalInputTokens)],
    ['output tokens', int(aggregate.totalOutputTokens)],
    ['runs', int(aggregate.runCount)],
    ['llm calls', int(aggregate.llmCallCount)],
  ];

  $('kpis').replaceChildren(
    ...cards.map(([label, value, warn]) =>
      el('div', { className: warn ? 'kpi is-warn' : 'kpi' }, [
        el('div', { className: 'label', textContent: label }),
        el('div', { className: 'value', textContent: value }),
      ]),
    ),
  );
}

/* ---------------------------------------------------------------- banners */

// The loud labels are not decoration. A hypothetical cost that reads like real
// spend, or a total that silently sums two different pricing bases, is the
// exact failure this project treats as worse than showing nothing.
function renderBanners(aggregate) {
  const banners = [];

  if (aggregate.pricingMode === 'hypothetical') {
    banners.push(
      banner('warn', 'Hypothetical pricing. ', [
        'These costs are this run’s real token counts re-priced at ',
        el('strong', { textContent: aggregate.pricedAsModel ?? 'another model' }),
        '’s rates. This is not money that was spent.',
      ]),
    );
  } else if (aggregate.pricingMode === 'mixed') {
    banners.push(
      banner('warn', 'Mixed pricing bases. ', [
        'These runs were not all priced the same way, so the totals add up numbers that are not comparable. Filter to one agent to fix this.',
      ]),
    );
  }

  if (aggregate.cacheSupport === 'no') {
    banners.push(
      banner('info', 'No prompt caching here. ', [
        'None of these runs used a provider that has a caching concept, so the cache columns read zero because there was nothing to cache — not because a cache was missed.',
      ]),
    );
  } else if (aggregate.cacheSupport === 'mixed') {
    banners.push(
      banner('info', 'Mixed cache support. ', [
        'Some of these runs used a provider with no caching concept. Per-segment cache figures still mean something, just not uniformly across every call.',
      ]),
    );
  }

  if (aggregate.uncertainCacheRunCount > 0) {
    banners.push(
      banner('warn', 'Uncertain cache boundary. ', [
        `${int(aggregate.uncertainCacheRunCount)} run(s) had a call whose cached prefix reached into the latest message. The numbers are still shown, but trust them less.`,
      ]),
    );
  }

  if (aggregate.unattributedInputTokens > 0) {
    banners.push(
      banner('info', 'Partially attributed. ', [
        `${int(aggregate.unattributedInputTokens)} input tokens came from calls with no composition data, so they are excluded from the segment split below.`,
      ]),
    );
  }

  $('banners').replaceChildren(...banners);
}

function banner(kind, lead, rest) {
  return el('div', { className: `banner ${kind}` }, [el('strong', { textContent: lead }), ...rest]);
}

/* ----------------------------------------------------------- composition */

function renderComposition(aggregate) {
  const segments = aggregate.segments.filter((s) => s.tokens >= 0.5);

  $('composition-hint').textContent =
    segments.length === 0
      ? 'No calls in this selection carried input-composition data, so there is nothing to split.'
      : `${int(aggregate.runCount)} run(s), ${int(aggregate.llmCallCount)} llm call(s) — ` +
        `${aggregate.precision === 'measured' ? 'measured with the provider’s token counter' : aggregate.precision === 'mixed' ? 'mixed: some calls measured, some estimated from character counts' : 'estimated from character counts'}.`;

  $('composition-bar').replaceChildren(
    ...segments.map((segment) => {
      const node = el('div', { className: 'seg' });
      node.style.width = `${segment.pooledShare * 100}%`;
      node.style.background = segmentColor(segment.segment);
      node.title = `${segment.label} — ${pct(segment.pooledShare)}, ${int(segment.tokens)} tokens, ${usd(segment.costUsd)}`;
      return node;
    }),
  );

  const table = $('breakdown-table');
  table.replaceChildren(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'segment' }),
        el('th', { className: 'num', textContent: 'avg/run' }),
        el('th', { className: 'num', textContent: 'pooled' }),
        el('th', { className: 'num', textContent: 'tokens' }),
        el('th', { className: 'num', textContent: 'cost' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      segments.map((segment) => {
        const swatch = el('span', { className: 'swatch' });
        swatch.style.background = segmentColor(segment.segment);
        return el('tr', {}, [
          el('td', {}, [swatch, document.createTextNode(segment.label)]),
          el('td', { className: 'num', textContent: pct(segment.meanRunShare) }),
          el('td', { className: 'num', textContent: pct(segment.pooledShare) }),
          el('td', { className: 'num', textContent: int(segment.tokens) }),
          el('td', { className: 'num', textContent: usd(segment.costUsd) }),
        ]);
      }),
    ),
  );
}

/* --------------------------------------------------------------- trend */

function renderTrend(breakdowns) {
  const container = $('trend');
  container.replaceChildren();

  if (breakdowns.length === 0) {
    container.append(el('p', { className: 'empty', textContent: 'No runs to trend.' }));
    return;
  }

  const chronological = [...breakdowns].reverse();
  const costs = chronological.map((run) => run.totalCostUsd);
  const max = Math.max(...costs);
  const avg = costs.reduce((sum, c) => sum + c, 0) / costs.length;

  const width = 100;
  const height = 40;
  const gap = costs.length > 40 ? 0.3 : 1.5;
  const barWidth = Math.max(0.5, width / costs.length - gap);

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });

  costs.forEach((cost, i) => {
    // Bars are drawn against zero, not against the minimum. Scaling from the
    // cheapest run makes a set of nearly identical runs look wildly variable,
    // which is a chart that lies about the thing it is for.
    const level = max > 0 ? cost / max : 0;
    const barHeight = Math.max(0.4, level * height);
    const rect = svg('rect', {
      class: 'bar',
      x: i * (barWidth + gap),
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
    });
    const title = svg('title');
    title.textContent = `${chronological[i].name} — ${usd(cost)} — ${new Date(chronological[i].startedAt).toLocaleString()}`;
    rect.append(title);
    chart.append(rect);
  });

  chart.append(svg('line', { class: 'axis', x1: 0, y1: height, x2: width, y2: height }));

  container.append(chart);
  container.append(
    el('p', {
      className: 'caption',
      textContent: `oldest → newest, ${costs.length} run(s) — max ${usd(max)} · avg ${usd(avg)}`,
    }),
  );
}

/* ----------------------------------------------------------------- runs */

function renderRuns(breakdowns) {
  const table = $('runs-table');
  table.replaceChildren(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'id' }),
        el('th', { textContent: 'name' }),
        el('th', { textContent: 'status' }),
        el('th', { className: 'num', textContent: 'started' }),
        el('th', { className: 'num', textContent: 'took' }),
        el('th', { className: 'num', textContent: 'calls' }),
        el('th', { className: 'num', textContent: 'tokens' }),
        el('th', { className: 'num', textContent: 'cost' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      breakdowns.map((run) => {
        const row = el('tr', { dataset: { runId: run.runId } }, [
          el('td', { textContent: run.runId.slice(0, 8) }),
          el('td', { textContent: run.name }),
          el('td', {}, [el('span', { className: `pill ${run.status}`, textContent: run.status })]),
          el('td', { className: 'num', textContent: relativeTime(run.startedAt) }),
          el('td', { className: 'num', textContent: durationOf(run.durationMs) }),
          el('td', { className: 'num', textContent: int(run.llmCallCount) }),
          el('td', { className: 'num', textContent: int(run.totalInputTokens + run.totalOutputTokens) }),
          el('td', { className: 'num', textContent: usd(run.totalCostUsd) }),
        ]);
        row.setAttribute('aria-selected', String(run.runId === state.selectedRunId));
        row.addEventListener('click', () => selectRun(run.runId));
        return row;
      }),
    ),
  );

  if (breakdowns.length === 0) {
    $('run-detail').hidden = true;
  }
}

async function selectRun(runId) {
  state.selectedRunId = runId;
  for (const row of document.querySelectorAll('#runs-table tbody tr')) {
    row.setAttribute('aria-selected', String(row.dataset.runId === runId));
  }

  const detail = $('run-detail');
  detail.hidden = false;
  detail.replaceChildren(el('p', { className: 'hint', textContent: 'loading run…' }));

  try {
    const data = await getJson(`/api/runs/${encodeURIComponent(runId)}?${query()}`);
    renderRunDetail(data);
  } catch (err) {
    detail.replaceChildren(el('p', { className: 'empty', textContent: `Could not load run: ${err.message}` }));
  }
}

function renderRunDetail({ breakdown, waste, tree }) {
  const segments = breakdown.segments.filter((s) => s.tokens >= 0.5);

  const head = el('div', { className: 'detail-head' }, [
    el('h3', { textContent: breakdown.name }),
    el('span', { className: 'id', textContent: breakdown.runId }),
  ]);

  const facts = el('p', { className: 'hint' });
  facts.textContent =
    `${int(breakdown.llmCallCount)} llm call(s) · input ${int(breakdown.totalInputTokens)} tok · ` +
    `output ${int(breakdown.totalOutputTokens)} tok · total ${usd(breakdown.totalCostUsd)}` +
    (breakdown.pricingMode === 'hypothetical' ? ` · hypothetical, priced as ${breakdown.pricedAsModel}` : '');

  const table = el('table', { className: 'data' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'segment' }),
        el('th', { className: 'num', textContent: 'share' }),
        el('th', { className: 'num', textContent: 'tokens' }),
        el('th', { className: 'num', textContent: 'fresh' }),
        el('th', { className: 'num', textContent: 'cache rd' }),
        el('th', { className: 'num', textContent: 'cache wr' }),
        el('th', { className: 'num', textContent: 'cost' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      segments.map((segment) => {
        const swatch = el('span', { className: 'swatch' });
        swatch.style.background = segmentColor(segment.segment);
        return el('tr', {}, [
          el('td', {}, [swatch, document.createTextNode(segment.label)]),
          el('td', { className: 'num', textContent: pct(segment.share) }),
          el('td', { className: 'num', textContent: int(segment.tokens) }),
          el('td', { className: 'num', textContent: int(segment.freshTokens) }),
          el('td', { className: 'num', textContent: int(segment.cacheReadTokens) }),
          el('td', { className: 'num', textContent: int(segment.cacheWriteTokens) }),
          el('td', { className: 'num', textContent: usd(segment.costUsd) }),
        ]);
      }),
    ),
  ]);

  const children = [head, facts, el('div', { className: 'scroll-x' }, [table])];

  if (waste.findings.length > 0) {
    children.push(el('h2', { textContent: 'waste in this run' }));
    children.push(...waste.findings.map(findingCard));
  }

  children.push(el('h2', { textContent: 'call tree' }));
  children.push(renderTree(tree));

  $('run-detail').replaceChildren(...children);
}

/**
 * The run tree as an indented outline.
 *
 * Children are grouped by parentId rather than assumed adjacent — the flat
 * array is ordered by start time, so concurrent steps interleave in it and
 * anything walking it linearly would nest siblings under one another.
 */
function renderTree(nodes) {
  const childrenOf = new Map();
  for (const node of nodes) {
    const key = node.parentId;
    if (childrenOf.has(key)) childrenOf.get(key).push(node);
    else childrenOf.set(key, [node]);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.startedAt - b.startedAt);

  const box = el('div', { className: 'tree' });

  const walk = (node, prefix, isLast, isRoot) => {
    const line = el('div');
    if (!isRoot) line.append(document.createTextNode(prefix + (isLast ? '`- ' : '|- ')));

    const typeClass =
      node.type === 'llm_call' ? 't-llm' : node.type === 'tool_call' ? 't-tool' : 't-step';
    line.append(el('span', { className: typeClass, textContent: node.type }));
    line.append(document.createTextNode('  '));
    line.append(el('span', { className: 't-name', textContent: node.name }));
    line.append(document.createTextNode('  '));
    line.append(el('span', { className: `pill ${node.status}`, textContent: node.status }));

    const total = node.tokens.input + node.tokens.cacheRead + node.tokens.cacheWrite;
    if (total > 0 || node.tokens.output > 0) {
      line.append(
        el('span', { className: 't-meta', textContent: `  in ${int(total)} / out ${int(node.tokens.output)}` }),
      );
    }
    if (node.tokens.cacheRead > 0) {
      line.append(el('span', { className: 't-cache-read', textContent: `  cache-read ${int(node.tokens.cacheRead)}` }));
    }
    if (node.tokens.cacheWrite > 0) {
      line.append(el('span', { className: 't-cache-write', textContent: `  cache-write ${int(node.tokens.cacheWrite)}` }));
    }
    if (node.costUsd > 0) line.append(el('span', { className: 't-meta', textContent: `  ${usd(node.costUsd)}` }));
    if (node.durationMs !== null) {
      line.append(el('span', { className: 't-meta', textContent: `  ${durationOf(node.durationMs)}` }));
    }
    if (node.error) line.append(el('span', { className: 't-error', textContent: `  ${node.error}` }));

    box.append(line);

    const kids = childrenOf.get(node.id) ?? [];
    const childPrefix = isRoot ? prefix : prefix + (isLast ? '   ' : '|  ');
    kids.forEach((kid, i) => walk(kid, childPrefix, i === kids.length - 1, false));
  };

  const roots = childrenOf.get(null) ?? [];
  roots.forEach((root, i) => walk(root, '', i === roots.length - 1, true));
  return box;
}

/* ---------------------------------------------------------------- waste */

// Wording deliberately mirrors the library's own formatters. The "potential,
// not a bug" distinction for providers with no caching concept is a real
// correctness claim, and rephrasing it here would give it a second place to
// drift away from what the analysis actually determined.
function findingCard(finding) {
  let title;
  let detail;

  if (finding.type === 'uncached_static_content') {
    title = `Uncached ${finding.label}`;
    const tokens = finding.totalWastedTokens ?? finding.wastedTokens;
    detail =
      `${int(tokens)} input tokens were billed fresh for content that did not change between calls. ` +
      'Enable prompt caching for it, or move it behind a cache breakpoint.';
  } else if (finding.type === 'orphaned_tool_call') {
    const count = finding.totalOccurrences ?? finding.occurrences;
    title = `Orphaned tool call: ${finding.toolName}`;
    detail =
      `${int(count)} call(s) fetched a result that no later model call ever saw. ` +
      'The work was done and paid for, then dropped.';
  } else {
    const attempts = finding.totalWastedAttempts ?? finding.wastedAttempts;
    title = `Retried ${finding.nodeType === 'llm_call' ? 'model call' : 'tool call'}: ${finding.name}`;
    detail =
      `${int(attempts)} attempt(s) failed and were superseded by a later attempt. ` +
      'Nothing about a failed attempt was usable, so its whole cost counts as avoidable.';
  }

  const cost = finding.totalAvoidableCostUsd ?? finding.avoidableCostUsd;
  const runs = finding.affectedRunCount;

  return el('div', { className: 'finding' }, [
    el('div', { className: 'finding-head' }, [
      el('span', { className: 'finding-title', textContent: title }),
      el('span', { className: 'finding-cost', textContent: usd(cost) }),
    ]),
    el('p', { textContent: runs === undefined ? detail : `${detail} Seen in ${int(runs)} run(s).` }),
  ]);
}

function renderWaste(waste) {
  const hint = $('waste-hint');
  const findings = $('waste-findings');

  if (waste.findings.length === 0) {
    hint.textContent = '';
    findings.replaceChildren(
      el('div', { className: 'empty' }, [
        document.createTextNode('No waste detected in this selection. '),
        el('span', {
          textContent:
            waste.cacheSupport === 'no'
              ? 'Note that these runs used a provider with no caching concept, so the uncached-content check cannot fire for them.'
              : 'That covers uncached static content, orphaned tool calls, and retried calls.',
        }),
      ]),
    );
    return;
  }

  hint.textContent =
    `${usd(waste.totalAvoidableCostUsd)} avoidable across ${int(waste.runCount)} run(s)` +
    (waste.pricingMode === 'hypothetical' ? ` — hypothetical, priced as ${waste.pricedAsModel}` : '') +
    '. Ranked by dollar impact.';

  findings.replaceChildren(...waste.findings.map(findingCard));
}

/* ------------------------------------------------------------------ tabs */

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  for (const name of ['overview', 'runs', 'waste']) {
    $(`panel-${name}`).hidden = name !== tab;
  }
}

/* ------------------------------------------------------------------ load */

async function loadMeta() {
  const meta = await getJson('/api/meta');
  state.meta = meta;

  $('db-path').textContent = `${meta.dbPath} · v${meta.version}`;

  const select = $('filter-name');
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '', textContent: 'all runs' }),
    ...meta.runNames.map((entry) =>
      el('option', { value: entry.name, textContent: `${entry.name} (${entry.runCount})` }),
    ),
  );
  if (meta.runNames.some((entry) => entry.name === current)) select.value = current;

  $('model-list').replaceChildren(
    ...meta.pricedModels.map((model) => el('option', { value: model })),
  );
}

async function loadSummary() {
  const data = await getJson(`/api/summary?${query()}`);
  state.summary = data;

  const status = $('status');

  if (data.breakdowns.length === 0) {
    $('main').hidden = true;
    status.hidden = false;
    status.className = 'status';
    status.textContent = `No runs found in ${data.dbPath}. Record one — try \`npm run example\`, or wrap your own agent.`;
    return;
  }

  status.hidden = true;
  $('main').hidden = false;

  renderKpis(data.aggregate, data.waste);
  renderBanners(data.aggregate);
  renderComposition(data.aggregate);
  renderTrend(data.breakdowns);
  renderRuns(data.breakdowns);
  renderWaste(data.waste);

  // A run selected before a refresh may not be in the new selection.
  if (state.selectedRunId && !data.breakdowns.some((run) => run.runId === state.selectedRunId)) {
    state.selectedRunId = null;
    $('run-detail').hidden = true;
  }
}

async function refresh() {
  try {
    await loadMeta();
    await loadSummary();
  } catch (err) {
    const status = $('status');
    status.hidden = false;
    status.className = 'status error';
    status.textContent = `fyren: ${err.message}`;
  }
}

function setAutoRefresh(on) {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
  // 4s is fast enough to watch a live agent fill the table and slow enough
  // that it never competes with the agent for the database.
  if (on) state.autoTimer = setInterval(refresh, 4000);
}

function main() {
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('controls').addEventListener('submit', (event) => event.preventDefault());
  $('filter-name').addEventListener('change', refresh);
  $('filter-limit').addEventListener('change', refresh);
  $('filter-price-as').addEventListener('change', refresh);
  $('refresh').addEventListener('click', refresh);
  $('auto-refresh').addEventListener('change', (event) => setAutoRefresh(event.target.checked));

  showTab('overview');
  refresh();
}

main();
