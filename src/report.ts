// 보고서 — 터미널 표·Markdown·JSON.
//   같은 입력이면 같은 보고서가 나오도록: 시각·절대 경로를 넣지 않고, 숫자는 로캘과 무관한 toFixed 로만 쓴다.
import { readFileSync } from 'node:fs';
import type { MeasureResult, ConfigResult } from './measure.js';
import type { Aggregate } from './metrics.js';
import type { Recommendation } from './recommend.js';
import type { CheckResult } from './check.js';
import { setLocalStatements, adviceFor } from './sweep.js';
import { scopedRecall } from './recommend.js';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export type Format = 'table' | 'json' | 'md';

export interface GateResult {
  minRecall: number | null;
  minIndexUse: number;
  pass: boolean;
  failures: { code: 'index-not-used' | 'recall-below-min'; message: string }[];
}

// ---------- 숫자 표기 (로캘 무관) ----------
const num = (x: number | null, digits = 3): string => (x === null ? 'n/a' : x.toFixed(digits));
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const round = (x: number | null, digits: number): number | null => (x === null ? null : Number(x.toFixed(digits)));

// ---------- JSON 모양 ----------
function aggregateJson(a: Aggregate) {
  return {
    cases: a.cases,
    emptyCases: a.emptyCases,
    recall: round(a.recall, 4),
    observedRecall: round(a.observedRecall, 4),
    shortRate: round(a.shortRate, 4),
    indexUsedRatio: round(a.indexUsedRatio, 4),
    meanBuffers: round(a.meanBuffers, 2),
    p50Ms: round(a.p50Ms, 3),
    p95Ms: round(a.p95Ms, 3),
  };
}

function configJson(r: ConfigResult) {
  return {
    label: r.label,
    settings: {
      'hnsw.ef_search': r.effective.efSearch,
      'hnsw.iterative_scan': r.effective.iterativeScan,
      'hnsw.max_scan_tuples': r.effective.maxScanTuples,
    },
    ...aggregateJson(r.summary),
    notIndexed: r.notIndexed,
    groups: r.groups.map((g) => ({ group: g.group, ...aggregateJson(g) })),
  };
}

function recommendationJson(rec: Recommendation) {
  return {
    label: rec.choice?.label ?? null,
    setLocal: rec.choice ? setLocalStatements(rec.choice.config) : [],
    advice: rec.choice ? adviceFor(rec.choice.config) : [],
    reason: rec.reason,
    cost: rec.cost,
    target: rec.target,
    targetScope: rec.targetScope,
    maxShort: rec.maxShort,
    rejected: rec.rejected,
  };
}

export interface MeasureReportInput {
  command: 'measure' | 'sweep';
  result: MeasureResult;
  recommendation?: Recommendation;
  gate?: GateResult;
}

export function reportJson(input: MeasureReportInput): Record<string, unknown> {
  const r = input.result;
  const out: Record<string, unknown> = {
    tool: 'pgvector-doctor',
    version: VERSION,
    command: input.command,
    pgvector: r.pgvector,
    k: r.k,
    cases: r.cases,
    forceIndex: r.forceIndex,
    vectorIndexes: r.vectorIndexes,
    warnings: r.warnings,
    results: r.results.map(configJson),
  };
  if (input.recommendation) out.recommendation = recommendationJson(input.recommendation);
  if (input.gate) out.gate = input.gate;
  return out;
}

// ---------- 터미널 표 ----------
/** 열 너비를 맞춘 표. align 'r' 은 오른쪽 정렬(숫자). */
export function textTable(headers: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function mdTable(headers: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `|${align.map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

/**
 * 설정별 요약 표. 그룹이 둘 이상이면 'worst group'(그룹별 recall 최솟값) 열을 넣는다 —
 * 평균은 괜찮아도 작은 테넌트만 망가진 경우를 한 줄에서 보이게.
 */
export function summaryTable(results: readonly ConfigResult[], md = false): string {
  const withWorst = results.some((r) => r.groups.length > 1);
  const head = ['config', 'recall@k', ...(withWorst ? ['worst group'] : []), 'short', 'index used', 'buffers', 'p50 ms', 'p95 ms'];
  const align: ('l' | 'r')[] = ['l', ...head.slice(1).map(() => 'r' as const)];
  const rows = results.map((r) => {
    const s = r.summary;
    const worst = withWorst ? [num(scopedRecall(r, 'group'))] : [];
    return [r.label, num(s.recall), ...worst, pct(s.shortRate), pct(s.indexUsedRatio), num(s.meanBuffers, 1), num(s.p50Ms, 2), num(s.p95Ms, 2)];
  });
  return (md ? mdTable : textTable)(head, rows, align);
}

const GROUP_HEAD = ['group', 'cases', 'recall@k', 'short', 'index used'];
const GROUP_ALIGN: ('l' | 'r')[] = ['l', 'r', 'r', 'r', 'r'];
/** 그룹이 많으면 recall 이 낮은 순으로 상위 limit 개만 보여 준다(전체는 JSON·Markdown 에). */
export function groupRows(r: ConfigResult, limit = Infinity): { rows: string[][]; hidden: number } {
  let groups = r.groups;
  let hidden = 0;
  if (groups.length > limit) {
    groups = [...groups].sort((a, b) => (a.recall ?? -1) - (b.recall ?? -1)).slice(0, limit);
    hidden = r.groups.length - limit;
  }
  return {
    rows: groups.map((g) => [g.group, String(g.cases), num(g.recall), pct(g.shortRate), pct(g.indexUsedRatio)]),
    hidden,
  };
}

/** 벡터 인덱스를 안 탄 질의 경고 줄들 — "가짜 만점"을 막는 핵심 표시. */
export function notIndexedLines(r: ConfigResult): string[] {
  const total = r.summary.cases;
  return r.notIndexed.map(
    (n) => `! index not used for ${n.count}/${total} queries — recall not counted (${n.reason})`,
  );
}

function header(r: MeasureResult): string {
  return `pgvector ${r.pgvector ?? '?'} · k=${r.k} · ${r.cases} cases · force-index: ${r.forceIndex ? 'on' : 'off'}`;
}

export function renderMeasure(input: MeasureReportInput, format: Format): string {
  if (format === 'json') return `${JSON.stringify(reportJson(input), null, 2)}\n`;
  const r = input.result;
  const md = format === 'md';
  const table = md ? mdTable : textTable;
  const out: string[] = [];

  out.push(md ? `## pgvector-doctor ${input.command}\n\n- ${header(r)}` : header(r));
  for (const w of r.warnings) out.push(md ? `- warning: ${w}` : `warning: ${w}`);
  out.push('');
  out.push(summaryTable(r.results, md));

  if (input.command === 'measure' || md) {
    for (const res of r.results) {
      if (res.groups.length <= 1 && !md) continue;
      const { rows, hidden } = groupRows(res, md ? Infinity : 30);
      out.push('');
      out.push(md ? `### by group — ${res.label}` : `by group — ${res.label}`);
      out.push(table(GROUP_HEAD, rows, GROUP_ALIGN));
      if (hidden > 0) out.push(`… ${hidden} more groups (lowest recall shown; see --format json)`);
    }
  }
  const notIdx = r.results.flatMap((res) => notIndexedLines(res).map((l) => (r.results.length > 1 ? `${l} [${res.label}]` : l)));
  if (notIdx.length > 0) {
    out.push('');
    out.push(...notIdx.map((l) => (md ? `- ${l}` : l)));
  }

  if (input.recommendation) out.push('', ...recommendationLines(input.recommendation, r.k, md));
  if (input.gate) {
    // 터미널 표에서는 FAIL 사유를 CLI 가 stderr 로 따로 쓰므로 여기서는 PASS 만(중복 방지). Markdown 보고서에는 둘 다.
    if (input.gate.pass) out.push('', md ? '**PASS** quality gate' : 'PASS quality gate');
    else if (md) out.push('', ...input.gate.failures.map((f) => `- **FAIL** ${f.code}: ${f.message}`));
  }
  return `${out.join('\n')}\n`;
}

export function recommendationLines(rec: Recommendation, k: number, md = false): string[] {
  const out: string[] = [];
  const scope = rec.targetScope === 'group' ? ' (every group)' : '';
  if (!rec.choice) {
    out.push(`No configuration met recall@${k} >= ${rec.target.toFixed(2)}${scope} with LIMIT-short <= ${pct(rec.maxShort)} on the vector index.`);
    const best = rec.rejected.slice(0, 5).map((x) => `  ${x.label}: ${x.why}`);
    if (best.length > 0) out.push('Why each config was rejected (first 5):', ...best);
    return md ? out.map((l) => (l.startsWith('  ') ? `- ${l.trim()}` : l)) : out;
  }
  const c = rec.choice;
  const recall = scopedRecall(c, rec.targetScope);
  const cost = rec.cost === 'buffers' ? `${num(c.summary.meanBuffers, 1)} buffers/query` : `p95 ${num(c.summary.p95Ms, 2)} ms (no buffer info)`;
  out.push(
    `Recommended: ${c.label} — recall@${k} ${num(recall)}${scope}, short ${pct(c.summary.shortRate)}, ${cost} (cheapest meeting target ${rec.target.toFixed(2)})`,
  );
  const stmts = setLocalStatements(c.config);
  if (md) out.push('', '```sql', ...stmts, '```');
  else out.push(...stmts);
  out.push(...adviceFor(c.config).map((a) => (md ? `- ${a}` : `  note: ${a}`)));
  return out;
}

export function renderCheck(r: CheckResult, format: Format): string {
  if (format === 'json') {
    return `${JSON.stringify({ tool: 'pgvector-doctor', version: VERSION, command: 'check', ...r }, null, 2)}\n`;
  }
  const md = format === 'md';
  const out: string[] = [];
  const s = r.settings;
  out.push(md ? '## pgvector-doctor check' : 'pgvector-doctor check');
  const line = (x: string) => out.push(md ? `- ${x}` : x);
  line(`pgvector ${r.pgvector ?? 'not installed'} · hnsw.ef_search=${s.efSearch ?? '40 (default)'} · hnsw.iterative_scan=${s.iterativeScan ?? 'n/a'} · k=${r.k}`);
  line(`tables: ${r.tables.join(', ') || '?'}`);
  line(
    `vector indexes: ${r.indexes.map((i) => `${i.index} (${i.method}, ${i.opclass})`).join(', ') || 'none'}`,
  );
  if (r.plan.mode !== 'skipped') line(`plan (${r.plan.mode}): ${r.plan.scans.join(' + ') || '?'}`);
  out.push('');
  if (r.diagnostics.length === 0) out.push('OK no problems found');
  for (const d of r.diagnostics) {
    const tag = d.level === 'error' ? 'ERROR' : d.level === 'warn' ? 'WARN ' : 'INFO ';
    out.push(md ? `- **${tag.trim()}** \`${d.code}\`: ${d.message}` : `${tag} ${d.code}: ${d.message}`);
  }
  return `${out.join('\n')}\n`;
}
