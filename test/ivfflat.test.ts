// IVFFlat 인덱스만 쓰는 질의: check 는 WARN ivfflat-not-tuned, measure·sweep 은 표 위 경고 1줄(en/ko).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, captureIO, type TestDb } from './helpers/pglite.js';
import { check } from '../src/check.js';
import { measure } from '../src/measure.js';
import { localizeWarning } from '../src/i18n.js';
import { run } from '../src/cli.js';

const IVF_QUERY = 'SELECT id FROM iv ORDER BY embedding <=> $1 LIMIT 10';
const HNSW_QUERY = 'SELECT id FROM hn ORDER BY embedding <=> $1 LIMIT 10';
const CASES_SQL = 'SELECT embedding AS vector FROM iv WHERE id <= 3';

describe('ivfflat-not-tuned (PGlite, ivfflat table + hnsw table)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await startDb({ socket: true, fixture: false });
    await t.db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await t.db.query('CREATE TABLE iv (id int PRIMARY KEY, embedding vector(3))');
    await t.db.query('CREATE TABLE hn (id int PRIMARY KEY, embedding vector(3))');
    for (const table of ['iv', 'hn']) {
      await t.db.query(
        `INSERT INTO ${table} SELECT g, ARRAY[random(), random(), random()]::vector FROM generate_series(1, 500) g`,
      );
    }
    await t.db.query('CREATE INDEX iv_ivf ON iv USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)');
    await t.db.query('CREATE INDEX hn_hnsw ON hn USING hnsw (embedding vector_cosine_ops)');
    await t.db.query('ANALYZE iv');
    await t.db.query('ANALYZE hn');
  });
  afterAll(async () => {
    await t?.close();
  });

  const cases = [{ group: 'all', vector: '[0.1,0.2,0.3]', params: [] }];

  it('check warns (level warn, not error) when only an ivfflat index is used', async () => {
    const r = await check(t.db, { template: IVF_QUERY, cases, forceIndex: true });
    expect(r.plan.vectorIndexUsed).toBe(true);
    const d = r.diagnostics.find((x) => x.code === 'ivfflat-not-tuned');
    expect(d?.level).toBe('warn');
    expect(d?.message).toMatch(/ivfflat index iv_ivf/);
    expect(r.diagnostics.some((x) => x.level === 'error')).toBe(false);
  });

  it('check does not warn for an hnsw index', async () => {
    const r = await check(t.db, { template: HNSW_QUERY, cases, forceIndex: true });
    expect(r.diagnostics.map((x) => x.code)).not.toContain('ivfflat-not-tuned');
  });

  it('measure puts the ivfflat sentence into warnings exactly once; hnsw has none', async () => {
    const m = await measure(t.db, { template: IVF_QUERY, cases: [...cases, ...cases], forceIndex: true });
    const hits = m.warnings.filter((w) => w.startsWith('ivfflat index iv_ivf in use'));
    expect(hits).toHaveLength(1);
    const h = await measure(t.db, { template: HNSW_QUERY, cases, forceIndex: true });
    expect(h.warnings.filter((w) => /ivfflat/.test(w))).toEqual([]);
  });

  it('localizeWarning translates the sentence to Korean and keeps GUC names', () => {
    const en = 'ivfflat index iv_ivf in use: hnsw.ef_search and hnsw.iterative_scan have no effect on it; tune ivfflat.probes instead';
    expect(localizeWarning('en', en)).toBe(en);
    const ko = localizeWarning('ko', en);
    expect(ko).toMatch(/[가-힣]/);
    expect(ko).toContain('iv_ivf');
    expect(ko).toContain('ivfflat.probes');
  });

  it('CLI check (exit 0) and sweep show the warning in en and ko', async () => {
    const args = ['--url', t.url!, '--query', IVF_QUERY, '--cases-sql', CASES_SQL, '--force-index'];
    const en = captureIO();
    expect(await run(['check', ...args], en)).toBe(0);
    expect(en.out()).toMatch(/WARN\s+ivfflat-not-tuned: the query uses ivfflat index iv_ivf/);
    expect(en.out()).not.toContain('no problems found');

    const ko = captureIO();
    expect(await run(['check', ...args, '--lang', 'ko'], ko)).toBe(0);
    expect(ko.out()).toMatch(/ivfflat-not-tuned: 질의가 쓰는 ivfflat 인덱스: iv_ivf/);

    const sweepEn = captureIO();
    expect(await run(['sweep', ...args], sweepEn)).toBeLessThan(2);
    expect(sweepEn.out()).toContain('ivfflat index iv_ivf in use');
    const sweepKo = captureIO();
    expect(await run(['sweep', ...args, '--lang', 'ko'], sweepKo)).toBeLessThan(2);
    expect(sweepKo.out()).toContain('ivfflat 인덱스 iv_ivf 사용 중');
  });
});
