// AC-2 — 가짜 만점 차단: 벡터 인덱스를 안 탄 질의는 recall 에 넣지 않고, 추천·게이트에서도 걸러 낸다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, captureIO, type TestDb } from './helpers/pglite.js';
import { analyzePlan } from '../src/plan.js';
import { measure } from '../src/measure.js';
import { parseTemplate } from '../src/template.js';
import { casesFromSql } from '../src/cases.js';
import { recommend } from '../src/recommend.js';
import { run } from '../src/cli.js';

/** 작은 테넌트 사례만 — 플래너가 tenant_id btree 를 고르는 쪽 */
const SMALL_CASES_SQL = `SELECT DISTINCT ON (tenant_id) embedding AS vector, tenant_id AS p2, id AS self_id
  FROM items WHERE tenant_id BETWEEN 1 AND 12 ORDER BY tenant_id, md5(id::text)`;

describe('plan verdict (unit)', () => {
  const vectorIdx = new Set(['items_embedding_idx']);
  it('only an index listed as hnsw/ivfflat in the catalog counts', () => {
    const btree = { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Sort', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'items_tenant_id_idx', 'Relation Name': 'items' }] }] };
    const hnsw = { 'Node Type': 'Limit', 'Shared Hit Blocks': 30, 'Shared Read Blocks': 2, Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'items_embedding_idx', 'Relation Name': 'items' }] };
    expect(analyzePlan(btree, vectorIdx)).toMatchObject({ vectorIndexUsed: false, buffers: null, relations: ['items'] });
    expect(analyzePlan(btree, vectorIdx).scans[0]).toBe('Index Scan using items_tenant_id_idx (not a vector index)');
    expect(analyzePlan(hnsw, vectorIdx)).toMatchObject({ vectorIndexUsed: true, buffers: 32 });
  });
});

describe('fake perfect recall is blocked (PGlite + fixture)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await startDb({ socket: true });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('seq scan is reported as not-indexed, not recall 1.0', async () => {
    // 거리식을 감싸면(… * 1) 인덱스 순서와 맞지 않아 플래너가 순차 스캔 + 정렬을 고른다 → 결과는 정확(1.0)
    const template = parseTemplate('SELECT id FROM items ORDER BY (embedding <=> $1) * 1 LIMIT 10');
    const cases = await casesFromSql(t.db, 'SELECT embedding AS vector, id AS self_id FROM items ORDER BY md5(id::text) LIMIT 8', template, 50);
    const m = await measure(t.db, { template, cases });
    const r = m.results[0]!;
    expect(r.summary.indexUsedRatio).toBe(0);
    expect(r.summary.recall).toBeNull(); // 가짜 1.0 이 아니라 '측정 불가'
    expect(r.summary.observedRecall).toBe(1); // 실제로 받은 결과는 정확 검색이라 1.0
    expect(r.notIndexed[0]?.reason).toMatch(/Seq Scan on items/);
    expect(r.notIndexed[0]?.count).toBe(8);
    // 추천 후보에서도 빠진다
    const rec = recommend(m.results);
    expect(rec.choice).toBeNull();
    expect(rec.rejected[0]?.why).toMatch(/^index-not-used/);
  });

  it('btree index scan does not count as vector index use', async () => {
    const template = parseTemplate('SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10');
    const cases = await casesFromSql(t.db, SMALL_CASES_SQL, template, 50);
    const m = await measure(t.db, { template, cases });
    const r = m.results[0]!;
    // 1% 테넌트는 플래너가 tenant_id btree(비트맵/인덱스 스캔)를 고른다 — 'Index Scan' 글자가 있어도 벡터 인덱스가 아니다
    expect(r.summary.indexUsedRatio).toBe(0);
    expect(r.summary.recall).toBeNull();
    expect(r.notIndexed.map((n) => n.reason).join(' ')).toMatch(/items_tenant_id_idx \(not a vector index\)/);

    // 같은 사례를 --force-index 로 재면 벡터 인덱스를 타고, 진짜 recall 이 드러난다
    const forced = await measure(t.db, { template, cases, forceIndex: true });
    expect(forced.results[0]!.summary.indexUsedRatio).toBe(1);
    expect(forced.results[0]!.summary.recall!).toBeLessThan(0.3);
  });

  it('gate fails with index-not-used unless --min-index-use 0', async () => {
    const base = [
      'measure',
      '--url', t.url!,
      '--query', 'SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10',
      '--cases-sql', SMALL_CASES_SQL,
      '--min-recall', '0.9',
    ];
    const io = captureIO();
    expect(await run(base, io)).toBe(1);
    expect(io.err()).toMatch(/FAIL index-not-used/);
    expect(io.out()).toMatch(/index not used for 12\/12 queries — recall not counted/);

    // 완화하면 앱이 실제로 받는 결과(정확 스캔)의 recall 로 판정한다
    const relaxed = captureIO();
    expect(await run([...base, '--min-index-use', '0'], relaxed)).toBe(0);
    expect(relaxed.err()).toBe('');
    expect(relaxed.out()).toMatch(/PASS quality gate/);
  });
});
