// 지표 계산(순수 함수) — DB 없이 테스트한다.

/** 질의 하나를 한 설정으로 돌린 결과 */
export interface CaseRun {
  group: string;
  /** 정확 검색(인덱스 끔) 결과 id — 기준값 */
  exactIds: string[];
  /** 근사 검색(설정 적용) 결과 id */
  approxIds: string[];
  selfId?: string;
  /** EXPLAIN 판정: 카탈로그상 벡터 인덱스를 탔나 */
  vectorIndexUsed: boolean;
  latencyMs: number;
  buffers: number | null;
}

export interface CaseScore {
  /** |근사∩정확| / |정확|. 정확 결과가 0개면 null(빈 기준값) */
  recall: number | null;
  /** 근사 결과가 정확 결과보다 적다 = LIMIT 미달 */
  short: boolean;
  /** 자기 행을 빼고 나니 정확 결과가 0개 */
  empty: boolean;
}

/** recall@k 와 LIMIT 미달. self_id 가 있으면 두 목록에서 자기 행을 먼저 뺀다. */
export function scoreCase(exactIds: readonly string[], approxIds: readonly string[], selfId?: string): CaseScore {
  const exact = selfId === undefined ? [...exactIds] : exactIds.filter((id) => id !== selfId);
  const approx = selfId === undefined ? [...approxIds] : approxIds.filter((id) => id !== selfId);
  if (exact.length === 0) return { recall: null, short: false, empty: true };
  const truth = new Set(exact);
  // 집합 기준: 같은 id 가 두 번 나와도 한 번만 센다.
  const hits = new Set(approx.filter((id) => truth.has(id))).size;
  return { recall: hits / truth.size, short: new Set(approx).size < truth.size, empty: false };
}

/** nearest-rank 백분위: 오름차순 정렬 뒤 ceil(p/100·n) 번째. 값이 없으면 null. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface Aggregate {
  /** 사례 수 */
  cases: number;
  /** 정확 결과가 0개라 recall 계산에서 뺀 사례 수 */
  emptyCases: number;
  /** 벡터 인덱스를 탄 사례 비율(0..1) */
  indexUsedRatio: number;
  /** 벡터 인덱스를 탄 사례만의 평균 recall@k — 인덱스 품질. 하나도 안 탔으면 null(가짜 만점 차단) */
  recall: number | null;
  /** 인덱스 사용 여부와 상관없이 사용자가 실제로 받은 결과의 평균 recall@k */
  observedRecall: number | null;
  /** LIMIT 미달 비율(빈 기준값 제외) */
  shortRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** 평균 읽은 버퍼 수. 한 사례라도 버퍼 정보가 없으면 null(→ 비용은 지연으로 대체) */
  meanBuffers: number | null;
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function aggregate(runs: readonly CaseRun[]): Aggregate {
  const scored = runs.map((r) => ({ run: r, score: scoreCase(r.exactIds, r.approxIds, r.selfId) }));
  const nonEmpty = scored.filter((s) => !s.score.empty);
  const indexed = nonEmpty.filter((s) => s.run.vectorIndexUsed);
  const buffers = runs.map((r) => r.buffers);
  return {
    cases: runs.length,
    emptyCases: scored.length - nonEmpty.length,
    indexUsedRatio: runs.length === 0 ? 0 : runs.filter((r) => r.vectorIndexUsed).length / runs.length,
    recall: mean(indexed.map((s) => s.score.recall!)),
    observedRecall: mean(nonEmpty.map((s) => s.score.recall!)),
    shortRate: nonEmpty.length === 0 ? null : nonEmpty.filter((s) => s.score.short).length / nonEmpty.length,
    p50Ms: percentile(runs.map((r) => r.latencyMs), 50),
    p95Ms: percentile(runs.map((r) => r.latencyMs), 95),
    meanBuffers: buffers.length > 0 && buffers.every((b) => b !== null) ? mean(buffers as number[]) : null,
  };
}

/** 로캘과 무관한 자연 정렬: 'tenant 2' < 'tenant 10'. (localeCompare 는 환경 로캘을 타서 쓰지 않는다) */
export function naturalCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    }
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

export interface GroupAggregate extends Aggregate {
  group: string;
}

/** 필터 값(그룹)별 집계 — "작은 테넌트만 망가진다"를 드러낸다. */
export function aggregateByGroup(runs: readonly CaseRun[]): GroupAggregate[] {
  const by = new Map<string, CaseRun[]>();
  for (const r of runs) {
    const list = by.get(r.group) ?? [];
    list.push(r);
    by.set(r.group, list);
  }
  return [...by.keys()].sort(naturalCompare).map((group) => ({ group, ...aggregate(by.get(group)!) }));
}
