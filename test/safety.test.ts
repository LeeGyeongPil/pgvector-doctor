// AC-7 — 운영 DB 안전: READ ONLY + SET LOCAL, 쓰기 템플릿 거부, 격자 값 주입 거부
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDb, captureIO, type TestDb, CASES_BIG_SMALL_SQL, FILTER_QUERY } from './helpers/pglite.js';
import { sweep } from '../src/sweep.js';
import { measure } from '../src/measure.js';
import { check } from '../src/check.js';
import { parseTemplate, maskSql, TemplateError, type ParsedTemplate } from '../src/template.js';
import { casesFromSql } from '../src/cases.js';
import { run } from '../src/cli.js';
import { connect, type Queryable } from '../src/db.js';

// ── 다중 문장 탈출 트릭 표 ─────────────────────────────────────────────
// 각 트릭은 "PostgreSQL 은 문장 여러 개로 읽지만, 허술한 검사기는 ';' 를 문자열·주석 안으로 오인"하도록 만든 꼬리다.
// 앞 SQL 뒤에 붙이면 '; COMMIT; DELETE …' 로 READ ONLY 트랜잭션을 끝내고 행을 지우려 한다.
const ESCAPE = 'COMMIT; DELETE FROM items WHERE id < 5';
const TRICKS: ReadonlyArray<readonly [name: string, tail: string]> = [
  // E'\'' = 작은따옴표 하나. 백슬래시 이스케이프를 모르면 문자열이 뒤의 ';' 까지 이어진다고 오인한다.
  ['E-string backslash quote', String.raw` OFFSET length(E'\'')-1; ${ESCAPE}; SELECT 'x'`],
  // $q$'$q$ = 달러 인용 문자열. 달러 인용을 모르면 안의 ' 를 문자열 시작으로 오인한다.
  ['dollar quote hiding a quote', ` OFFSET length($q$'$q$)-1; ${ESCAPE}; SELECT $q$'$q$`],
  // $$--$$ = 문자열 "--". 달러 인용을 모르면 -- 를 줄 주석으로 오인해 줄 끝까지 가린다.
  ['dollar quote hiding a line comment', ` OFFSET length($$--$$)-2; ${ESCAPE}`],
  // /* /* */ ' */ = 중첩 주석 하나. 중첩을 모르면 첫 */ 에서 주석이 끝나고 ' 가 문자열을 연다고 오인한다.
  ['nested block comment', ` /* /* */ ' */; ${ESCAPE}; SELECT 'x'`],
  // E'\'/*' = '/* 세 글자. 이스케이프를 모르면 /* 를 주석 시작으로 오인한다(문자열·주석 중첩).
  ['E-string hiding a block comment', String.raw` OFFSET length(E'\'/*')-3; ${ESCAPE}; SELECT '*/'`],
];
const TEMPLATE_BASE = 'SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10';
const CASES_BASE = 'SELECT embedding AS vector, tenant_id AS p2 FROM items WHERE tenant_id = 0 ORDER BY id LIMIT 2';
const SAFE_CASES = 'SELECT embedding AS vector, tenant_id AS p2 FROM items WHERE tenant_id = 0 ORDER BY id LIMIT 2';

/** 검사기(parseTemplate)를 건너뛰고 DB 로 바로 가는 위조 템플릿 — 두 번째 방어선(프로토콜)만 시험한다. */
const forged = (sql: string): ParsedTemplate => ({ sql, maxParam: 2, limit: 10, limitParam: null, operators: ['<=>'] });

const SHOWN = ['hnsw.ef_search', 'hnsw.iterative_scan', 'hnsw.max_scan_tuples', 'enable_seqscan', 'enable_sort', 'enable_indexscan', 'statement_timeout', 'transaction_read_only', 'plan_cache_mode'];

describe('safety', () => {
  let t: TestDb;
  const show = async () => {
    const out: Record<string, unknown> = {};
    for (const name of SHOWN) out[name] = (await t.db.query(`SHOW ${name}`)).rows[0]?.[name];
    return out;
  };
  const count = async () => Number((await t.db.query('SELECT count(*)::int AS n FROM items')).rows[0]?.n);

  beforeAll(async () => {
    t = await startDb({ socket: true });
    // vector 라이브러리를 로드해 hnsw.* GUC 가 보이게 한다
    await t.db.query("SELECT '[1]'::vector");
  });
  afterAll(async () => {
    await t?.close();
  });

  it('session settings are identical before and after a forced sweep on the same connection', async () => {
    const before = await show();
    expect(before['hnsw.ef_search']).toBe('40');
    const template = parseTemplate(FILTER_QUERY);
    const cases = await casesFromSql(t.db, CASES_BIG_SMALL_SQL, template, 6);
    await sweep(t.db, { template, cases, forceIndex: true, efSearch: [40, 400], timeout: '5s' });
    expect(await show()).toEqual(before);
  });

  it('a write template fails with a read-only transaction error and changes nothing', async () => {
    const rows = await count();
    const template = parseTemplate(
      'WITH d AS (DELETE FROM items WHERE id = 1 RETURNING id) SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10',
    );
    const cases = await casesFromSql(t.db, CASES_BIG_SMALL_SQL, template, 2);
    await expect(measure(t.db, { template, cases })).rejects.toThrow(/read-only transaction/);
    expect(await count()).toBe(rows);
    // 트랜잭션이 열린 채 남지 않는다(ROLLBACK 됨)
    expect((await t.db.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only).toBe('off');

    // CLI 경로(pg 드라이버)에서도 SQL 오류는 종료 코드 2
    const io = captureIO();
    const code = await run(
      ['measure', '--url', t.url!, '--query', 'WITH d AS (DELETE FROM items RETURNING id) SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10', '--cases-sql', 'SELECT embedding AS vector FROM items LIMIT 1'],
      io,
    );
    expect(code).toBe(2);
    expect(io.err()).toMatch(/read-only transaction/);
    expect(await count()).toBe(rows);
  });

  it('a cases SQL that writes is also refused', async () => {
    const rows = await count();
    const io = captureIO();
    const code = await run(
      ['measure', '--url', t.url!, '--query', FILTER_QUERY, '--cases-sql', 'WITH d AS (DELETE FROM items RETURNING *) SELECT embedding AS vector, tenant_id AS p2 FROM d'],
      io,
    );
    expect(code).toBe(2);
    expect(io.err()).toMatch(/read-only transaction/);
    expect(await count()).toBe(rows);
  });

  it("user SQL cannot escape the read-only transaction with '; COMMIT; …'", async () => {
    const io = captureIO();
    const code = await run(
      ['measure', '--url', t.url!, '--query', FILTER_QUERY, '--cases-sql', 'SELECT embedding AS vector, 0 AS p2 FROM items LIMIT 1; COMMIT; DELETE FROM items'],
      io,
    );
    expect(code).toBe(2);
    expect(io.err()).toMatch(/single statement/);
    expect(await count()).toBe(5000);

    // 두 번째 방어선: 사용자 SQL 은 확장 프로토콜로 보내므로 DB 자체가 여러 문장을 거부한다
    const { db, close } = await connect(t.url!);
    try {
      await expect(db.query('SELECT 1; DELETE FROM items', [])).rejects.toThrow(/multiple commands/);
    } finally {
      await close();
    }
    expect(await count()).toBe(5000);
  });

  it("grid values are whitelisted: --ef '40; DROP TABLE items' exits 2 before touching the DB", async () => {
    const io = captureIO();
    const code = await run(['sweep', '--url', t.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, '--ef', '40; DROP TABLE items'], io);
    expect(code).toBe(2);
    expect(io.err()).toMatch(/--ef: "40; DROP TABLE items" is not a whole number/);
    expect(await count()).toBe(5000);

    for (const [flag, value] of [
      ['--iterative', "off'; DROP TABLE items; --"],
      ['--max-scan-tuples', '1 OR 1=1'],
      ['--timeout', "30s'; DROP TABLE items; --"],
    ] as const) {
      const e = captureIO();
      expect(await run(['sweep', '--url', t.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, flag, value], e)).toBe(2);
    }
    expect(await count()).toBe(5000);
  });

  // 1차 방어선: 검사기가 트릭을 문장 두 개로 정확히 읽어 TemplateError 로 거부한다(DB 에 닿기 전).
  it.each(TRICKS)('template checker sees through the %s trick', (_name, tail) => {
    expect(() => parseTemplate(TEMPLATE_BASE + tail)).toThrow(TemplateError);
    expect(() => parseTemplate(TEMPLATE_BASE + tail)).toThrow(/single statement/);
  });

  it('the checker still accepts legitimate quotes, dollar quotes and nested comments', () => {
    const ok = parseTemplate(
      String.raw`SELECT id FROM items WHERE note <> E'it\'s; fine' AND tag <> $t$a;b'c$t$ /* outer /* inner; */ still; */ ORDER BY embedding <=> $1 LIMIT 10 -- tail; comment`,
    );
    expect(ok.limit).toBe(10);
    // 가린 사본은 원문과 길이가 같고 ';' 가 없다
    expect(maskSql(ok.sql)).toHaveLength(ok.sql.length);
    expect(maskSql(ok.sql)).not.toContain(';');
    // 식별자에 붙은 $ 는 달러 인용이 아니다(a$b$c 는 식별자 하나)
    expect(maskSql('SELECT a$b$c FROM t; x')).toContain(';');
  });

  // 모든 사용자 SQL 경로를 CLI(pg 드라이버)로: 트릭은 종료 코드 2, 행 수·세션 설정 불변.
  const PATHS: ReadonlyArray<readonly [name: string, args: (tail: string) => string[]]> = [
    ['check without cases (generic plan)', (tail) => ['check', '--query', TEMPLATE_BASE + tail]],
    ['check with a trick template and --cases-sql', (tail) => ['check', '--query', TEMPLATE_BASE + tail, '--cases-sql', SAFE_CASES]],
    ['check with a trick --cases-sql', (tail) => ['check', '--query', FILTER_QUERY, '--cases-sql', CASES_BASE + tail]],
    ['measure with a trick template', (tail) => ['measure', '--query', TEMPLATE_BASE + tail, '--cases-sql', SAFE_CASES]],
    ['measure with a trick --cases-sql', (tail) => ['measure', '--query', FILTER_QUERY, '--cases-sql', CASES_BASE + tail]],
    ['sweep with a trick template', (tail) => ['sweep', '--query', TEMPLATE_BASE + tail, '--cases-sql', SAFE_CASES, '--ef', '40']],
    ['sweep with a trick --cases-sql', (tail) => ['sweep', '--query', FILTER_QUERY, '--cases-sql', CASES_BASE + tail, '--ef', '40']],
  ];
  const TABLE = PATHS.flatMap(([path, args]) => TRICKS.map(([trick, tail]) => [path, trick, args(tail)] as const));

  it.each(TABLE)('%s: the %s trick exits 2 and changes nothing', async (_path, _trick, args) => {
    const before = await show();
    const rows = await count();
    const io = captureIO();
    const [command, ...rest] = args;
    const code = await run([command!, '--url', t.url!, ...rest], io);
    expect(io.out()).not.toMatch(/OK no problems found/);
    expect(code).toBe(2);
    expect(await count()).toBe(rows);
    expect(await show()).toEqual(before);
  });

  // 2차 방어선: 검사기를 우회한 위조 템플릿도 DB 가 한 문장만 받으므로 실행되지 않는다(두 어댑터 모두).
  describe.each(['pglite adapter', 'pg driver'] as const)('protocol guard via %s', (adapter) => {
    let db: Queryable;
    let close: () => Promise<void> = async () => {};
    beforeAll(async () => {
      if (adapter === 'pglite adapter') db = t.db;
      else ({ db, close } = await connect(t.url!));
    });
    afterAll(async () => {
      await close();
    });

    it.each(TRICKS)('a forged %s template is refused on every path', async (_name, tail) => {
      const rows = await count();
      const template = forged(TEMPLATE_BASE + tail);
      const cases = await casesFromSql(db, SAFE_CASES, parseTemplate(FILTER_QUERY), 2);
      await expect(check(db, { template })).rejects.toThrow(/multiple commands/);
      await expect(check(db, { template, cases })).rejects.toThrow(/multiple commands/);
      await expect(measure(db, { template, cases })).rejects.toThrow(/multiple commands/);
      await expect(sweep(db, { template, cases, efSearch: [40], iterativeScan: ['off'] })).rejects.toThrow(/multiple commands/);
      // 도구가 만드는 문장(파라미터 없음)도 같은 경로 — 다중 문장은 어디서도 실행되지 않는다
      await expect(db.query(CASES_BASE + tail)).rejects.toThrow(/multiple commands/);
      expect(await count()).toBe(rows);
      expect((await db.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only).toBe('off');
    });
  });
});
