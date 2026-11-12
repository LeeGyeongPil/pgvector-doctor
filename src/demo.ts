// demo — 연습용 목(mock) 모드. 서버·Docker·네트워크 없이 프로세스 안 PGlite(진짜 PostgreSQL + pgvector, WASM)로
// 세 장면을 보여 준다: ① 가짜 만점 차단 ② 작은 테넌트 recall 붕괴 ③ 가장 싼 설정 추천.
import { type Queryable, pgliteQueryable } from './db.js';
import { createFixture } from './fixture.js';
import { parseTemplate } from './template.js';
import { casesFromSql } from './cases.js';
import { measure } from './measure.js';
import { sweep } from './sweep.js';
import { textTable, groupRows, notIndexedLines, recommendationLines, renderMeasure, summaryTable } from './report.js';
import { t, type Lang } from './i18n.js';

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
  /** 설명 문구 언어(기본 영어). 질의 SQL·사례 그룹 이름 같은 데이터는 번역하지 않는다. */
  lang?: Lang;
}

export async function demo(opts: DemoOptions): Promise<void> {
  const say = opts.out;
  const lang = opts.lang ?? 'en';
  // PGlite 는 demo 에서만 쓰므로 여기서 늦게 불러온다(라이브러리 사용자는 26MB WASM 을 로드하지 않는다).
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const pglite = await PGlite.create({ extensions: { vector } });
  const db: Queryable = pgliteQueryable(pglite);

  try {
    say(t(lang, 'demo.title'));
    say(t(lang, 'demo.intro1'));
    say(t(lang, 'demo.intro2'));
    say('');

    const info = await createFixture(db, { seed: opts.seed ?? 42 });
    const pgVersion = String((await db.query('SHOW server_version')).rows[0]?.server_version ?? '?');
    const vecVersion = String((await db.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0]?.extversion ?? '?');
    say(t(lang, 'demo.versions', { pg: pgVersion, vector: vecVersion }));
    say(t(lang, 'demo.table', { rows: info.rows, dim: info.dim, opclass: info.opclass, small: info.smallTenants }));
    say(t(lang, 'demo.query', { query: DEMO_QUERY }));
    say(t(lang, 'demo.cases'));
    say('');

    const template = parseTemplate(DEMO_QUERY);
    const cases = await casesFromSql(db, DEMO_CASES_SQL, template, 50);

    // ① 플래너에게 맡기기 — 작은 테넌트는 btree/순차 스캔으로 돌아 '정확 검색'이 된다. 이 recall 1.0 은 인덱스 품질이 아니다.
    say(t(lang, 'demo.scene1'));
    const free = await measure(db, { template, cases });
    const freeRes = free.results[0]!;
    say(renderMeasure({ command: 'measure', result: free }, 'table', lang).trimEnd());
    say('');
    say(t(lang, 'demo.scene1-note1'));
    say(t(lang, 'demo.scene1-note2'));
    if (notIndexedLines(freeRes).length === 0) say(t(lang, 'demo.scene1-all-indexed'));
    say('');

    // ②+③ 측정용으로 벡터 인덱스를 강제하고 격자 스윕 — ef40/off 행이 장면 ②, 추천이 장면 ③.
    const swept = await sweep(db, { template, cases, forceIndex: true, target: 0.95 });
    const base = swept.results.find((r) => r.config.efSearch === 40 && r.config.iterativeScan === 'off')!;

    say(t(lang, 'demo.scene2', { label: base.label }));
    say(
      textTable(
        [t(lang, 'head.config'), t(lang, 'head.group'), t(lang, 'head.cases'), t(lang, 'head.recall'), t(lang, 'head.short'), t(lang, 'head.index-used')],
        groupRows(base).rows.map((r) => [base.label, ...r]),
        ['l', 'l', 'r', 'r', 'r', 'r'],
      ),
    );
    say('');
    say(t(lang, 'demo.scene2-note1'));
    say(t(lang, 'demo.scene2-note2'));
    say('');

    say(t(lang, 'demo.scene3'));
    say(summaryTable(swept.results, false, lang));
    say('');
    for (const line of recommendationLines(swept.recommendation, swept.k, false, lang)) say(line);
    say('');
    say(t(lang, 'demo.try'));
    say('  npx pgvector-doctor check  --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql');
    say('  npx pgvector-doctor sweep  --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql --force-index');
    say('  npx pgvector-doctor measure --url "$DATABASE_URL" --query search.sql --cases-sql cases.sql --min-recall 0.95');
  } finally {
    await pglite.close();
  }
}
