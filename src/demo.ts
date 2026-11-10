// demo — 연습용 목(mock) 모드. 서버·Docker·네트워크 없이 프로세스 안 PGlite(진짜 PostgreSQL + pgvector, WASM)로
// 세 장면을 보여 준다: ① 가짜 만점 차단 ② 작은 테넌트 recall 붕괴 ③ 가장 싼 설정 추천.
import { type Queryable, pgliteQueryable } from './db.js';
import { createFixture } from './fixture.js';
import { parseTemplate } from './template.js';
import { casesFromSql } from './cases.js';
import { measure } from './measure.js';
import { sweep } from './sweep.js';
import { textTable, groupRows, notIndexedLines, recommendationLines, renderMeasure, summaryTable } from './report.js';

export const DEMO_QUERY = 'SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10';

/** 큰 테넌트 20건 + 작은 테넌트 30곳에서 1건씩. 질의 벡터를 테이블에서 뽑으므로 self_id 로 자기 행을 뺀다. */
export const DEMO_CASES_SQL = `
(SELECT embedding AS vector, tenant_id AS p2, id AS self_id, 'big tenant (50% of rows)' AS "group"
   FROM items WHERE tenant_id = 0 ORDER BY md5(id::text) LIMIT 20)
UNION ALL
(SELECT DISTINCT ON (tenant_id) embedding, tenant_id, id, 'small tenants (1% each)'
   FROM items WHERE tenant_id BETWEEN 1 AND 30 ORDER BY tenant_id, md5(id::text))`;

export interface DemoOptions {
  seed?: number;
  out: (line: string) => void;
}

export async function demo(opts: DemoOptions): Promise<void> {
  const say = opts.out;
  // PGlite 는 demo 에서만 쓰므로 여기서 늦게 불러온다(라이브러리 사용자는 26MB WASM 을 로드하지 않는다).
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const pglite = await PGlite.create({ extensions: { vector } });
  const db: Queryable = pgliteQueryable(pglite);

  try {
    say('pgvector-doctor demo — practice (mock) mode');
    say('  In-process PGlite (real PostgreSQL + pgvector compiled to WASM) with seeded synthetic data.');
    say('  recall / LIMIT-short / index-use results are real; latency numbers are WASM numbers, not your server.');
    say('');

    const info = await createFixture(db, { seed: opts.seed ?? 42 });
    const pgVersion = String((await db.query('SHOW server_version')).rows[0]?.server_version ?? '?');
    const vecVersion = String((await db.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0]?.extversion ?? '?');
    say(`PostgreSQL ${pgVersion} · pgvector ${vecVersion}`);
    say(
      `table items: ${info.rows} rows, ${info.dim}-dim, HNSW (${info.opclass}) + btree on tenant_id; tenant 0 = 50% of rows, tenants 1..${info.smallTenants} = 1% each`,
    );
    say(`query: ${DEMO_QUERY}`);
    say('cases: 20 vectors from the big tenant + 1 from each of 30 small tenants (self row excluded)');
    say('');

    const template = parseTemplate(DEMO_QUERY);
    const cases = await casesFromSql(db, DEMO_CASES_SQL, template, 50);

    // ① 플래너에게 맡기기 — 작은 테넌트는 btree/순차 스캔으로 돌아 '정확 검색'이 된다. 이 recall 1.0 은 인덱스 품질이 아니다.
    say('━━ Scene 1 — let the planner decide (default ef_search=40, iterative_scan=off)');
    const free = await measure(db, { template, cases });
    const freeRes = free.results[0]!;
    say(renderMeasure({ command: 'measure', result: free }, 'table').trimEnd());
    say('');
    say('  → Queries that skip the vector index return exact results, so their recall is a fake 100%.');
    say('    pgvector-doctor checks EXPLAIN for the HNSW index by name and leaves those queries out of recall@k.');
    if (notIndexedLines(freeRes).length === 0) say('  (this run: every query used the vector index)');
    say('');

    // ②+③ 측정용으로 벡터 인덱스를 강제하고 격자 스윕 — ef40/off 행이 장면 ②, 추천이 장면 ③.
    const swept = await sweep(db, { template, cases, forceIndex: true, target: 0.95 });
    const base = swept.results.find((r) => r.config.efSearch === 40 && r.config.iterativeScan === 'off')!;

    say(`━━ Scene 2 — force the vector index (--force-index), ${base.label}`);
    say(textTable(['config', 'group', 'cases', 'recall@k', 'short', 'index used'], groupRows(base).rows.map((r) => [base.label, ...r]), ['l', 'l', 'r', 'r', 'r', 'r']));
    say('');
    say('  → HNSW collects ef_search=40 nearest candidates first and applies WHERE tenant_id afterwards.');
    say('    A 1% tenant keeps ~0.4 of those 40 rows: LIMIT 10 comes back short and recall collapses — with no error.');
    say('');

    say('━━ Scene 3 — sweep ef_search × iterative_scan and pick the cheapest config that meets recall@10 >= 0.95');
    say(summaryTable(swept.results));
    say('');
    for (const line of recommendationLines(swept.recommendation, swept.k)) say(line);
    say('');
    say('Try it on your database (read-only transactions, SET LOCAL only):');
    say('  npx pgvector-doctor check  --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql');
    say('  npx pgvector-doctor sweep  --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql --force-index');
    say('  npx pgvector-doctor measure --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql --min-recall 0.95');
  } finally {
    await pglite.close();
  }
}
