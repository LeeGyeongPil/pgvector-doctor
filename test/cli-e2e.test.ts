// AC-4 — 실제 코드 경로(node-postgres 드라이버 → pglite-socket, 127.0.0.1 임의 포트)로 measure, 필터 값별 분해
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDb, captureIO, type TestDb, CASES_BY_TENANT_SQL, FILTER_QUERY } from './helpers/pglite.js';
import { run } from '../src/cli.js';

interface GroupJson {
  group: string;
  cases: number;
  recall: number | null;
  shortRate: number | null;
  indexUsedRatio: number;
}

describe('measure via pg driver', () => {
  let t: TestDb;
  let dir: string;
  beforeAll(async () => {
    t = await startDb({ socket: true });
    dir = mkdtempSync(join(tmpdir(), 'pgvd-e2e-'));
  });
  afterAll(async () => {
    await t?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('measure via pg driver breaks down recall per filter value', async () => {
    // 템플릿·사례를 파일로(실사용과 같은 모양)
    writeFileSync(join(dir, 'search.sql'), `${FILTER_QUERY};\n`);
    writeFileSync(join(dir, 'cases.sql'), CASES_BY_TENANT_SQL);
    const io = captureIO({}, dir);
    const code = await run(
      ['measure', '--url', t.url!, '--query', 'search.sql', '--cases-sql', 'cases.sql', '--ef', '40', '--iterative', 'off', '--force-index', '--format', 'json'],
      io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(io.out());
    expect(report.pgvector).toMatch(/^0\.8\./);
    expect(report.cases).toBe(45);
    const res = report.results[0];
    expect(res.label).toBe('ef_search=40 iterative_scan=off');
    expect(res.indexUsedRatio).toBe(1);

    // group 열이 없으니 p2(tenant_id) 값별로 나뉜다: '0' = 큰 테넌트, '1'..'10' = 작은 테넌트
    const groups: GroupJson[] = res.groups;
    expect(groups.map((g) => g.group)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const big = groups.find((g) => g.group === '0')!;
    expect(big.cases).toBe(15);
    expect(big.recall!).toBeGreaterThanOrEqual(0.7);
    const small = groups.filter((g) => g.group !== '0');
    for (const g of small) {
      expect(g.cases).toBe(3);
      expect(g.recall!).toBeLessThanOrEqual(0.3);
      expect(g.shortRate!).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('the shipped examples/search.sql + examples/cases.sql work as documented', async () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const io = captureIO({}, repo);
    const code = await run(
      ['sweep', '--url', t.url!, '--query', 'examples/search.sql', '--cases-sql', 'examples/cases.sql', '--force-index', '--format', 'json'],
      io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(io.out());
    expect(report.cases).toBe(50);
    expect(report.results[0].groups.every((g: GroupJson) => g.group.startsWith('tenant '))).toBe(true);
    expect(report.recommendation.setLocal[0]).toMatch(/^SET LOCAL hnsw\.ef_search = \d+;$/);
  });

  it('JSONL cases give the same breakdown shape', async () => {
    const rows = (
      await t.db.query(
        `SELECT embedding::text AS vector, tenant_id AS p2, id AS self_id FROM items WHERE tenant_id IN (0, 3) ORDER BY id LIMIT 6`,
      )
    ).rows;
    writeFileSync(join(dir, 'cases.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const io = captureIO({}, dir);
    const code = await run(['measure', '--url', t.url!, '--query', FILTER_QUERY, '--cases', 'cases.jsonl', '--force-index', '--format', 'json'], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.out());
    expect(report.cases).toBe(6);
    expect(report.results[0].groups.map((g: GroupJson) => g.group)).toEqual(['0', '3']);
  });
});
