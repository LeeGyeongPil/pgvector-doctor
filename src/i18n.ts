// Screen language (English / Korean) — one message table for everything the CLI prints.
//   Not translated on purpose: JSON output, rule IDs (index-not-used, recall-below-min, …), the
//   ERROR/WARN/INFO/OK/PASS/FAIL tags, SET LOCAL statements, and Postgres/driver error text.
//   Library exceptions keep their English `message`; the CLI renders `code` + `params` in the chosen language.

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];

const en = {
  // ---- help ----
  help: `pgvector-doctor {version} — measure pgvector HNSW recall for your own filtered SQL

Usage
  pgvector-doctor demo                       practice (mock) mode: in-process PGlite, no server needed
  pgvector-doctor check   --query q.sql [--cases-sql c.sql]
  pgvector-doctor measure --query q.sql --cases-sql c.sql [--min-recall 0.95]
  pgvector-doctor sweep   --query q.sql --cases-sql c.sql [--target 0.95]

Connection
  --url <postgres://…>        defaults to $DATABASE_URL. Use a replica or staging DB.

Inputs
  --query <file|sql>          search SQL: first column = row id, $1 = query vector, LIMIT required
  --cases-sql <file|sql>      SELECT returning vector (→$1), p2…pN (→$2…$N), optional self_id, "group"
  --cases <file.jsonl>        same fields as JSON lines
  --k <n>                     k when the template says LIMIT $n
  --max-cases <n>             cap on query cases (default 50)
  --timeout <30s>             statement_timeout per query (default 30s)

Measuring
  --force-index               measurement only: disable seq scan / bitmap scan / sort so the vector index is used
  --ef <n[,n…]>               hnsw.ef_search (measure: one value; sweep default 40,100,200,400)
  --iterative <v[,v…]>        off | strict_order | relaxed_order (sweep default: all three)
  --max-scan-tuples <n[,n…]>  hnsw.max_scan_tuples (sweep default 20000)

Gates and recommendation
  --min-recall <0..1>         measure: exit 1 if recall@k is below this
  --min-index-use <0..1>      measure: exit 1 if fewer queries used the vector index (default 1 when gating;
                              below 1, --min-recall is judged on the rows the app actually gets)
  --target <0..1>             sweep: recall target (default 0.95)
  --target-scope mean|group   judge the mean, or every group's minimum (default mean)
  --max-short <0..1>          allowed LIMIT-short rate (default 0)

Output
  --format table|json|md      (default table)
  --out <file>                write the report to a file (table still printed)
  --lang en|ko                screen language. Default: $PGVECTOR_DOCTOR_LANG, then $LC_ALL / $LC_MESSAGES / $LANG
                              (anything that is not Korean means English). JSON output is always English.

Exit codes: 0 ok · 1 quality gate failed / no config meets target / check error · 2 usage, connection or SQL error
Every measurement runs in BEGIN READ ONLY with SET LOCAL; nothing is written and session settings are untouched.
`,

  // ---- usage errors ----
  'err.file-not-found': '{name}: file not found: {value}',
  'err.file-not-found-short': '{name}: file not found',
  'err.fraction': '{name} must be a number between 0 and 1',
  'err.positive-int': '{name} must be a positive integer',
  'err.timeout': '--timeout must look like 30s, 500ms or 2min',
  'err.single-value': '{name}: measure takes one value (use sweep for several)',
  'err.unexpected-arg': 'unexpected argument: {arg}',
  'err.unknown-command': 'unknown command "{command}" (expected demo, check, measure or sweep)',
  'err.format': '--format must be table, json or md',
  'err.url-required': '--url is required (or set DATABASE_URL)',
  'err.url-scheme': '--url must start with postgres:// or postgresql://',
  'err.query-required': '--query is required',
  'err.target-scope': '--target-scope must be mean or group',
  'err.cases-both': 'use either --cases-sql or --cases, not both',
  'err.needs-cases': '{command} needs --cases-sql or --cases',
  'err.lang': '--lang must be en or ko (got "{value}")',
  'err.opt-unknown': "unknown option '{option}'",
  'err.opt-missing-value': "option '{option}' requires a value",
  'err.opt-no-value': "option '{option}' does not take a value",
  'err.opt-other': 'invalid arguments: {detail}',
  'err.cases-vector-missing': '{where}: missing "vector" (it fills $1)',
  'err.cases-detail': '{where}: {detail}',
  'err.cases-param-missing': '{where}: missing "{key}" (template uses {param})',
  'err.cases-sql-empty': 'cases SQL is empty',
  'err.cases-sql-single': 'cases SQL must be a single statement',
  'err.cases-json': '{where}: not valid JSON',
  'err.cases-object': '{where}: expected a JSON object',
  'err.cases-none': 'no query cases (cases SQL/JSONL returned 0 rows)',
  'err.k-conflict': '--k {k} conflicts with LIMIT {limit} in the query template',
  'err.k-needed': 'query uses LIMIT {param}; pass --k',
  'err.no-cases': 'no query cases',
  'err.no-pgvector': 'pgvector extension is not installed in this database (CREATE EXTENSION vector)',
  'err.not-whole': '{name}: "{value}" is not a whole number',
  'err.outside': '{name}: {n} is outside {min}..{max}',
  'err.iterative-values': '--iterative: "{value}" must be one of {values}',
  'err.iterative-invalid': 'iterative_scan: invalid value {value}',
  'err.int-range': '{name}: {n} must be an integer in {min}..{max}',
  'err.tpl-empty': 'query template is empty',
  'err.tpl-multi': 'query template must be a single statement (found ";" in the middle)',
  'err.tpl-no-param': 'query template must use $1 for the query vector (e.g. ORDER BY embedding <=> $1)',
  'err.tpl-no-limit': 'query template must have a LIMIT (recall@k needs k)',
  'err.tpl-limit-min': 'LIMIT must be at least 1',
  'err.tpl-limit-param': '$1 is the query vector; use another parameter for LIMIT',
  'err.tpl-no-operator': 'query template has no pgvector distance operator (<->, <=>, <#>, <+>, <~>, <%>)',
  'err.connect': 'could not connect: {detail}',
  'where.row': 'cases row {n}',
  'where.line': 'cases line {n}',

  // ---- progress / gate ----
  progress: 'measuring {done}/{total}',
  'fail.no-config': 'nothing reached recall@{k} >= {target} on the vector index',
  'gate.index-not-used': '{used}% of queries used the vector index (< {min}%); recall from exact scans is not index quality ({label}). Use --force-index to measure the index, or --min-index-use 0 to accept.',
  'gate.no-index-query': 'no query used the vector index, so recall@{k} is undefined ({label})',
  'gate.recall-below-min': '{observed}recall@{k} {recall}{worst} < {min} ({label})',
  'word.observed': 'observed ',
  'word.worst-group': ' (worst group)',

  // ---- report ----
  'report.header': 'pgvector {pgvector} · k={k} · {cases} cases · force-index: {force}',
  'word.on': 'on',
  'word.off': 'off',
  'word.warning': 'warning:',
  'word.note': 'note:',
  'head.config': 'config',
  'head.recall': 'recall@k',
  'head.worst': 'worst group',
  'head.short': 'short',
  'head.index-used': 'index used',
  'head.buffers': 'buffers',
  'head.p50': 'p50 ms',
  'head.p95': 'p95 ms',
  'head.group': 'group',
  'head.cases': 'cases',
  'report.by-group': 'by group — {label}',
  'report.more-groups': '… {hidden} more groups (lowest recall shown; see --format json)',
  'report.not-indexed': '! index not used for {count}/{total} queries — recall not counted ({reason})',
  'report.pass': 'quality gate',
  'report.scope-group': ' (every group)',
  'report.no-choice': 'No configuration met recall@{k} >= {target}{scope} with LIMIT-short <= {short} on the vector index.',
  'report.why-rejected': 'Why each config was rejected (first 5):',
  'report.recommended': 'Recommended: {label} — recall@{k} {recall}{scope}, short {short}, {cost} (cheapest meeting target {target})',
  'report.cost-buffers': '{n} buffers/query',
  'report.cost-latency': 'p95 {n} ms (no buffer info)',
  'report.na': 'n/a',

  // ---- reasons, warnings, advice (rendered from English strings by pattern) ----
  'reason.chose': 'planner chose {plan}',
  'reason.no-scan': 'planner chose a plan without a scan node',
  'warn.ivfflat-not-tuned': 'ivfflat index {index} in use: hnsw.ef_search and hnsw.iterative_scan have no effect on it; tune ivfflat.probes instead',
  'warn.no-index': 'no hnsw/ivfflat index in this database — every query is an exact scan',
  'warn.ignores-iterative': 'pgvector {version} < 0.8.0 ignores hnsw.iterative_scan',
  'warn.axis-removed': 'pgvector {version} < 0.8.0: iterative_scan axis removed, sweeping ef_search only',
  'advice.same-transaction': 'Run the SET LOCAL lines inside the same transaction (same connection) as the search query; with a pool, BEGIN … COMMIT around both.',
  'advice.relaxed-order': 'relaxed_order may return rows slightly out of distance order. If order matters, wrap the query in WITH r AS MATERIALIZED (…) and ORDER BY distance + 0 outside.',

  // ---- rejected configs ----
  'rej.index-not-used': 'index-not-used ({value} of queries used the vector index)',
  'rej.no-recall': 'no-recall (every query had an empty exact result)',
  'rej.recall-below-target': 'recall-below-target ({value} < {target})',
  'rej.too-many-short': 'too-many-short ({value} > {max})',

  // ---- check ----
  'check.title': 'pgvector-doctor check',
  'check.settings': 'pgvector {pgvector} · hnsw.ef_search={ef} · hnsw.iterative_scan={iter} · k={k}',
  'check.not-installed': 'not installed',
  'check.default': 'default',
  'check.tables': 'tables: {list}',
  'check.indexes': 'vector indexes: {list}',
  'check.none': 'none',
  'check.plan': 'plan ({mode}): {scans}',
  'check.ok': 'no problems found',
  'diag.no-pgvector': 'pgvector is not installed in this database (CREATE EXTENSION vector).',
  'diag.too-old': 'pgvector {version} < 0.8.0: no iterative index scans, so filtered queries can only be fixed by raising ef_search. sweep will skip the iterative_scan axis.',
  'diag.explain-skipped': 'could not EXPLAIN without parameter values ({detail}). Pass --cases-sql or --cases to check the plan.',
  'diag.no-table': 'the plan reads no table, so there is no index to check. Point the template at the table that holds the vectors.',
  'diag.no-index': 'no hnsw/ivfflat index on {tables} — every query is an exact scan.',
  'diag.no-index-tables': 'the queried tables',
  'diag.opclass': 'query uses {ops} but the index is {index}; {want}. Change the operator or rebuild the index with the matching operator class.',
  'diag.opclass-want': '{op} needs *_{opclass}',
  'diag.limit-ef': 'LIMIT {k} > hnsw.ef_search {ef}: an HNSW scan returns at most {ef} rows. Raise ef_search to at least {k}{or}.',
  'diag.limit-ef-or': ' or enable hnsw.iterative_scan',
  'diag.ivfflat-not-tuned': 'the query uses ivfflat index {index}. hnsw.ef_search and hnsw.iterative_scan have no effect on IVFFlat, so ef_search changes and sweep results will not move recall; tune ivfflat.probes instead (sweep does not tune probes yet).',
  'diag.not-used': 'with the current settings the vector index is not used ({reason}). Results are exact, so ef_search/iterative_scan have no effect here; recall measured this way is not index quality.',

  // ---- demo ----
  'demo.title': 'pgvector-doctor demo — practice (mock) mode',
  'demo.intro1': '  In-process PGlite (real PostgreSQL + pgvector compiled to WASM) with seeded synthetic data.',
  'demo.intro2': '  recall / LIMIT-short / index-use results are real; latency numbers are WASM numbers, not your server.',
  'demo.versions': 'PostgreSQL {pg} · pgvector {vector}',
  'demo.table': 'table items: {rows} rows, {dim}-dim, HNSW ({opclass}) + btree on tenant_id; tenant 0 = 50% of rows, tenants 1..{small} = 1% each',
  'demo.query': 'query: {query}',
  'demo.cases': 'cases: 20 vectors from the big tenant + 1 from each of 30 small tenants (self row excluded)',
  'demo.scene1': '━━ Scene 1 — let the planner decide (default ef_search=40, iterative_scan=off)',
  'demo.scene1-note1': '  → Queries that skip the vector index return exact results, so their recall is a fake 100%.',
  'demo.scene1-note2': '    pgvector-doctor checks EXPLAIN for the HNSW index by name and leaves those queries out of recall@k.',
  'demo.scene1-all-indexed': '  (this run: every query used the vector index)',
  'demo.scene2': '━━ Scene 2 — force the vector index (--force-index), {label}',
  'demo.scene2-note1': '  → HNSW collects ef_search=40 nearest candidates first and applies WHERE tenant_id afterwards.',
  'demo.scene2-note2': '    A 1% tenant keeps ~0.4 of those 40 rows: LIMIT 10 comes back short and recall collapses — with no error.',
  'demo.scene3': '━━ Scene 3 — sweep ef_search × iterative_scan and pick the cheapest config that meets recall@10 >= 0.95',
  'demo.try': 'Try it on your database (read-only transactions, SET LOCAL only):',
} as const;

export type MessageKey = keyof typeof en;

const ko: Record<MessageKey, string> = {
  help: `pgvector-doctor {version} — 내 필터 SQL 로 pgvector HNSW recall 을 잽니다

사용법
  pgvector-doctor demo                       연습용(목) 모드: 프로세스 안 PGlite, 서버 불필요
  pgvector-doctor check   --query q.sql [--cases-sql c.sql]
  pgvector-doctor measure --query q.sql --cases-sql c.sql [--min-recall 0.95]
  pgvector-doctor sweep   --query q.sql --cases-sql c.sql [--target 0.95]

접속
  --url <postgres://…>        기본값은 $DATABASE_URL. 리플리카나 스테이징 DB 를 사용하십시오.

입력
  --query <file|sql>          검색 SQL: 첫 열 = 행 id, $1 = 질의 벡터, LIMIT 필수
  --cases-sql <file|sql>      vector (→$1), p2…pN (→$2…$N), 선택 열 self_id, "group" 을 돌려주는 SELECT
  --cases <file.jsonl>        같은 필드를 JSON 줄로 지정
  --k <n>                     템플릿이 LIMIT $n 일 때의 k
  --max-cases <n>             질의 사례 상한 (기본 50)
  --timeout <30s>             질의별 statement_timeout (기본 30s)

측정
  --force-index               측정 전용: 순차·비트맵 스캔과 정렬을 꺼서 벡터 인덱스를 쓰게 함
  --ef <n[,n…]>               hnsw.ef_search (measure: 값 하나, sweep 기본 40,100,200,400)
  --iterative <v[,v…]>        off | strict_order | relaxed_order (sweep 기본: 세 가지 모두)
  --max-scan-tuples <n[,n…]>  hnsw.max_scan_tuples (sweep 기본 20000)

게이트와 추천
  --min-recall <0..1>         measure: recall@k 가 이 값보다 낮으면 종료 코드 1
  --min-index-use <0..1>      measure: 벡터 인덱스를 쓴 질의가 이보다 적으면 종료 코드 1 (게이트 사용 시 기본 1,
                              1 미만이면 --min-recall 을 앱이 실제로 받는 행 기준으로 판정)
  --target <0..1>             sweep: 목표 recall (기본 0.95)
  --target-scope mean|group   평균으로 판정할지, 모든 그룹의 최솟값으로 판정할지 (기본 mean)
  --max-short <0..1>          허용하는 LIMIT 미달률 (기본 0)

출력
  --format table|json|md      (기본 table)
  --out <file>                보고서를 파일에 저장 (표는 그대로 출력)
  --lang en|ko                화면 언어. 기본값: $PGVECTOR_DOCTOR_LANG, 그다음 $LC_ALL / $LC_MESSAGES / $LANG
                              (한국어가 아니면 영어). JSON 출력은 항상 영어입니다.

종료 코드: 0 정상 · 1 품질 게이트 실패 / 목표를 맞추는 설정 없음 / check 오류 · 2 사용법·접속·SQL 오류
모든 측정은 BEGIN READ ONLY 와 SET LOCAL 로 실행하므로 아무것도 쓰지 않고 세션 설정도 그대로입니다.
`,

  'err.file-not-found': '{name}: 파일을 찾을 수 없습니다: {value}',
  'err.file-not-found-short': '{name}: 파일을 찾을 수 없습니다',
  'err.fraction': '{name}: 0 이상 1 이하의 숫자여야 합니다',
  'err.positive-int': '{name}: 1 이상의 정수여야 합니다',
  'err.timeout': '--timeout 은 30s, 500ms, 2min 같은 형식이어야 합니다',
  'err.single-value': '{name}: measure 는 값을 하나만 받습니다 (여러 값은 sweep 을 사용하십시오)',
  'err.unexpected-arg': '예상하지 못한 인자: {arg}',
  'err.unknown-command': '알 수 없는 명령: "{command}" (demo, check, measure, sweep 중 하나여야 합니다)',
  'err.format': '--format 은 table, json, md 중 하나여야 합니다',
  'err.url-required': '--url 이 필요합니다 (또는 DATABASE_URL 을 설정하십시오)',
  'err.url-scheme': '--url 은 postgres:// 또는 postgresql:// 로 시작해야 합니다',
  'err.query-required': '--query 가 필요합니다',
  'err.target-scope': '--target-scope 는 mean 또는 group 이어야 합니다',
  'err.cases-both': '--cases-sql 과 --cases 중 하나만 사용하십시오',
  'err.needs-cases': '명령 {command}: --cases-sql 또는 --cases 가 필요합니다',
  'err.lang': '--lang 은 en 또는 ko 여야 합니다 (받은 값: "{value}")',
  'err.opt-unknown': "알 수 없는 옵션: '{option}'",
  'err.opt-missing-value': "'{option}' 옵션에는 값이 필요합니다",
  'err.opt-no-value': "'{option}' 옵션은 값을 받지 않습니다",
  'err.opt-other': '잘못된 인자: {detail}',
  'err.cases-vector-missing': '{where}: "vector" 필드가 없습니다 ($1 에 들어갈 질의 벡터입니다)',
  'err.cases-detail': '{where}: {detail}',
  'err.cases-param-missing': '{where}: 필요한 필드가 없습니다: "{key}" (템플릿에서 필요한 파라미터: {param})',
  'err.cases-sql-empty': '사례 SQL 이 비어 있습니다',
  'err.cases-sql-single': '사례 SQL 은 문장 하나여야 합니다',
  'err.cases-json': '{where}: 올바른 JSON 이 아닙니다',
  'err.cases-object': '{where}: JSON 객체여야 합니다',
  'err.cases-none': '질의 사례가 없습니다 (사례 SQL/JSONL 이 0행을 돌려주었습니다)',
  'err.k-conflict': '--k 값과 템플릿의 LIMIT 값이 충돌합니다 (--k {k}, LIMIT {limit})',
  'err.k-needed': '질의의 LIMIT 값이 파라미터({param})입니다. --k 를 지정하십시오',
  'err.no-cases': '질의 사례가 없습니다',
  'err.no-pgvector': '이 데이터베이스에 pgvector 확장이 설치되어 있지 않습니다 (CREATE EXTENSION vector)',
  'err.not-whole': '{name}: 정수가 아닌 값입니다: "{value}"',
  'err.outside': '{name}: 허용 범위는 {min}..{max} 입니다 (받은 값: {n})',
  'err.iterative-values': '--iterative: 다음 중 하나여야 합니다: {values} (받은 값: "{value}")',
  'err.iterative-invalid': 'iterative_scan: 잘못된 값 {value}',
  'err.int-range': '{name}: {min}..{max} 범위의 정수여야 합니다 (받은 값: {n})',
  'err.tpl-empty': '질의 템플릿이 비어 있습니다',
  'err.tpl-multi': '질의 템플릿은 문장 하나여야 합니다 (중간에 ";" 가 있습니다)',
  'err.tpl-no-param': '질의 템플릿은 질의 벡터 자리에 $1 을 써야 합니다 (예: ORDER BY embedding <=> $1)',
  'err.tpl-no-limit': '질의 템플릿에 LIMIT 절이 있어야 합니다 (recall@k 계산에는 k 값이 필요합니다)',
  'err.tpl-limit-min': 'LIMIT 값은 1 이상이어야 합니다',
  'err.tpl-limit-param': '$1 은 질의 벡터입니다. LIMIT 절에는 다른 파라미터를 사용하십시오',
  'err.tpl-no-operator': '질의 템플릿에 pgvector 거리 연산자가 없습니다 (<->, <=>, <#>, <+>, <~>, <%>)',
  'err.connect': '접속하지 못했습니다: {detail}',
  'where.row': '사례 행 {n}',
  'where.line': '사례 줄 {n}',

  progress: '측정 중 {done}/{total}',
  'fail.no-config': '벡터 인덱스에서 목표 recall@{k} >= {target} 에 도달한 설정이 없습니다',
  'gate.index-not-used': '벡터 인덱스를 쓴 질의 비율 {used}% (< {min}%): 정확 스캔의 recall 은 인덱스 품질이 아닙니다 ({label}). 인덱스를 재려면 --force-index, 이대로 받아들이려면 --min-index-use 0 을 사용하십시오.',
  'gate.no-index-query': '벡터 인덱스를 쓴 질의가 없어 recall@{k} 값을 정할 수 없습니다 ({label})',
  'gate.recall-below-min': '{observed}recall@{k} {recall}{worst} < {min} ({label})',
  'word.observed': '관측 ',
  'word.worst-group': ' (최악 그룹)',

  'report.header': 'pgvector {pgvector} · k={k} · 사례 {cases}개 · force-index: {force}',
  'word.on': '켜짐',
  'word.off': '꺼짐',
  'word.warning': '경고:',
  'word.note': '참고:',
  'head.config': '설정',
  'head.recall': 'recall@k',
  'head.worst': '최악 그룹',
  'head.short': '미달',
  'head.index-used': '인덱스 사용',
  'head.buffers': '버퍼',
  'head.p50': 'p50 ms',
  'head.p95': 'p95 ms',
  'head.group': '그룹',
  'head.cases': '사례',
  'report.by-group': '그룹별 — {label}',
  'report.more-groups': '… 그룹 {hidden}개 더 있음 (recall 이 낮은 순으로 표시, 전체는 --format json 참조)',
  'report.not-indexed': '! 질의 {count}/{total}건이 벡터 인덱스를 쓰지 않았습니다 — recall 집계에서 뺐습니다 ({reason})',
  'report.pass': '품질 게이트',
  'report.scope-group': ' (모든 그룹)',
  'report.no-choice': '벡터 인덱스에서 조건을 만족하는 설정이 없습니다 (recall@{k} >= {target}{scope}, LIMIT 미달률 <= {short}).',
  'report.why-rejected': '설정별 제외 사유 (처음 5개):',
  'report.recommended': '추천: {label} — recall@{k} {recall}{scope}, 미달률 {short}, {cost} (목표 {target} 충족 중 가장 저렴)',
  'report.cost-buffers': '질의당 버퍼 {n}개',
  'report.cost-latency': 'p95 {n} ms (버퍼 정보 없음)',
  'report.na': '없음',

  'reason.chose': '플래너 선택: {plan}',
  'reason.no-scan': '플래너가 스캔 노드 없는 플랜을 선택했습니다',
  'warn.ivfflat-not-tuned': 'ivfflat 인덱스 {index} 사용 중: hnsw.ef_search·hnsw.iterative_scan 은 효과가 없습니다. 대신 ivfflat.probes 를 조정하십시오',
  'warn.no-index': '이 데이터베이스에 hnsw/ivfflat 인덱스가 없습니다 — 모든 질의가 정확 스캔입니다',
  'warn.ignores-iterative': 'pgvector {version} (< 0.8.0) 에서는 hnsw.iterative_scan 이 무시됩니다',
  'warn.axis-removed': 'pgvector {version} (< 0.8.0): iterative_scan 축을 빼고 ef_search 만 스윕합니다',
  'advice.same-transaction': '검색 질의와 같은 트랜잭션(같은 연결) 안에서 SET LOCAL 줄을 실행하십시오. 풀을 쓴다면 둘을 BEGIN … COMMIT 으로 감쌉니다.',
  'advice.relaxed-order': 'relaxed_order 는 행이 거리 순서에서 조금 벗어나 돌아올 수 있습니다. 순서가 중요하면 질의를 WITH r AS MATERIALIZED (…) 로 감싸고 바깥에서 ORDER BY distance + 0 을 사용하십시오.',

  'rej.index-not-used': 'index-not-used (벡터 인덱스를 쓴 질의 비율 {value})',
  'rej.no-recall': 'no-recall (모든 질의의 정확 결과가 비어 있습니다)',
  'rej.recall-below-target': 'recall-below-target ({value} < {target})',
  'rej.too-many-short': 'too-many-short ({value} > {max})',

  'check.title': 'pgvector-doctor check',
  'check.settings': 'pgvector {pgvector} · hnsw.ef_search={ef} · hnsw.iterative_scan={iter} · k={k}',
  'check.not-installed': '미설치',
  'check.default': '기본값',
  'check.tables': '테이블: {list}',
  'check.indexes': '벡터 인덱스: {list}',
  'check.none': '없음',
  'check.plan': '플랜 ({mode}): {scans}',
  'check.ok': '문제를 찾지 못했습니다',
  'diag.no-pgvector': '이 데이터베이스에 pgvector 확장이 설치되어 있지 않습니다 (CREATE EXTENSION vector).',
  'diag.too-old': 'pgvector {version} (< 0.8.0): 반복 인덱스 스캔이 없어 필터 질의는 ef_search 를 올려서만 고칠 수 있습니다. sweep 은 iterative_scan 축을 건너뜁니다.',
  'diag.explain-skipped': '파라미터 값 없이는 EXPLAIN 을 할 수 없습니다 ({detail}). 플랜을 확인하려면 --cases-sql 또는 --cases 를 지정하십시오.',
  'diag.no-table': '플랜이 테이블을 읽지 않아 확인할 인덱스가 없습니다. 템플릿이 벡터가 든 테이블을 가리키게 하십시오.',
  'diag.no-index': '{tables} 에 hnsw/ivfflat 인덱스가 없습니다 — 모든 질의가 정확 스캔입니다.',
  'diag.no-index-tables': '질의 대상 테이블',
  'diag.opclass': '질의의 거리 연산자는 {ops}, 인덱스는 {index} 입니다. {want}. 연산자를 바꾸거나 맞는 연산자 클래스로 인덱스를 다시 만드십시오.',
  'diag.opclass-want': '연산자 {op}: *_{opclass} 연산자 클래스가 필요합니다',
  'diag.limit-ef': 'LIMIT {k} > hnsw.ef_search {ef}: HNSW 스캔은 최대 {ef}행만 돌려줍니다. ef_search 를 {k} 이상으로 올리십시오{or}.',
  'diag.limit-ef-or': ' (또는 hnsw.iterative_scan 을 켜십시오)',
  'diag.ivfflat-not-tuned': '질의가 쓰는 ivfflat 인덱스: {index}. hnsw.ef_search 와 hnsw.iterative_scan 은 IVFFlat 에 효과가 없어 ef_search 를 바꾸거나 sweep 을 돌려도 recall 이 달라지지 않습니다. 대신 ivfflat.probes 를 조정하십시오(sweep 은 아직 probes 를 조정하지 않습니다).',
  'diag.not-used': '현재 설정에서는 벡터 인덱스가 쓰이지 않습니다 ({reason}). 결과가 정확하므로 ef_search/iterative_scan 이 영향을 주지 않으며, 이렇게 잰 recall 은 인덱스 품질이 아닙니다.',

  'demo.title': 'pgvector-doctor demo — 연습용(목) 모드',
  'demo.intro1': '  프로세스 안 PGlite(WASM 으로 컴파일한 진짜 PostgreSQL + pgvector)와 시드를 고정한 합성 데이터를 씁니다.',
  'demo.intro2': '  recall / LIMIT 미달 / 인덱스 사용 결과는 진짜이고, 지연 시간은 WASM 기준이라 내 서버와 다릅니다.',
  'demo.versions': 'PostgreSQL {pg} · pgvector {vector}',
  'demo.table': 'items 테이블: {rows}행, {dim}차원, HNSW ({opclass}) + tenant_id btree. 테넌트 0 = 전체 행의 50%, 테넌트 1..{small} = 각각 1%',
  'demo.query': '질의: {query}',
  'demo.cases': '사례: 큰 테넌트 벡터 20개 + 작은 테넌트 30곳에서 1개씩 (자기 행 제외)',
  'demo.scene1': '━━ 장면 1 — 플래너에게 맡기기 (기본 ef_search=40, iterative_scan=off)',
  'demo.scene1-note1': '  → 벡터 인덱스를 건너뛴 질의는 정확한 결과를 돌려주므로 그 recall 은 가짜 100% 입니다.',
  'demo.scene1-note2': '    pgvector-doctor 는 EXPLAIN 에서 HNSW 인덱스를 이름으로 확인해 그런 질의를 recall@k 집계에서 뺍니다.',
  'demo.scene1-all-indexed': '  (이번 실행: 모든 질의가 벡터 인덱스를 썼습니다)',
  'demo.scene2': '━━ 장면 2 — 벡터 인덱스 강제 (--force-index), {label}',
  'demo.scene2-note1': '  → HNSW 는 가까운 후보 ef_search=40 개를 먼저 모은 뒤 WHERE tenant_id 를 적용합니다.',
  'demo.scene2-note2': '    1% 테넌트는 그 40행 중 약 0.4행만 남습니다. LIMIT 10 이 모자라게 돌아오고 recall 이 무너지지만 오류는 없습니다.',
  'demo.scene3': '━━ 장면 3 — ef_search × iterative_scan 을 스윕해 recall@10 >= 0.95 를 만족하는 가장 싼 설정 고르기',
  'demo.try': '내 데이터베이스에서 해 보기 (읽기 전용 트랜잭션, SET LOCAL 만 사용):',
};

const TABLES: Record<Lang, Record<MessageKey, string>> = { en, ko };

/** Message keys of one language (used by the key-parity test). */
export function messageKeys(lang: Lang): string[] {
  return Object.keys(TABLES[lang]);
}

export type Params = Record<string, string | number>;

/** Fill `{name}` placeholders. Unknown placeholders are kept as written. */
export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const template = TABLES[lang][key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole;
    const v = String(params[name]);
    // `where` and `reason` carry English fragments produced by the library; render them in the chosen language.
    if (name === 'where') return localizeWhere(lang, v);
    if (name === 'reason') return localizeReason(lang, v);
    return v;
  });
}

/** "cases row 3" / "cases line 3" → localized. Anything else is returned as is. */
export function localizeWhere(lang: Lang, where: string): string {
  if (lang === 'en') return where;
  const m = /^cases (row|line) (\d+)$/.exec(where);
  return m ? t(lang, m[1] === 'row' ? 'where.row' : 'where.line', { n: m[2]! }) : where;
}

/** Not-indexed reasons built by plan.ts ("planner chose Seq Scan on items"). */
export function localizeReason(lang: Lang, reason: string): string {
  if (lang === 'en') return reason;
  if (reason === 'planner chose a plan without a scan node') return t(lang, 'reason.no-scan');
  const m = /^planner chose (.+)$/s.exec(reason);
  // 스캔 이름(Seq Scan, Index Scan using …)은 Postgres 용어라 그대로 두고, 우리가 붙인 꼬리표만 옮긴다.
  return m ? t(lang, 'reason.chose', { plan: m[1]!.replaceAll(' (not a vector index)', ' (벡터 인덱스 아님)') }) : reason;
}

/** Warning strings built by measure.ts / sweep.ts. Unknown strings are returned as is. */
export function localizeWarning(lang: Lang, warning: string): string {
  if (lang === 'en') return warning;
  if (warning === 'no hnsw/ivfflat index in this database — every query is an exact scan') return t(lang, 'warn.no-index');
  let m = /^pgvector (.+) < 0\.8\.0 ignores hnsw\.iterative_scan$/.exec(warning);
  if (m) return t(lang, 'warn.ignores-iterative', { version: m[1]! });
  m = /^ivfflat index (.+) in use: hnsw\.ef_search and hnsw\.iterative_scan have no effect on it; tune ivfflat\.probes instead$/.exec(warning);
  if (m) return t(lang, 'warn.ivfflat-not-tuned', { index: m[1]! });
  m = /^pgvector (.+) < 0\.8\.0: iterative_scan axis removed, sweeping ef_search only$/.exec(warning);
  if (m) return t(lang, 'warn.axis-removed', { version: m[1]! });
  return warning;
}

/** Advice strings built by sweep.ts `adviceFor`. */
export function localizeAdvice(lang: Lang, advice: string): string {
  if (lang === 'en') return advice;
  if (advice === t('en', 'advice.same-transaction')) return t(lang, 'advice.same-transaction');
  if (advice === t('en', 'advice.relaxed-order')) return t(lang, 'advice.relaxed-order');
  return advice;
}

// ---------- language decision ----------

/** `--lang` value as written on the command line: undefined if absent, otherwise the raw string. */
export function findLangFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') return undefined;
    if (a === '--lang') return argv[i + 1];
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

export function isLang(value: string | undefined): value is Lang {
  return value === 'en' || value === 'ko';
}

/** The first non-empty of PGVECTOR_DOCTOR_LANG, LC_ALL, LC_MESSAGES, LANG decides; Korean only if it starts with "ko". */
export function langFromEnv(env: Record<string, string | undefined>): Lang {
  for (const name of ['PGVECTOR_DOCTOR_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[name]?.trim();
    if (v) return v.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  }
  return 'en';
}

/** `--lang` > environment. A bad `--lang` value is ignored here (the CLI reports it as a usage error). */
export function resolveLang(argv: readonly string[], env: Record<string, string | undefined>): Lang {
  const flag = findLangFlag(argv);
  return isLang(flag) ? flag : langFromEnv(env);
}

// ---------- localized text attached to library results (kept out of JSON) ----------

/** Attach a non-enumerable renderer so JSON.stringify / spread / toEqual never see it. */
export function withL10n<T extends object>(obj: T, render: (lang: Lang) => string): T {
  Object.defineProperty(obj, 'l10n', { value: render, enumerable: false });
  return obj;
}

/** The text of `obj` in `lang`: its attached renderer for Korean, otherwise the English `fallback`. */
export function localizedText(lang: Lang, obj: object, fallback: string): string {
  if (lang === 'en') return fallback;
  const render = (obj as { l10n?: (lang: Lang) => string }).l10n;
  return render ? render(lang) : fallback;
}
