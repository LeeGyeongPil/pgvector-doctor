// 측정 — 사례마다 정확 검색 기준값 1번 + 설정 조합마다 근사 검색 + EXPLAIN 판정.
import { type Queryable, type Setting, withReadOnly, idText } from './db.js';
import { type ParsedTemplate, parseTemplate, UsageError } from './template.js';
import { type QueryCase, bindParams } from './cases.js';
import { pgvectorVersion, vectorIndexes, currentSetting, supportsIterativeScan } from './catalog.js';
import { planRoot, analyzePlan, notIndexedReason } from './plan.js';
import { type CaseRun, type Aggregate, type GroupAggregate, aggregate, aggregateByGroup } from './metrics.js';

export type IterativeScan = 'off' | 'strict_order' | 'relaxed_order';
export const ITERATIVE_SCAN_VALUES: readonly IterativeScan[] = ['off', 'strict_order', 'relaxed_order'];

/** HNSW 검색 설정 한 조합. 빈 객체 = 지금 DB 에 걸린 설정 그대로. */
export interface HnswConfig {
  efSearch?: number;
  iterativeScan?: IterativeScan;
  maxScanTuples?: number;
}

/** 정확 검색 기준값: 인덱스 스캔을 모두 꺼서 순차 스캔 + 정렬로 진짜 최근접을 얻는다(pgvector README 방법). */
export const EXACT_SETTINGS: readonly Setting[] = [
  ['enable_indexscan', 'off'],
  ['enable_indexonlyscan', 'off'],
  ['enable_bitmapscan', 'off'],
];

/**
 * --force-index: 측정용으로만 벡터 인덱스를 타게 한다.
 * 순차 스캔·비트맵 스캔·정렬을 끄면 'btree 인덱스 스캔 + 정렬'보다 '벡터 인덱스 순서 스캔'이 고정된다.
 * 운영에서 이렇게 강제하는 것은 권장하지 않는다(pgvector #675).
 */
export const FORCE_INDEX_SETTINGS: readonly Setting[] = [
  ['enable_seqscan', 'off'],
  ['enable_bitmapscan', 'off'],
  ['enable_sort', 'off'],
];

/** 설정 조합 → set_config 목록. 값은 이미 검증된 숫자·열거값이다. */
export function configSettings(c: HnswConfig): Setting[] {
  const s: Setting[] = [];
  if (c.efSearch !== undefined) s.push(['hnsw.ef_search', String(c.efSearch)]);
  if (c.iterativeScan !== undefined) s.push(['hnsw.iterative_scan', c.iterativeScan]);
  if (c.maxScanTuples !== undefined) s.push(['hnsw.max_scan_tuples', String(c.maxScanTuples)]);
  return s;
}

/** 실제로 적용된 값(트랜잭션 안에서 SHOW 로 읽음). 확장이 그 GUC 를 모르면 null. */
export interface EffectiveSettings {
  efSearch: string | null;
  iterativeScan: string | null;
  maxScanTuples: string | null;
}

/** 'ef_search=40 iterative_scan=off' 형태의 이름. iterative 가 꺼져 있으면 max_scan_tuples 는 의미가 없어 뺀다. */
export function configLabel(e: EffectiveSettings): string {
  const parts = [`ef_search=${e.efSearch ?? '?'}`];
  if (e.iterativeScan !== null) parts.push(`iterative_scan=${e.iterativeScan}`);
  if (e.iterativeScan !== null && e.iterativeScan !== 'off' && e.maxScanTuples !== null && e.maxScanTuples !== '20000') {
    parts.push(`max_scan_tuples=${e.maxScanTuples}`);
  }
  return parts.join(' ');
}

export interface ConfigResult {
  label: string;
  config: HnswConfig;
  effective: EffectiveSettings;
  summary: Aggregate;
  groups: GroupAggregate[];
  /** 벡터 인덱스를 안 탄 사유별 사례 수 */
  notIndexed: { reason: string; count: number }[];
}

export interface MeasureOptions {
  /** 검색 SQL 템플릿(문자열 또는 parseTemplate 결과) */
  template: string | ParsedTemplate;
  cases: QueryCase[];
  /** 잴 설정 조합들. 생략하면 [{}] = 현재 설정 */
  configs?: HnswConfig[];
  /** LIMIT 이 $n 일 때 필요. LIMIT 이 숫자면 그 값 */
  k?: number;
  /** 측정용으로 벡터 인덱스 사용을 강제 */
  forceIndex?: boolean;
  /** statement_timeout(예: '30s'). 실제 DB 는 느릴 수 있어 넉넉히 */
  timeout?: string;
  /** 진행 표시(사례 단위) */
  onProgress?: (done: number, total: number) => void;
  /** 테스트용: pgvector 버전 주입 */
  pgvectorVersionOverride?: string | null;
}

export interface MeasureResult {
  k: number;
  cases: number;
  forceIndex: boolean;
  pgvector: string | null;
  /** 판정에 쓴 벡터 인덱스 이름(카탈로그) */
  vectorIndexes: string[];
  warnings: string[];
  results: ConfigResult[];
}

export function resolveK(template: ParsedTemplate, k?: number): number {
  if (template.limit !== null) {
    if (k !== undefined && k !== template.limit) {
      throw new UsageError(`--k ${k} conflicts with LIMIT ${template.limit} in the query template`);
    }
    return template.limit;
  }
  if (k === undefined) throw new UsageError(`query uses LIMIT $${template.limitParam}; pass --k`);
  if (!Number.isInteger(k) || k < 1) throw new UsageError('--k must be a positive integer');
  return k;
}

export async function measure(db: Queryable, opts: MeasureOptions): Promise<MeasureResult> {
  const template = typeof opts.template === 'string' ? parseTemplate(opts.template) : opts.template;
  const k = resolveK(template, opts.k);
  const configs = opts.configs && opts.configs.length > 0 ? opts.configs : [{}];
  const timeout = opts.timeout ?? '30s';
  const forceIndex = opts.forceIndex ?? false;
  if (opts.cases.length === 0) throw new UsageError('no query cases');

  const version = opts.pgvectorVersionOverride !== undefined ? opts.pgvectorVersionOverride : await pgvectorVersion(db);
  if (version === null) throw new UsageError('pgvector extension is not installed in this database (CREATE EXTENSION vector)');
  const indexes = await vectorIndexes(db);
  const indexNames = new Set(indexes.map((i) => i.index));
  const warnings: string[] = [];
  if (indexes.length === 0) warnings.push('no hnsw/ivfflat index in this database — every query is an exact scan');
  if (!supportsIterativeScan(version) && configs.some((c) => c.iterativeScan !== undefined)) {
    warnings.push(`pgvector ${version} < 0.8.0 ignores hnsw.iterative_scan`);
  }

  const runs: CaseRun[][] = configs.map(() => []);
  const effective: (EffectiveSettings | null)[] = configs.map(() => null);
  const notIndexed: Map<string, number>[] = configs.map(() => new Map());

  for (let ci = 0; ci < opts.cases.length; ci++) {
    const c = opts.cases[ci]!;
    const params = bindParams(c, template, k);

    // 1) 정확 검색 기준값 — 사례마다 한 번만.
    const exactRows = await withReadOnly(db, [['statement_timeout', timeout], ...EXACT_SETTINGS], async () =>
      (await db.query(template.sql, params)).rows,
    );
    const exactIds = exactRows.map(firstColumnId);

    // 2) 설정 조합마다 근사 검색 + 같은 트랜잭션에서 EXPLAIN ANALYZE.
    for (let gi = 0; gi < configs.length; gi++) {
      const settings: Setting[] = [
        ['statement_timeout', timeout],
        ...configSettings(configs[gi]!),
        ...(forceIndex ? FORCE_INDEX_SETTINGS : []),
      ];
      const run = await withReadOnly(db, settings, async () => {
        const t0 = performance.now();
        const rows = (await db.query(template.sql, params)).rows;
        const latencyMs = performance.now() - t0;
        const explain = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${template.sql}`, params);
        const verdict = analyzePlan(planRoot(explain.rows), indexNames);
        // 실제 적용 값은 첫 사례에서 한 번 읽는다(쿼리를 돌린 뒤라 vector 라이브러리가 로드돼 있다).
        if (effective[gi] === null) effective[gi] = await readEffective(db);
        return { rows, latencyMs, verdict };
      });
      if (!run.verdict.vectorIndexUsed) {
        const reason = notIndexedReason(run.verdict);
        notIndexed[gi]!.set(reason, (notIndexed[gi]!.get(reason) ?? 0) + 1);
      }
      const caseRun: CaseRun = {
        group: c.group,
        exactIds,
        approxIds: run.rows.map(firstColumnId),
        vectorIndexUsed: run.verdict.vectorIndexUsed,
        latencyMs: run.latencyMs,
        buffers: run.verdict.buffers,
      };
      if (c.selfId !== undefined) caseRun.selfId = c.selfId;
      runs[gi]!.push(caseRun);
    }
    opts.onProgress?.(ci + 1, opts.cases.length);
  }

  const results: ConfigResult[] = configs.map((config, gi) => {
    const eff = effective[gi] ?? { efSearch: null, iterativeScan: null, maxScanTuples: null };
    return {
      label: configLabel(eff),
      config,
      effective: eff,
      summary: aggregate(runs[gi]!),
      groups: aggregateByGroup(runs[gi]!),
      notIndexed: [...notIndexed[gi]!.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
    };
  });

  return {
    k,
    cases: opts.cases.length,
    forceIndex,
    pgvector: version,
    vectorIndexes: [...indexNames].sort(),
    warnings,
    results,
  };
}

export async function readEffective(db: Queryable): Promise<EffectiveSettings> {
  return {
    efSearch: await currentSetting(db, 'hnsw.ef_search'),
    iterativeScan: await currentSetting(db, 'hnsw.iterative_scan'),
    maxScanTuples: await currentSetting(db, 'hnsw.max_scan_tuples'),
  };
}

/** 첫 열 = 행 식별자 규칙. */
function firstColumnId(row: Record<string, unknown>): string {
  const first = Object.values(row)[0];
  return idText(first);
}
