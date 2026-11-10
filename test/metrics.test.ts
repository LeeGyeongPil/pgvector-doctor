// AC-3 — 지표 계산(순수 함수, DB 없음)
import { describe, it, expect } from 'vitest';
import { scoreCase, percentile, aggregate, aggregateByGroup, naturalCompare, type CaseRun } from '../src/metrics.js';

const run = (over: Partial<CaseRun>): CaseRun => ({
  group: 'g',
  exactIds: [],
  approxIds: [],
  vectorIndexUsed: true,
  latencyMs: 1,
  buffers: 10,
  ...over,
});

describe('scoreCase', () => {
  it('recall is |approx ∩ exact| / |exact|', () => {
    expect(scoreCase(['1', '2', '3', '4'], ['1', '2', '9', '8'])).toEqual({ recall: 0.5, short: false, empty: false });
  });

  it('uses |exact| as denominator when the exact result has fewer than k rows', () => {
    // 필터에 맞는 행이 3개뿐이면 k=10 이어도 분모는 3
    expect(scoreCase(['1', '2', '3'], ['1', '2', '3']).recall).toBe(1);
    expect(scoreCase(['1', '2', '3'], ['1']).recall).toBeCloseTo(1 / 3);
  });

  it('flags LIMIT-short when the approximate result has fewer rows than the exact one', () => {
    expect(scoreCase(['1', '2', '3'], ['1', '2']).short).toBe(true);
    expect(scoreCase(['1', '2', '3'], ['1', '2', '7']).short).toBe(false);
    expect(scoreCase(['1', '2', '3'], []).short).toBe(true);
  });

  it('counts duplicate ids once (set semantics)', () => {
    expect(scoreCase(['1', '2'], ['1', '1']).recall).toBe(0.5);
    expect(scoreCase(['1', '2'], ['1', '1']).short).toBe(true);
  });

  it('removes the self row from both lists when self_id is given', () => {
    // 질의 벡터를 테이블에서 뽑으면 자기 행이 1위로 나와 recall 을 부풀린다
    expect(scoreCase(['s', '1', '2'], ['s', '9', '8'], 's')).toEqual({ recall: 0, short: false, empty: false });
    expect(scoreCase(['s', '1', '2'], ['s', '9', '8']).recall).toBeCloseTo(1 / 3);
    // 근사 결과에 자기 행이 없어도 분모는 자기 행을 뺀 정확 결과
    expect(scoreCase(['s', '1', '2'], ['1', '2'], 's').recall).toBe(1);
  });

  it('marks an empty baseline as empty with recall null', () => {
    expect(scoreCase([], [])).toEqual({ recall: null, short: false, empty: true });
    expect(scoreCase(['s'], ['s'], 's')).toEqual({ recall: null, short: false, empty: true });
  });
});

describe('percentile (nearest-rank)', () => {
  it('handles empty, single and boundary values', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    const xs = Array.from({ length: 20 }, (_, i) => 20 - i); // 20..1 (정렬 안 된 입력)
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 100)).toBe(20);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });
});

describe('aggregate', () => {
  it('index recall ignores queries that did not use the vector index; observed recall includes them', () => {
    const a = aggregate([
      run({ exactIds: ['1', '2'], approxIds: ['1', '9'], vectorIndexUsed: true }),
      run({ exactIds: ['1', '2'], approxIds: ['1', '2'], vectorIndexUsed: false }),
    ]);
    expect(a.recall).toBe(0.5);
    expect(a.observedRecall).toBe(0.75);
    expect(a.indexUsedRatio).toBe(0.5);
  });

  it('recall is null (not 1.0) when no query used the vector index', () => {
    const a = aggregate([run({ exactIds: ['1'], approxIds: ['1'], vectorIndexUsed: false })]);
    expect(a.recall).toBeNull();
    expect(a.observedRecall).toBe(1);
    expect(a.indexUsedRatio).toBe(0);
  });

  it('skips empty baselines and counts them', () => {
    const a = aggregate([
      run({ exactIds: [], approxIds: [] }),
      run({ exactIds: ['1', '2'], approxIds: ['1'] }),
    ]);
    expect(a.cases).toBe(2);
    expect(a.emptyCases).toBe(1);
    expect(a.recall).toBe(0.5);
    expect(a.shortRate).toBe(1);
  });

  it('mean buffers is null if any run lacks buffer info (cost falls back to latency)', () => {
    expect(aggregate([run({ buffers: 10 }), run({ buffers: 30 })]).meanBuffers).toBe(20);
    expect(aggregate([run({ buffers: 10 }), run({ buffers: null })]).meanBuffers).toBeNull();
  });

  it('latency percentiles', () => {
    const a = aggregate([1, 2, 3, 4, 100].map((ms) => run({ latencyMs: ms, exactIds: ['1'], approxIds: ['1'] })));
    expect(a.p50Ms).toBe(3);
    expect(a.p95Ms).toBe(100);
  });
});

describe('aggregateByGroup', () => {
  it('splits per group and sorts naturally without locale', () => {
    const runs = ['t10', 't2', 'big', 't2'].map((g) => run({ group: g, exactIds: ['1'], approxIds: g === 't2' ? [] : ['1'] }));
    const groups = aggregateByGroup(runs);
    expect(groups.map((g) => g.group)).toEqual(['big', 't2', 't10']);
    expect(groups.find((g) => g.group === 't2')).toMatchObject({ cases: 2, recall: 0, shortRate: 1 });
    expect(groups.find((g) => g.group === 'big')).toMatchObject({ cases: 1, recall: 1, shortRate: 0 });
  });

  it('naturalCompare orders numbers numerically', () => {
    expect(['10', '9', '1', '100'].sort(naturalCompare)).toEqual(['1', '9', '10', '100']);
  });
});
