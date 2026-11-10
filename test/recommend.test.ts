// AC-5 (순수) — 가장 싼 설정 고르기
import { describe, it, expect } from 'vitest';
import { recommend } from '../src/recommend.js';
import type { ConfigResult, HnswConfig } from '../src/measure.js';
import type { Aggregate, GroupAggregate } from '../src/metrics.js';

const agg = (over: Partial<Aggregate> = {}): Aggregate => ({
  cases: 10,
  emptyCases: 0,
  indexUsedRatio: 1,
  recall: 1,
  observedRecall: 1,
  shortRate: 0,
  p50Ms: 1,
  p95Ms: 2,
  meanBuffers: 100,
  ...over,
});

function cfg(config: HnswConfig, summary: Partial<Aggregate>, groups: Partial<GroupAggregate>[] = []): ConfigResult {
  const label = `ef_search=${config.efSearch} iterative_scan=${config.iterativeScan ?? 'off'}`;
  return {
    label,
    config,
    effective: { efSearch: String(config.efSearch), iterativeScan: config.iterativeScan ?? 'off', maxScanTuples: '20000' },
    summary: agg(summary),
    groups: groups.map((g, i) => ({ group: `g${i}`, ...agg(g) })),
    notIndexed: [],
  };
}

describe('recommend', () => {
  it('picks the passing config with the fewest mean buffers', () => {
    const rec = recommend([
      cfg({ efSearch: 40, iterativeScan: 'off' }, { recall: 0.4, meanBuffers: 10 }),
      cfg({ efSearch: 400, iterativeScan: 'off' }, { recall: 0.97, meanBuffers: 900 }),
      cfg({ efSearch: 40, iterativeScan: 'relaxed_order' }, { recall: 0.99, meanBuffers: 300 }),
    ]);
    expect(rec.cost).toBe('buffers');
    expect(rec.choice?.label).toBe('ef_search=40 iterative_scan=relaxed_order');
    expect(rec.rejected.map((r) => r.why)).toEqual(['recall-below-target (0.400 < 0.950)']);
  });

  it('breaks ties by lower ef_search, then off < strict_order < relaxed_order', () => {
    const tie = { recall: 1, meanBuffers: 50 };
    const rec = recommend([
      cfg({ efSearch: 100, iterativeScan: 'off' }, tie),
      cfg({ efSearch: 40, iterativeScan: 'relaxed_order' }, tie),
      cfg({ efSearch: 40, iterativeScan: 'strict_order' }, tie),
    ]);
    expect(rec.choice?.config).toEqual({ efSearch: 40, iterativeScan: 'strict_order' });
  });

  it('never recommends a config whose queries skipped the vector index, even with recall 1.0', () => {
    const rec = recommend([
      cfg({ efSearch: 40, iterativeScan: 'off' }, { recall: 1, indexUsedRatio: 0.4, meanBuffers: 1 }),
      cfg({ efSearch: 40, iterativeScan: 'strict_order' }, { recall: 0.96, meanBuffers: 500 }),
    ]);
    expect(rec.choice?.config.iterativeScan).toBe('strict_order');
    expect(rec.rejected[0]?.why).toMatch(/^index-not-used/);
  });

  it('returns null with a reason when nothing meets the target', () => {
    const rec = recommend([cfg({ efSearch: 40, iterativeScan: 'off' }, { recall: 0.5 }), cfg({ efSearch: 400 }, { recall: 0.9 })], {
      target: 0.95,
    });
    expect(rec.choice).toBeNull();
    expect(rec.reason).toBe('no-config-meets-target');
    expect(rec.rejected).toHaveLength(2);
  });

  it('target-scope group requires every group to meet the target', () => {
    const results = [
      // 평균은 0.96 이지만 작은 그룹이 0.6
      cfg({ efSearch: 40, iterativeScan: 'off' }, { recall: 0.96, meanBuffers: 10 }, [{ recall: 1 }, { recall: 0.6 }]),
      cfg({ efSearch: 40, iterativeScan: 'strict_order' }, { recall: 0.99, meanBuffers: 200 }, [{ recall: 1 }, { recall: 0.98 }]),
    ];
    expect(recommend(results, { targetScope: 'mean' }).choice?.config.iterativeScan).toBe('off');
    const g = recommend(results, { targetScope: 'group' });
    expect(g.choice?.config.iterativeScan).toBe('strict_order');
    expect(g.rejected[0]?.why).toBe('recall-below-target (0.600 < 0.950)');
  });

  it('respects the LIMIT-short ceiling', () => {
    const results = [
      cfg({ efSearch: 40, iterativeScan: 'off' }, { recall: 0.96, shortRate: 0.2, meanBuffers: 10 }),
      cfg({ efSearch: 40, iterativeScan: 'strict_order' }, { recall: 0.96, shortRate: 0, meanBuffers: 20 }),
    ];
    expect(recommend(results).choice?.config.iterativeScan).toBe('strict_order');
    expect(recommend(results, { maxShort: 0.25 }).choice?.config.iterativeScan).toBe('off');
  });

  it('falls back to p95 latency when buffer info is missing', () => {
    const rec = recommend([
      cfg({ efSearch: 40, iterativeScan: 'strict_order' }, { meanBuffers: null, p95Ms: 9 }),
      cfg({ efSearch: 100, iterativeScan: 'strict_order' }, { meanBuffers: null, p95Ms: 3 }),
    ]);
    expect(rec.cost).toBe('latency');
    expect(rec.choice?.config.efSearch).toBe(100);
  });
});
