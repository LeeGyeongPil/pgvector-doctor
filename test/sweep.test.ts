// AC-5 (통합) — 픽스처에서 기본 격자 스윕과 추천
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, type TestDb, CASES_BIG_SMALL_SQL, FILTER_QUERY } from './helpers/pglite.js';
import { sweep, buildGrid, setLocalStatements, parseIntList, parseIterativeList } from '../src/sweep.js';
import { parseTemplate, UsageError } from '../src/template.js';
import { casesFromSql } from '../src/cases.js';

describe('buildGrid', () => {
  it('default grid: ef 40/100/200/400 × off/strict/relaxed, max_scan_tuples only where iterative scan is on', () => {
    const { configs, warnings } = buildGrid({}, '0.8.7');
    expect(warnings).toEqual([]);
    expect(configs).toHaveLength(12);
    expect(configs.filter((c) => c.iterativeScan === 'off').every((c) => c.maxScanTuples === undefined)).toBe(true);
    expect(configs.filter((c) => c.iterativeScan !== 'off').every((c) => c.maxScanTuples === 20000)).toBe(true);
    expect(configs.map((c) => c.efSearch).slice(0, 4)).toEqual([40, 100, 200, 400]);
  });

  it('drops the iterative_scan axis for pgvector < 0.8.0 and warns', () => {
    const { configs, warnings } = buildGrid({}, '0.7.4');
    expect(configs).toEqual([{ efSearch: 40 }, { efSearch: 100 }, { efSearch: 200 }, { efSearch: 400 }]);
    expect(warnings[0]).toMatch(/0\.7\.4 < 0\.8\.0/);
  });

  it('rejects out-of-range or non-numeric values', () => {
    expect(() => buildGrid({ efSearch: [0] }, '0.8.7')).toThrow(UsageError);
    expect(() => buildGrid({ efSearch: [1001] }, '0.8.7')).toThrow(UsageError);
    expect(() => parseIntList('40; DROP TABLE items', '--ef', 1, 1000)).toThrow(UsageError);
    expect(() => parseIntList('40,1e3', '--ef', 1, 1000)).toThrow(UsageError);
    expect(parseIntList('40, 100,40', '--ef', 1, 1000)).toEqual([40, 100]);
    expect(() => parseIterativeList("relaxed_order'; --")).toThrow(UsageError);
  });

  it('SET LOCAL statements', () => {
    expect(setLocalStatements({ efSearch: 40, iterativeScan: 'relaxed_order', maxScanTuples: 20000 })).toEqual([
      'SET LOCAL hnsw.ef_search = 40;',
      'SET LOCAL hnsw.iterative_scan = relaxed_order;',
      'SET LOCAL hnsw.max_scan_tuples = 20000;',
    ]);
    expect(setLocalStatements({ efSearch: 200, iterativeScan: 'off' })).toEqual([
      'SET LOCAL hnsw.ef_search = 200;',
      'SET LOCAL hnsw.iterative_scan = off;',
    ]);
  });
});

describe('sweep on the seeded fixture (PGlite)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await startDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('recommends a config with recall >= 0.95 on the vector index, not ef_search=40 iterative_scan=off', async () => {
    const template = parseTemplate(FILTER_QUERY);
    const cases = await casesFromSql(t.db, CASES_BIG_SMALL_SQL, template, 50);
    const result = await sweep(t.db, { template, cases, forceIndex: true, target: 0.95 });

    expect(result.results).toHaveLength(12);
    const choice = result.recommendation.choice;
    expect(choice).not.toBeNull();
    expect(choice!.summary.recall!).toBeGreaterThanOrEqual(0.95);
    expect(choice!.summary.indexUsedRatio).toBe(1);
    expect(choice!.label).not.toBe('ef_search=40 iterative_scan=off');
    expect(result.recommendation.cost).toBe('buffers');

    // 기준 설정(ef40/off)은 목표 미달로 탈락해 있어야 한다
    const base = result.results.find((r) => r.label === 'ef_search=40 iterative_scan=off')!;
    expect(base.summary.recall!).toBeLessThan(0.95);
    expect(result.recommendation.rejected.map((r) => r.label)).toContain('ef_search=40 iterative_scan=off');
  });
});
