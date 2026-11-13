// 진단 — 측정 전에 흔한 설정 실수를 코드로 알려 준다.
import { randomUUID } from 'node:crypto';
import { type Queryable, type Setting, withReadOnly } from './db.js';
import { type ParsedTemplate, parseTemplate, OPERATOR_OPCLASS } from './template.js';
import { type QueryCase, bindParams } from './cases.js';
import { type VectorIndex, pgvectorVersion, vectorIndexes, supportsIterativeScan } from './catalog.js';
import { planRoot, analyzePlan, notIndexedReason } from './plan.js';
import { t, withL10n, type Lang } from './i18n.js';
import { type EffectiveSettings, FORCE_INDEX_SETTINGS, resolveK, readEffective } from './measure.js';

export type DiagnosticCode =
  | 'no-pgvector'
  | 'pgvector-too-old'
  | 'no-vector-index'
  | 'opclass-mismatch'
  | 'limit-exceeds-ef-search'
  | 'index-not-used'
  | 'ivfflat-not-tuned'
  | 'plan-check-skipped';

export interface Diagnostic {
  code: DiagnosticCode;
  level: 'error' | 'warn' | 'info';
  message: string;
}

export interface CheckOptions {
  template: string | ParsedTemplate;
  /** 있으면 첫 사례 값으로 EXPLAIN, 없으면 일반 플랜(PREPARE + force_generic_plan + EXPLAIN EXECUTE) */
  cases?: QueryCase[];
  k?: number;
  forceIndex?: boolean;
  timeout?: string;
  /** 테스트용: pgvector 버전 주입(예: '0.7.4') */
  pgvectorVersionOverride?: string | null;
}

export interface CheckResult {
  pgvector: string | null;
  k: number;
  settings: EffectiveSettings;
  /** 플랜에 나온 테이블 */
  tables: string[];
  /** 그 테이블들의 벡터 인덱스 */
  indexes: VectorIndex[];
  plan: { mode: 'sample-case' | 'generic-plan' | 'skipped'; vectorIndexUsed: boolean | null; scans: string[] };
  diagnostics: Diagnostic[];
}

/** pgvector 기본값 — 확장이 아직 로드되지 않아 current_setting 이 비었을 때 쓴다. */
const DEFAULT_EF_SEARCH = 40;

/** 사례 없이 일반 플랜을 만들 때 "괜찮은 실패" — 파라미터 타입을 문맥에서 정하지 못한 경우뿐이다. */
const PARAM_TYPE_ERROR = /could not determine (the )?data type of parameter/i;

/**
 * 사례 값 없이 일반(generic) 플랜을 본다 — 파라미터 값에 기대지 않는 플랜.
 *
 * `EXPLAIN (GENERIC_PLAN) …` 은 바인드할 값이 없어 단순 질의 프로토콜로만 보낼 수 있는데, 단순 프로토콜은
 * 문장 여러 개를 한 번에 실행한다(템플릿에 숨은 '; COMMIT; DELETE …' 가 READ ONLY 를 벗어난다).
 * 그래서 확장 프로토콜(문장 하나만 받음)로 갈 수 있는 전통적인 방법을 쓴다:
 *   1) plan_cache_mode = force_generic_plan (SET LOCAL)  — 항상 일반 플랜을 쓰게
 *   2) PREPARE <이름> AS <템플릿>                       — 여기서 DB 가 다중 문장을 거부한다
 *   3) EXPLAIN (FORMAT JSON) EXECUTE <이름>(NULL, …)     — 일반 플랜이라 NULL 값이 플랜에 섞이지 않는다
 *   4) DEALLOCATE <이름>                                 — PREPARE 는 롤백돼도 세션에 남으므로 꼭 지운다
 * 실행은 하지 않는다(ANALYZE 없음). PostgreSQL 12+ 에서 동작한다(GENERIC_PLAN 은 16+).
 */
async function explainGeneric(
  db: Queryable,
  template: ParsedTemplate,
  settings: readonly Setting[],
): Promise<{ planRows: Record<string, unknown>[]; eff: EffectiveSettings }> {
  // 이름은 도구가 만든 영문·숫자뿐 — 사용자의 다른 prepared statement 와 겹치지 않게 무작위 꼬리를 붙인다.
  const name = `pgvector_doctor_${randomUUID().replaceAll('-', '')}`;
  const nulls = Array.from({ length: template.maxParam }, () => 'NULL').join(', ');
  let prepared = false;
  try {
    return await withReadOnly(db, [...settings, ['plan_cache_mode', 'force_generic_plan']], async () => {
      await db.query(`PREPARE ${name} AS ${template.sql}`, []);
      prepared = true;
      const planRows = (await db.query(`EXPLAIN (FORMAT JSON) EXECUTE ${name}(${nulls})`, [])).rows;
      const eff = await readEffective(db);
      await db.query(`DEALLOCATE ${name}`, []);
      prepared = false;
      return { planRows, eff };
    });
  } finally {
    // EXPLAIN 이 실패해 트랜잭션이 롤백됐으면 DEALLOCATE 를 아직 못 했다 — 트랜잭션 밖에서 마저 지운다.
    if (prepared) await db.query(`DEALLOCATE ${name}`, []).catch(() => {});
  }
}

/**
 * 진단 한 건. `message` 는 영어(JSON·라이브러리용), 같은 문장을 다른 언어로 만드는 렌더러는
 * 비열거 속성으로 붙여 JSON 출력에 나타나지 않게 한다.
 */
function diag(code: DiagnosticCode, level: Diagnostic['level'], build: (lang: Lang) => string): Diagnostic {
  return withL10n({ code, level, message: build('en') }, build);
}

export async function check(db: Queryable, opts: CheckOptions): Promise<CheckResult> {
  const template = typeof opts.template === 'string' ? parseTemplate(opts.template) : opts.template;
  const k = resolveK(template, opts.k);
  const diagnostics: Diagnostic[] = [];
  const empty: EffectiveSettings = { efSearch: null, iterativeScan: null, maxScanTuples: null };

  const version = opts.pgvectorVersionOverride !== undefined ? opts.pgvectorVersionOverride : await pgvectorVersion(db);
  if (version === null) {
    diagnostics.push(diag('no-pgvector', 'error', (l) => t(l, 'diag.no-pgvector')));
    return { pgvector: null, k, settings: empty, tables: [], indexes: [], plan: { mode: 'skipped', vectorIndexUsed: null, scans: [] }, diagnostics };
  }
  if (!supportsIterativeScan(version)) {
    diagnostics.push(diag('pgvector-too-old', 'warn', (l) => t(l, 'diag.too-old', { version })));
  }

  // 현재 설정(+ 선택적으로 인덱스 강제) 그대로 EXPLAIN — 실행은 하지 않는다(ANALYZE 없음).
  const settings: Setting[] = [['statement_timeout', opts.timeout ?? '30s'], ...(opts.forceIndex ? FORCE_INDEX_SETTINGS : [])];
  const first = opts.cases?.[0];
  let mode: CheckResult['plan']['mode'] = first ? 'sample-case' : 'generic-plan';
  let planRows: Record<string, unknown>[] | null = null;
  let eff: EffectiveSettings = empty;
  try {
    if (first) {
      ({ planRows, eff } = await withReadOnly(db, settings, async () => ({
        planRows: (await db.query(`EXPLAIN (FORMAT JSON) ${template.sql}`, bindParams(first, template, k))).rows,
        eff: await readEffective(db),
      })));
    } else {
      ({ planRows, eff } = await explainGeneric(db, template, settings));
    }
  } catch (err) {
    // 사례 값으로도 실패하면 진짜 SQL 오류다. 사례 없이도 "파라미터 타입을 못 정함" 말고는 진짜 오류
    // (문법 오류, 없는 테이블, 다중 문장 등) — 종료 코드 2 로 알려야 하므로 그대로 던진다.
    if (first || !PARAM_TYPE_ERROR.test((err as Error).message)) throw err;
    mode = 'skipped';
    diagnostics.push(diag('plan-check-skipped', 'info', (l) => t(l, 'diag.explain-skipped', { detail: (err as Error).message })));
  }

  const allIndexes = await vectorIndexes(db);
  const verdict = planRows ? analyzePlan(planRoot(planRows), new Set(allIndexes.map((i) => i.index))) : null;
  const tables = verdict?.relations ?? [];
  const indexes = allIndexes.filter((i) => tables.includes(i.table));

  // 플랜에서 테이블을 하나도 못 찾으면 판정할 거리가 없다 — "문제 없음(OK)" 이 아니라 "건너뜀" 으로 알린다.
  if (verdict && tables.length === 0) {
    mode = 'skipped';
    diagnostics.push(diag('plan-check-skipped', 'info', (l) => t(l, 'diag.no-table')));
  }

  if (verdict && tables.length > 0 && indexes.length === 0) {
    diagnostics.push(
      diag('no-vector-index', 'error', (l) => t(l, 'diag.no-index', { tables: tables.join(', ') || t(l, 'diag.no-index-tables') })),
    );
  }

  // 연산자 클래스: 템플릿 거리 연산자와 짝이 맞는 인덱스가 하나도 없으면 플래너가 인덱스를 쓸 수 없다.
  if (indexes.length > 0) {
    const ops = [...new Set(template.operators)];
    const matches = ops.some((op) => indexes.some((i) => i.opclass.endsWith(OPERATOR_OPCLASS[op] ?? '\u0000')));
    if (!matches) {
      const idx = indexes.map((i) => `${i.index} (${i.opclass})`).join(', ');
      diagnostics.push(
        diag('opclass-mismatch', 'error', (l) => {
          const want = ops.map((op) => t(l, 'diag.opclass-want', { op, opclass: OPERATOR_OPCLASS[op] ?? '' })).join(', ');
          return t(l, 'diag.opclass', { ops: ops.join(' '), index: idx, want });
        }),
      );
    }
  }

  // LIMIT > ef_search 이고 iterative scan 이 꺼져 있으면 결과가 ef_search 개로 잘린다(pgvector #684).
  const ef = eff.efSearch !== null ? Number(eff.efSearch) : DEFAULT_EF_SEARCH;
  const iterativeOff = eff.iterativeScan === null || eff.iterativeScan === 'off';
  if (k > ef && iterativeOff) {
    diagnostics.push(
      diag('limit-exceeds-ef-search', 'warn', (l) =>
        t(l, 'diag.limit-ef', { k, ef, or: supportsIterativeScan(version) ? t(l, 'diag.limit-ef-or') : '' }),
      ),
    );
  }

  if (verdict && indexes.length > 0 && !verdict.vectorIndexUsed) {
    const reason = notIndexedReason(verdict);
    diagnostics.push(diag('index-not-used', 'warn', (l) => t(l, 'diag.not-used', { reason })));
  }

  // 쓰인 벡터 인덱스가 모두 IVFFlat 이면 hnsw.* 설정은 효과가 없다 — ivfflat.probes 를 조정하라고 알린다.
  if (verdict && verdict.vectorIndexUsed) {
    const used = indexes.filter((i) => verdict.vectorIndexNamesUsed.includes(i.index));
    if (used.length > 0 && used.every((i) => i.method === 'ivfflat')) {
      const index = used.map((i) => i.index).sort().join(', ');
      diagnostics.push(diag('ivfflat-not-tuned', 'warn', (l) => t(l, 'diag.ivfflat-not-tuned', { index })));
    }
  }

  return {
    pgvector: version,
    k,
    settings: eff,
    tables,
    indexes,
    plan: { mode, vectorIndexUsed: verdict ? verdict.vectorIndexUsed : null, scans: verdict?.scans ?? [] },
    diagnostics,
  };
}
