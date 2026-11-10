// AC-9 — 시드 결정성·환경 무의존(로캘)
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureRows, fixtureHash, mulberry32, createFixture } from '../src/fixture.js';
import { renderMeasure } from '../src/report.js';
import type { MeasureResult } from '../src/measure.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 보고서 렌더링 확인용 최소 측정 결과 */
const sample: MeasureResult = {
  k: 10,
  cases: 2,
  forceIndex: true,
  pgvector: '0.8.7',
  vectorIndexes: ['items_embedding_idx'],
  warnings: [],
  results: [
    {
      label: 'ef_search=40 iterative_scan=off',
      config: { efSearch: 40, iterativeScan: 'off' },
      effective: { efSearch: '40', iterativeScan: 'off', maxScanTuples: '20000' },
      summary: { cases: 2, emptyCases: 0, indexUsedRatio: 1, recall: 0.5, observedRecall: 0.5, shortRate: 0.5, p50Ms: 1234.5, p95Ms: 2.25, meanBuffers: 1500.25 },
      groups: [],
      notIndexed: [],
    },
  ],
};

describe('fixture determinism', () => {
  it('same seed gives identical vectors', () => {
    const a = fixtureRows({ seed: 7, rows: 300 });
    const b = fixtureRows({ seed: 7, rows: 300 });
    expect(fixtureHash(a)).toBe(fixtureHash(b));
    expect(a[0]!.embedding).toMatch(/^\[-?\d\.\d{4}(,-?\d\.\d{4}){31}\]$/);
  });

  it('different seed differs', () => {
    expect(fixtureHash(fixtureRows({ seed: 7, rows: 300 }))).not.toBe(fixtureHash(fixtureRows({ seed: 8, rows: 300 })));
  });

  it('tenant split is exact: tenant 0 = 50%, tenants 1..50 = 1% each', () => {
    const rows = fixtureRows();
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.tenantId, (counts.get(r.tenantId) ?? 0) + 1);
    expect(counts.get(0)).toBe(2500);
    expect(counts.size).toBe(51);
    for (let t = 1; t <= 50; t++) expect(counts.get(t)).toBe(50);
  });

  it('mulberry32 is a fixed sequence', () => {
    const r = mulberry32(42);
    const first = [r(), r(), r()].map((x) => x.toFixed(6));
    const again = mulberry32(42);
    expect([again(), again(), again()].map((x) => x.toFixed(6))).toEqual(first);
    for (const x of first) expect(Number(x)).toBeGreaterThanOrEqual(0);
  });

  it('createFixture rejects values that would be spliced into SQL unchecked', async () => {
    // DB 에 닿기 전에 거부되므로 query 가 불리면 안 된다
    const db = { query: async () => expect.unreachable('query must not run') as never };
    await expect(createFixture(db, { table: 'items; DROP TABLE x' })).rejects.toThrow(/invalid table name/);
    // 타입 검사가 없는 JS 호출자를 흉내 낸다
    const badOpclass = 'vector_cosine_ops); DROP TABLE x; --' as 'vector_cosine_ops';
    await expect(createFixture(db, { opclass: badOpclass })).rejects.toThrow(/invalid opclass/);
    await expect(createFixture(db, { dim: 1.5 })).rejects.toThrow(/invalid dim/);
  });

  it('number formatting ignores locale (LANG=de_DE)', () => {
    // 같은 계산을 독일어 로캘 환경의 별도 Node 프로세스에서 — 소수점이 ',' 로 바뀌면 해시·보고서가 달라진다.
    const parentHash = fixtureHash(fixtureRows({ seed: 3, rows: 200 }));
    const parentReport = renderMeasure({ command: 'measure', result: sample }, 'table');
    const script = `
      const { fixtureRows, fixtureHash, renderMeasure } = require('./dist/index.js');
      const sample = ${JSON.stringify(sample)};
      process.stdout.write(JSON.stringify({
        hash: fixtureHash(fixtureRows({ seed: 3, rows: 200 })),
        report: renderMeasure({ command: 'measure', result: sample }, 'table'),
        localeSample: (1234.5).toLocaleString(),
      }));`;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', TZ: 'Pacific/Chatham' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const got = JSON.parse(child.stdout) as { hash: string; report: string; localeSample: string };
    expect(got.hash).toBe(parentHash);
    expect(got.report).toBe(parentReport);
    expect(got.report).toContain('1500.3'); // 1,500.3 이나 1500,3 이 아님
    expect(got.report).toContain('1234.50');
    expect(got.report).toContain('50.0%');
  });
});
