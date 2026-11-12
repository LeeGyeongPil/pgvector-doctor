// 보고서 — 터미널 표·Markdown·JSON.
//   같은 입력이면 같은 보고서가 나오도록: 시각·절대 경로를 넣지 않고, 숫자는 로캘과 무관한 toFixed 로만 쓴다.
import { readFileSync } from 'node:fs';
import type { MeasureResult, ConfigResult } from './measure.js';
import type { Aggregate } from './metrics.js';
import type { Recommendation } from './recommend.js';
import type { CheckResult } from './check.js';
import { setLocalStatements, adviceFor } from './sweep.js';
import { scopedRecall } from './recommend.js';
import { t, localizedText, localizeWarning, localizeAdvice, type Lang } from './i18n.js';

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
/** 한글·한자·전각 문자는 터미널에서 2칸을 차지한다(외부 패키지 없이 주요 동아시아 전각 범위만). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 한글 자모
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 부수·기호·가나·한자
    (cp >= 0xac00 && cp <= 0xd7a3) || // 한글 음절
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 호환 한자
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 호환 형태
    (cp >= 0xff00 && cp <= 0xff60) || // 전각 형태
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/** 터미널 표시 폭(칸). 영문·숫자 1칸, 한글 2칸. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

const padEndW = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));
const padStartW = (s: string, width: number) => ' '.repeat(Math.max(0, width - displayWidth(s))) + s;

/** 열 너비를 맞춘 표. align 'r' 은 오른쪽 정렬(숫자). 너비는 표시 폭(한글 2칸) 기준. */
export function textTable(headers: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (align[i] === 'r' ? padStartW(c, widths[i]!) : padEndW(c, widths[i]!)))
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
export function summaryTable(results: readonly ConfigResult[], md = false, lang: Lang = 'en'): string {
  const withWorst = results.some((r) => r.groups.length > 1);
  const head = [
    t(lang, 'head.config'),
    t(lang, 'head.recall'),
    ...(withWorst ? [t(lang, 'head.worst')] : []),
    t(lang, 'head.short'),
    t(lang, 'head.index-used'),
    t(lang, 'head.buffers'),
    t(lang, 'head.p50'),
    t(lang, 'head.p95'),
  ];
  const align: ('l' | 'r')[] = ['l', ...head.slice(1).map(() => 'r' as const)];
  const rows = results.map((r) => {
    const s = r.summary;
    const worst = withWorst ? [num(scopedRecall(r, 'group'))] : [];
    return [r.label, num(s.recall), ...worst, pct(s.shortRate), pct(s.indexUsedRatio), num(s.meanBuffers, 1), num(s.p50Ms, 2), num(s.p95Ms, 2)];
  });
  return (md ? mdTable : textTable)(head, rows, align);
}

const groupHead = (lang: Lang) => [
  t(lang, 'head.group'),
  t(lang, 'head.cases'),
  t(lang, 'head.recall'),
  t(lang, 'head.short'),
  t(lang, 'head.index-used'),
];
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
export function notIndexedLines(r: ConfigResult, lang: Lang = 'en'): string[] {
  const total = r.summary.cases;
  return r.notIndexed.map((n) => t(lang, 'report.not-indexed', { count: n.count, total, reason: n.reason }));
}

function header(r: MeasureResult, lang: Lang): string {
  return t(lang, 'report.header', {
    pgvector: r.pgvector ?? '?',
    k: r.k,
    cases: r.cases,
    force: t(lang, r.forceIndex ? 'word.on' : 'word.off'),
  });
}

/** `lang` 은 화면 언어(기본 영어). 'json' 은 언어와 관계없이 항상 같은 영어 JSON. */
export function renderMeasure(input: MeasureReportInput, format: Format, lang: Lang = 'en'): string {
  if (format === 'json') return `${JSON.stringify(reportJson(input), null, 2)}\n`;
  const r = input.result;
  const md = format === 'md';
  const table = md ? mdTable : textTable;
  const out: string[] = [];

  out.push(md ? `## pgvector-doctor ${input.command}\n\n- ${header(r, lang)}` : header(r, lang));
  const warningWord = t(lang, 'word.warning');
  for (const w of r.warnings) out.push(md ? `- ${warningWord} ${localizeWarning(lang, w)}` : `${warningWord} ${localizeWarning(lang, w)}`);
  out.push('');
  out.push(summaryTable(r.results, md, lang));

  if (input.command === 'measure' || md) {
    for (const res of r.results) {
      if (res.groups.length <= 1 && !md) continue;
      const { rows, hidden } = groupRows(res, md ? Infinity : 30);
      out.push('');
      const title = t(lang, 'report.by-group', { label: res.label });
      out.push(md ? `### ${title}` : title);
      out.push(table(groupHead(lang), rows, GROUP_ALIGN));
      if (hidden > 0) out.push(t(lang, 'report.more-groups', { hidden }));
    }
  }
  const notIdx = r.results.flatMap((res) => notIndexedLines(res, lang).map((l) => (r.results.length > 1 ? `${l} [${res.label}]` : l)));
  if (notIdx.length > 0) {
    out.push('');
    out.push(...notIdx.map((l) => (md ? `- ${l}` : l)));
  }

  if (input.recommendation) out.push('', ...recommendationLines(input.recommendation, r.k, md, lang));
  if (input.gate) {
    // 터미널 표에서는 FAIL 사유를 CLI 가 stderr 로 따로 쓰므로 여기서는 PASS 만(중복 방지). Markdown 보고서에는 둘 다.
    const pass = t(lang, 'report.pass');
    if (input.gate.pass) out.push('', md ? `**PASS** ${pass}` : `PASS ${pass}`);
    else if (md) out.push('', ...input.gate.failures.map((f) => `- **FAIL** ${f.code}: ${localizedText(lang, f, f.message)}`));
  }
  return `${out.join('\n')}\n`;
}

export function recommendationLines(rec: Recommendation, k: number, md = false, lang: Lang = 'en'): string[] {
  const out: string[] = [];
  const scope = rec.targetScope === 'group' ? t(lang, 'report.scope-group') : '';
  if (!rec.choice) {
    out.push(t(lang, 'report.no-choice', { k, target: rec.target.toFixed(2), scope, short: pct(rec.maxShort) }));
    const best = rec.rejected.slice(0, 5).map((x) => `  ${x.label}: ${localizedText(lang, x, x.why)}`);
    if (best.length > 0) out.push(t(lang, 'report.why-rejected'), ...best);
    return md ? out.map((l) => (l.startsWith('  ') ? `- ${l.trim()}` : l)) : out;
  }
  const c = rec.choice;
  const recall = scopedRecall(c, rec.targetScope);
  const cost =
    rec.cost === 'buffers'
      ? t(lang, 'report.cost-buffers', { n: num(c.summary.meanBuffers, 1) })
      : t(lang, 'report.cost-latency', { n: num(c.summary.p95Ms, 2) });
  out.push(
    t(lang, 'report.recommended', {
      label: c.label,
      k,
      recall: num(recall),
      scope,
      short: pct(c.summary.shortRate),
      cost,
      target: rec.target.toFixed(2),
    }),
  );
  const stmts = setLocalStatements(c.config);
  if (md) out.push('', '```sql', ...stmts, '```');
  else out.push(...stmts);
  const noteWord = t(lang, 'word.note');
  out.push(...adviceFor(c.config).map((a) => (md ? `- ${localizeAdvice(lang, a)}` : `  ${noteWord} ${localizeAdvice(lang, a)}`)));
  return out;
}

export function renderCheck(r: CheckResult, format: Format, lang: Lang = 'en'): string {
  if (format === 'json') {
    return `${JSON.stringify({ tool: 'pgvector-doctor', version: VERSION, command: 'check', ...r }, null, 2)}\n`;
  }
  const md = format === 'md';
  const out: string[] = [];
  const s = r.settings;
  const title = t(lang, 'check.title');
  out.push(md ? `## ${title}` : title);
  const line = (x: string) => out.push(md ? `- ${x}` : x);
  line(
    t(lang, 'check.settings', {
      pgvector: r.pgvector ?? t(lang, 'check.not-installed'),
      ef: s.efSearch ?? `40 (${t(lang, 'check.default')})`,
      iter: s.iterativeScan ?? 'n/a',
      k: r.k,
    }),
  );
  line(t(lang, 'check.tables', { list: r.tables.join(', ') || '?' }));
  line(
    t(lang, 'check.indexes', {
      list: r.indexes.map((i) => `${i.index} (${i.method}, ${i.opclass})`).join(', ') || t(lang, 'check.none'),
    }),
  );
  if (r.plan.mode !== 'skipped') line(t(lang, 'check.plan', { mode: r.plan.mode, scans: r.plan.scans.join(' + ') || '?' }));
  out.push('');
  if (r.diagnostics.length === 0) out.push(`OK ${t(lang, 'check.ok')}`);
  for (const d of r.diagnostics) {
    const tag = d.level === 'error' ? 'ERROR' : d.level === 'warn' ? 'WARN ' : 'INFO ';
    const message = localizedText(lang, d, d.message);
    out.push(md ? `- **${tag.trim()}** \`${d.code}\`: ${message}` : `${tag} ${d.code}: ${message}`);
  }
  return `${out.join('\n')}\n`;
}
