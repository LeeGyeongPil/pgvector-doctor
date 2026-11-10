// 추천 — 목표를 만족하는 조합 중 가장 싼 것.
//   조건: 모든 질의가 벡터 인덱스를 탔고(가짜 만점 제외), recall ≥ 목표, LIMIT 미달률 ≤ 상한.
//   비용: 평균 읽은 버퍼 수(기계 속도와 무관해 재현됨). 버퍼 정보가 없으면 p95 지연으로 대체.
//   동률: ef_search 낮은 것 → off < strict_order < relaxed_order → max_scan_tuples 낮은 것.
import type { ConfigResult } from './measure.js';

export type TargetScope = 'mean' | 'group';

export interface RecommendOptions {
  /** 목표 recall@k (기본 0.95) */
  target?: number;
  /** mean = 전체 평균, group = 그룹별 최솟값이 목표 이상이어야 함 */
  targetScope?: TargetScope;
  /** 허용 LIMIT 미달률(기본 0) */
  maxShort?: number;
}

export interface Rejection {
  label: string;
  why: string;
}

export interface Recommendation {
  /** 고른 조합. 없으면 null */
  choice: ConfigResult | null;
  /** choice 가 null 일 때 사유 코드 */
  reason: 'no-config-meets-target' | null;
  /** 비용 지표 */
  cost: 'buffers' | 'latency';
  target: number;
  targetScope: TargetScope;
  maxShort: number;
  rejected: Rejection[];
}

const ITER_ORDER: Record<string, number> = { off: 0, strict_order: 1, relaxed_order: 2 };

/** 이 조합이 목표 판정에 쓰는 recall — mean 이면 전체, group 이면 그룹 최솟값(그룹 하나라도 null 이면 null). */
export function scopedRecall(r: ConfigResult, scope: TargetScope): number | null {
  if (scope === 'mean') return r.summary.recall;
  if (r.groups.length === 0) return r.summary.recall;
  let min = Infinity;
  for (const g of r.groups) {
    if (g.cases === g.emptyCases) continue; // 기준값이 모두 빈 그룹은 판정할 것이 없다
    if (g.recall === null) return null;
    min = Math.min(min, g.recall);
  }
  return min === Infinity ? null : min;
}

/** 이 조합의 LIMIT 미달률 — group 이면 그룹 최댓값. */
export function scopedShort(r: ConfigResult, scope: TargetScope): number {
  if (scope === 'mean' || r.groups.length === 0) return r.summary.shortRate ?? 0;
  return Math.max(0, ...r.groups.map((g) => g.shortRate ?? 0));
}

export function recommend(results: readonly ConfigResult[], opts: RecommendOptions = {}): Recommendation {
  const target = opts.target ?? 0.95;
  const targetScope = opts.targetScope ?? 'mean';
  const maxShort = opts.maxShort ?? 0;
  const rejected: Rejection[] = [];
  const ok: ConfigResult[] = [];

  for (const r of results) {
    if (r.summary.indexUsedRatio < 1) {
      rejected.push({ label: r.label, why: `index-not-used (${fmt(r.summary.indexUsedRatio)} of queries used the vector index)` });
      continue;
    }
    const recall = scopedRecall(r, targetScope);
    if (recall === null) {
      rejected.push({ label: r.label, why: 'no-recall (every query had an empty exact result)' });
      continue;
    }
    if (recall < target) {
      rejected.push({ label: r.label, why: `recall-below-target (${fmt(recall)} < ${fmt(target)})` });
      continue;
    }
    const short = scopedShort(r, targetScope);
    if (short > maxShort) {
      rejected.push({ label: r.label, why: `too-many-short (${fmt(short)} > ${fmt(maxShort)})` });
      continue;
    }
    ok.push(r);
  }

  // 후보가 모두 버퍼 정보를 갖고 있으면 버퍼, 아니면 지연(p95)으로 비교한다.
  const cost: 'buffers' | 'latency' = ok.every((r) => r.summary.meanBuffers !== null) ? 'buffers' : 'latency';
  const costOf = (r: ConfigResult): number =>
    (cost === 'buffers' ? r.summary.meanBuffers : r.summary.p95Ms) ?? Number.POSITIVE_INFINITY;

  const sorted = [...ok].sort(
    (a, b) =>
      costOf(a) - costOf(b) ||
      (a.config.efSearch ?? 0) - (b.config.efSearch ?? 0) ||
      (ITER_ORDER[a.config.iterativeScan ?? 'off'] ?? 0) - (ITER_ORDER[b.config.iterativeScan ?? 'off'] ?? 0) ||
      (a.config.maxScanTuples ?? 0) - (b.config.maxScanTuples ?? 0),
  );
  const choice = sorted[0] ?? null;
  return { choice, reason: choice ? null : 'no-config-meets-target', cost, target, targetScope, maxShort, rejected };
}

function fmt(n: number): string {
  return n.toFixed(3);
}
