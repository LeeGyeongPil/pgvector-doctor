// AC-6 — check 진단 코드와 잘못된 템플릿 거부
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, captureIO, type TestDb } from './helpers/pglite.js';
import { check, type CheckResult } from '../src/check.js';
import { parseTemplate, TemplateError } from '../src/template.js';
import { casesFromSql } from '../src/cases.js';
import { run } from '../src/cli.js';

const codes = (r: CheckResult) => r.diagnostics.map((d) => d.code);
const SMALL_CASE_SQL = `SELECT embedding AS vector, tenant_id AS p2 FROM items WHERE tenant_id = 7 ORDER BY id LIMIT 1`;

describe('template validation (no DB)', () => {
  it('rejects templates without $1, without LIMIT or with two statements', () => {
    expect(() => parseTemplate('SELECT id FROM items ORDER BY embedding <=> $2 LIMIT 10')).toThrow(TemplateError);
    expect(() => parseTemplate('SELECT id FROM items ORDER BY embedding <=> $1')).toThrow(/LIMIT/);
    expect(() => parseTemplate('SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10; DROP TABLE items')).toThrow(/single statement/);
    expect(() => parseTemplate('SELECT id FROM items ORDER BY id LIMIT 10 -- $1')).toThrow(/\$1/);
  });

  it('reads the last LIMIT, ignores strings and comments, finds distance operators', () => {
    const t = parseTemplate(`WITH r AS MATERIALIZED (
        SELECT id, embedding <=> $1 AS d FROM items WHERE note <> 'a;b LIMIT 3' ORDER BY d LIMIT 40
      ) SELECT id FROM r ORDER BY d + 0 LIMIT 10; -- trailing comment LIMIT 99`);
    expect(t.limit).toBe(10);
    expect(t.operators).toEqual(['<=>']);
    const p = parseTemplate('SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <-> $1 LIMIT $3');
    expect(p).toMatchObject({ limit: null, limitParam: 3, maxParam: 3, operators: ['<->'] });
  });
});

describe('check diagnostics (PGlite + fixture with a cosine HNSW index)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await startDb({ socket: true });
    // 벡터 인덱스가 없는 테이블 하나
    await t.db.query('CREATE TABLE docs (id int PRIMARY KEY, embedding vector(32))');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('a correct template gets zero warnings (generic plan and sample case)', async () => {
    const template = 'SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10';
    const generic = await check(t.db, { template });
    expect(generic.plan.mode).toBe('generic-plan');
    expect(generic.diagnostics).toEqual([]);
    expect(generic.pgvector).toMatch(/^0\.8\./);
    expect(generic.indexes.map((i) => i.index)).toEqual(['items_embedding_idx']);

    const p = parseTemplate(template);
    const cases = await casesFromSql(t.db, 'SELECT embedding AS vector FROM items WHERE id = 1', p, 1);
    const sample = await check(t.db, { template: p, cases });
    expect(sample.plan.mode).toBe('sample-case');
    expect(sample.plan.vectorIndexUsed).toBe(true);
    expect(sample.diagnostics).toEqual([]);
  });

  it('opclass-mismatch: <-> (l2) against a vector_cosine_ops index', async () => {
    const r = await check(t.db, { template: 'SELECT id FROM items ORDER BY embedding <-> $1 LIMIT 10' });
    expect(codes(r)).toContain('opclass-mismatch');
    expect(codes(r)).toContain('index-not-used');
    expect(r.diagnostics.find((d) => d.code === 'opclass-mismatch')?.level).toBe('error');
  });

  it('limit-exceeds-ef-search: LIMIT 100 > hnsw.ef_search 40 with iterative scan off', async () => {
    const r = await check(t.db, { template: 'SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 100' });
    expect(codes(r)).toEqual(['limit-exceeds-ef-search']);
    expect(r.diagnostics[0]!.message).toMatch(/LIMIT 100 > hnsw\.ef_search 40/);
  });

  it('index-not-used: planner picks the tenant btree for a 1% tenant', async () => {
    const p = parseTemplate('SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10');
    const cases = await casesFromSql(t.db, SMALL_CASE_SQL, p, 1);
    const r = await check(t.db, { template: p, cases });
    expect(codes(r)).toEqual(['index-not-used']);
    expect(r.diagnostics[0]!.message).toMatch(/items_tenant_id_idx/);
    // 측정용 강제 옵션이면 벡터 인덱스를 탄다
    const forced = await check(t.db, { template: p, cases, forceIndex: true });
    expect(codes(forced)).toEqual([]);
  });

  it('pgvector-too-old (version injected as 0.7.4)', async () => {
    const r = await check(t.db, { template: 'SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10', pgvectorVersionOverride: '0.7.4' });
    expect(codes(r)).toEqual(['pgvector-too-old']);
    expect(r.diagnostics[0]!.level).toBe('warn');
  });

  it('no-vector-index on a table without hnsw/ivfflat', async () => {
    const r = await check(t.db, { template: 'SELECT id FROM docs ORDER BY embedding <=> $1 LIMIT 10' });
    expect(codes(r)).toEqual(['no-vector-index']);
  });

  it('generic plan leaves no prepared statement or setting behind, even when planning fails', async () => {
    const prepared = async () => Number((await t.db.query('SELECT count(*)::int AS n FROM pg_prepared_statements')).rows[0]?.n);
    const mode = async () => (await t.db.query('SHOW plan_cache_mode')).rows[0]?.plan_cache_mode;
    expect(await prepared()).toBe(0);
    await check(t.db, { template: 'SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10' });
    expect(await prepared()).toBe(0);
    // PREPARE 는 되지만 EXPLAIN EXECUTE(플랜 단계)에서 실패 → 트랜잭션 롤백 뒤에도 DEALLOCATE 가 된다. 진짜 SQL 오류라 던진다.
    await expect(check(t.db, { template: 'SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10 OFFSET 1/0' })).rejects.toThrow(/division by zero/);
    expect(await prepared()).toBe(0);
    expect(await mode()).toBe('auto');
  });

  it('plan-check-skipped (not OK) when parameter types are unknown or the plan reads no table', async () => {
    // ($2 IS NULL OR …) 처럼 문맥에 타입이 없으면 PREPARE 가 "could not determine data type of parameter $2" 를 낸다
    const untyped = await check(t.db, { template: 'SELECT id FROM items WHERE $2 IS NULL ORDER BY embedding <=> $1 LIMIT 10' });
    expect(untyped.plan.mode).toBe('skipped');
    expect(codes(untyped)).toEqual(['plan-check-skipped']);

    const noTable = await check(t.db, { template: "SELECT 1 AS id ORDER BY '[1,2,3]'::vector <=> $1 LIMIT 10" });
    expect(noTable.plan.mode).toBe('skipped');
    expect(codes(noTable)).toEqual(['plan-check-skipped']);
    const io = captureIO();
    expect(await run(['check', '--url', t.url!, '--query', "SELECT 1 AS id ORDER BY '[1,2,3]'::vector <=> $1 LIMIT 10"], io)).toBe(0);
    expect(io.out()).not.toMatch(/OK no problems found/);
    expect(io.out()).toMatch(/INFO +plan-check-skipped/);
  });

  it('CLI: check without cases exits 2 on a real SQL error instead of skipping', async () => {
    const io = captureIO();
    expect(await run(['check', '--url', t.url!, '--query', 'SELECT id FROM no_such_table ORDER BY embedding <=> $1 LIMIT 10'], io)).toBe(2);
    expect(io.err()).toMatch(/no_such_table/);
  });

  it('CLI: check exit codes — 0 clean, 1 on error diagnostics, 2 on a bad template', async () => {
    const ok = captureIO();
    expect(await run(['check', '--url', t.url!, '--query', 'SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10'], ok)).toBe(0);
    expect(ok.out()).toMatch(/OK no problems found/);

    const mismatch = captureIO();
    expect(await run(['check', '--url', t.url!, '--query', 'SELECT id FROM items ORDER BY embedding <-> $1 LIMIT 10'], mismatch)).toBe(1);
    expect(mismatch.out()).toMatch(/ERROR opclass-mismatch/);

    for (const bad of ['SELECT id FROM items ORDER BY embedding <=> $2 LIMIT 10', 'SELECT id FROM items ORDER BY embedding <=> $1']) {
      const io = captureIO();
      expect(await run(['check', '--url', t.url!, '--query', bad], io)).toBe(2);
      expect(io.err()).toMatch(/^error: query template must/);
    }
  });
});
