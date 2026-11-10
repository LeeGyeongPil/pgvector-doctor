// 스윕 — ef_search × iterative_scan × max_scan_tuples 격자를 훑고 가장 싼 조합을 추천한다.
import type { Queryable } from './db.js';
import { UsageError } from './template.js';
import { pgvectorVersion, supportsIterativeScan } from './catalog.js';
import {
  type HnswConfig,
  type IterativeScan,
  type MeasureOptions,
  type MeasureResult,
  ITERATIVE_SCAN_VALUES,
  measure,
} from './measure.js';
import { type RecommendOptions, type Recommendation, recommend } from './recommend.js';

export const DEFAULT_EF_SEARCH = [40, 100, 200, 400];
export const DEFAULT_ITERATIVE: IterativeScan[] = ['off', 'strict_order', 'relaxed_order'];
export const DEFAULT_MAX_SCAN_TUPLES = [20000];

/** pgvector 가 받는 hnsw.ef_search 범위 */
export const EF_SEARCH_MIN = 1;
export const EF_SEARCH_MAX = 1000;

/**
 * '40,100,200' 같은 목록 문자열을 정수 배열로. 숫자 말고 다른 글자가 하나라도 있으면 거부한다.
 * (`--ef '40; DROP TABLE items'` 같은 값이 SQL 로 흘러가지 않게 하는 첫 관문)
 */
export function parseIntList(raw: string, name: string, min: number, max: number): number[] {
  const parts = raw.split(',').map((s) => s.trim());
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) throw new UsageError(`${name}: "${p}" is not a whole number`);
    const n = Number(p);
    if (n < min || n > max) throw new UsageError(`${name}: ${n} is outside ${min}..${max}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** iterative_scan 목록 — 열거값만 받는다. */
export function parseIterativeList(raw: string): IterativeScan[] {
  const out: IterativeScan[] = [];
  for (const p of raw.split(',').map((s) => s.trim())) {
    if (!(ITERATIVE_SCAN_VALUES as readonly string[]).includes(p)) {
      throw new UsageError(`--iterative: "${p}" must be one of ${ITERATIVE_SCAN_VALUES.join(', ')}`);
    }
    if (!out.includes(p as IterativeScan)) out.push(p as IterativeScan);
  }
  return out;
}

export interface GridOptions {
  efSearch?: number[];
  iterativeScan?: IterativeScan[];
  maxScanTuples?: number[];
}

/**
 * 격자 만들기. iterative_scan=off 에서는 max_scan_tuples 가 의미 없으므로 한 번만 잰다.
 * pgvector < 0.8.0 이면 iterative 축을 빼고(설정하지 않음) 경고를 돌려준다.
 */
export function buildGrid(opts: GridOptions, version: string | null): { configs: HnswConfig[]; warnings: string[] } {
  const ef = opts.efSearch ?? DEFAULT_EF_SEARCH;
  const iter = opts.iterativeScan ?? DEFAULT_ITERATIVE;
  const mst = opts.maxScanTuples ?? DEFAULT_MAX_SCAN_TUPLES;
  for (const e of ef) validateInt(e, 'ef_search', EF_SEARCH_MIN, EF_SEARCH_MAX);
  for (const m of mst) validateInt(m, 'max_scan_tuples', 1, 2_147_483_647);
  for (const i of iter) {
    if (!ITERATIVE_SCAN_VALUES.includes(i)) throw new UsageError(`iterative_scan: invalid value ${String(i)}`);
  }

  const warnings: string[] = [];
  const configs: HnswConfig[] = [];
  if (!supportsIterativeScan(version)) {
    warnings.push(`pgvector ${version ?? '(not installed)'} < 0.8.0: iterative_scan axis removed, sweeping ef_search only`);
    for (const e of ef) configs.push({ efSearch: e });
    return { configs, warnings };
  }
  for (const i of iter) {
    for (const e of ef) {
      if (i === 'off') configs.push({ efSearch: e, iterativeScan: 'off' });
      else for (const m of mst) configs.push({ efSearch: e, iterativeScan: i, maxScanTuples: m });
    }
  }
  return { configs, warnings };
}

function validateInt(n: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${name}: ${n} must be an integer in ${min}..${max}`);
}

/** 앱 코드에 그대로 붙여 넣을 SET LOCAL 문(트랜잭션 안에서). */
export function setLocalStatements(c: HnswConfig): string[] {
  const out: string[] = [];
  if (c.efSearch !== undefined) out.push(`SET LOCAL hnsw.ef_search = ${c.efSearch};`);
  if (c.iterativeScan !== undefined) out.push(`SET LOCAL hnsw.iterative_scan = ${c.iterativeScan};`);
  if (c.iterativeScan !== undefined && c.iterativeScan !== 'off' && c.maxScanTuples !== undefined) {
    out.push(`SET LOCAL hnsw.max_scan_tuples = ${c.maxScanTuples};`);
  }
  return out;
}

/** 추천 설정에 덧붙일 안내 문장들. */
export function adviceFor(c: HnswConfig): string[] {
  const out = [
    'Run the SET LOCAL lines inside the same transaction (same connection) as the search query; with a pool, BEGIN … COMMIT around both.',
  ];
  if (c.iterativeScan === 'relaxed_order') {
    out.push(
      'relaxed_order may return rows slightly out of distance order. If order matters, wrap the query in WITH r AS MATERIALIZED (…) and ORDER BY distance + 0 outside.',
    );
  }
  return out;
}

export interface SweepOptions extends Omit<MeasureOptions, 'configs'>, GridOptions, RecommendOptions {}

export interface SweepResult extends MeasureResult {
  recommendation: Recommendation;
}

export async function sweep(db: Queryable, opts: SweepOptions): Promise<SweepResult> {
  const version = opts.pgvectorVersionOverride !== undefined ? opts.pgvectorVersionOverride : await pgvectorVersion(db);
  const grid = buildGrid(opts, version);
  const result = await measure(db, { ...opts, configs: grid.configs, pgvectorVersionOverride: version });
  const recommendation = recommend(result.results, opts);
  return { ...result, warnings: [...grid.warnings, ...result.warnings], recommendation };
}
