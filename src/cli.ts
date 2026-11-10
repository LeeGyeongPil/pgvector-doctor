#!/usr/bin/env node
// pgvector-doctor CLI — 하위 명령 분기·인자 검증·종료 코드.
//   종료 코드: 0 통과 / 1 품질 미달·인덱스 미사용·진단 오류 / 2 사용법·접속·SQL 오류
//   테스트는 프로세스를 띄우지 않고 run(argv, io) 를 직접 부른다.
import { readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connect, ConnectionError } from './db.js';
import { parseTemplate, UsageError, type ParsedTemplate } from './template.js';
import { casesFromSql, casesFromJsonl, type QueryCase } from './cases.js';
import { measure, type HnswConfig, type ConfigResult } from './measure.js';
import { sweep, parseIntList, parseIterativeList, EF_SEARCH_MIN, EF_SEARCH_MAX } from './sweep.js';
import { check } from './check.js';
import { scopedRecall, type TargetScope } from './recommend.js';
import { renderMeasure, renderCheck, VERSION, type Format, type GateResult } from './report.js';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** 상대 경로 기준 폴더 */
  cwd: string;
  /** stderr 가 터미널이면 진행 표시를 그린다 */
  progress?: boolean;
}

const HELP = `pgvector-doctor ${VERSION} — measure pgvector HNSW recall for your own filtered SQL

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

Exit codes: 0 ok · 1 quality gate failed / no config meets target / check error · 2 usage, connection or SQL error
Every measurement runs in BEGIN READ ONLY with SET LOCAL; nothing is written and session settings are untouched.
`;

/** 파일이면 읽고, 아니면 공백이 들어간 인라인 SQL 로 본다. */
function readSqlArg(value: string, cwd: string, name: string): string {
  const path = resolve(cwd, value);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  if (/\s/.test(value.trim())) return value;
  throw new UsageError(`${name}: file not found: ${value}`);
}

function parseFraction(raw: string | undefined, name: string, fallback: number): number;
function parseFraction(raw: string | undefined, name: string, fallback: null): number | null;
function parseFraction(raw: string | undefined, name: string, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(raw.trim())) throw new UsageError(`${name} must be a number between 0 and 1`);
  return Number(raw);
}

function parsePositiveInt(raw: string | undefined, name: string, fallback?: number): number | undefined {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) throw new UsageError(`${name} must be a positive integer`);
  return Number(raw);
}

/** statement_timeout 값 — 숫자 + 단위만(주입 방지). */
function parseTimeout(raw: string | undefined): string {
  const v = (raw ?? '30s').trim();
  if (!/^\d+(ms|s|min)?$/.test(v)) throw new UsageError('--timeout must look like 30s, 500ms or 2min');
  return v;
}

function single<T>(list: T[], name: string): T {
  if (list.length !== 1) throw new UsageError(`${name}: measure takes one value (use sweep for several)`);
  return list[0]!;
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  try {
    return await runInner(argv, io);
  } catch (err) {
    if (err instanceof UsageError) io.stderr(`error: ${err.message}\n`);
    else if (err instanceof ConnectionError) io.stderr(`error: ${err.message}\n`);
    else io.stderr(`error: ${(err as Error).message ?? String(err)}\n`);
    return 2;
  }
}

async function runInner(argv: string[], io: CliIO): Promise<number> {
  const { values: o, positionals } = (() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          url: { type: 'string' },
          query: { type: 'string' },
          'cases-sql': { type: 'string' },
          cases: { type: 'string' },
          k: { type: 'string' },
          'max-cases': { type: 'string' },
          timeout: { type: 'string' },
          'force-index': { type: 'boolean' },
          ef: { type: 'string' },
          iterative: { type: 'string' },
          'max-scan-tuples': { type: 'string' },
          'min-recall': { type: 'string' },
          'min-index-use': { type: 'string' },
          target: { type: 'string' },
          'target-scope': { type: 'string' },
          'max-short': { type: 'string' },
          format: { type: 'string' },
          out: { type: 'string' },
          seed: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
        },
      });
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  })();

  if (o.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (o.help || command === 'help') {
    io.stdout(HELP);
    return 0;
  }
  if (!command) {
    io.stderr(HELP);
    return 2;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);

  if (command === 'demo') {
    const { demo } = await import('./demo.js');
    const seed = parsePositiveInt(o.seed, '--seed', 42)!;
    await demo({ seed, out: (line) => io.stdout(`${line}\n`) });
    return 0;
  }
  if (command !== 'check' && command !== 'measure' && command !== 'sweep') {
    throw new UsageError(`unknown command "${command}" (expected demo, check, measure or sweep)`);
  }

  // ---- 연결 전에 인자를 모두 검증한다(잘못된 값이 DB 에 닿지 않게). ----
  const format = (o.format ?? 'table') as Format;
  if (!['table', 'json', 'md'].includes(format)) throw new UsageError('--format must be table, json or md');
  const url = o.url ?? io.env.DATABASE_URL;
  if (!url) throw new UsageError('--url is required (or set DATABASE_URL)');
  if (!/^postgres(ql)?:\/\//.test(url)) throw new UsageError('--url must start with postgres:// or postgresql://');
  if (!o.query) throw new UsageError('--query is required');
  const template: ParsedTemplate = parseTemplate(readSqlArg(o.query, io.cwd, '--query'));
  const k = parsePositiveInt(o.k, '--k');
  const maxCases = parsePositiveInt(o['max-cases'], '--max-cases', 50)!;
  const timeout = parseTimeout(o.timeout);
  const forceIndex = o['force-index'] ?? false;
  const targetScope = (o['target-scope'] ?? 'mean') as TargetScope;
  if (targetScope !== 'mean' && targetScope !== 'group') throw new UsageError('--target-scope must be mean or group');
  const minRecall = parseFraction(o['min-recall'], '--min-recall', null);
  const minIndexUse = parseFraction(o['min-index-use'], '--min-index-use', 1);
  const gating = o['min-recall'] !== undefined || o['min-index-use'] !== undefined;
  const target = parseFraction(o.target, '--target', 0.95);
  const maxShort = parseFraction(o['max-short'], '--max-short', 0);
  const ef = o.ef === undefined ? undefined : parseIntList(o.ef, '--ef', EF_SEARCH_MIN, EF_SEARCH_MAX);
  const iterative = o.iterative === undefined ? undefined : parseIterativeList(o.iterative);
  const mst = o['max-scan-tuples'] === undefined ? undefined : parseIntList(o['max-scan-tuples'], '--max-scan-tuples', 1, 2_147_483_647);
  if (o['cases-sql'] && o.cases) throw new UsageError('use either --cases-sql or --cases, not both');
  if (command !== 'check' && !o['cases-sql'] && !o.cases) throw new UsageError(`${command} needs --cases-sql or --cases`);
  const casesSql = o['cases-sql'] ? readSqlArg(o['cases-sql'], io.cwd, '--cases-sql') : null;
  let cases: QueryCase[] | undefined = o.cases
    ? casesFromJsonl(readFileOr2(resolve(io.cwd, o.cases), '--cases'), template, maxCases)
    : undefined;

  const progress = io.progress
    ? (done: number, total: number) => io.stderr(`\rmeasuring ${done}/${total}${done === total ? '\n' : ''}`)
    : undefined;

  const { db, close } = await connect(url);
  try {
    if (casesSql !== null) cases = await casesFromSql(db, casesSql, template, maxCases, timeout);

    if (command === 'check') {
      const result = await check(db, { template, cases, k, forceIndex, timeout });
      emit(io, renderCheck(result, format), renderCheck(result, 'table'), o.out);
      return result.diagnostics.some((d) => d.level === 'error') ? 1 : 0;
    }

    if (command === 'measure') {
      const config: HnswConfig = {};
      if (ef) config.efSearch = single(ef, '--ef');
      if (iterative) config.iterativeScan = single(iterative, '--iterative');
      if (mst) config.maxScanTuples = single(mst, '--max-scan-tuples');
      const result = await measure(db, { template, cases: cases!, configs: [config], k, forceIndex, timeout, onProgress: progress });
      const gate = gating ? evaluateGate(result.results[0]!, minRecall, minIndexUse, targetScope, result.k) : undefined;
      const input = { command: 'measure' as const, result, ...(gate ? { gate } : {}) };
      emit(io, renderMeasure(input, format), renderMeasure(input, 'table'), o.out);
      for (const f of gate?.failures ?? []) io.stderr(`FAIL ${f.code}: ${f.message}\n`);
      return gate && !gate.pass ? 1 : 0;
    }

    const result = await sweep(db, {
      template,
      cases: cases!,
      k,
      forceIndex,
      timeout,
      onProgress: progress,
      ...(ef ? { efSearch: ef } : {}),
      ...(iterative ? { iterativeScan: iterative } : {}),
      ...(mst ? { maxScanTuples: mst } : {}),
      target,
      targetScope,
      maxShort,
    });
    const input = { command: 'sweep' as const, result, recommendation: result.recommendation };
    emit(io, renderMeasure(input, format), renderMeasure(input, 'table'), o.out);
    if (!result.recommendation.choice) {
      io.stderr(`FAIL no-config-meets-target: nothing reached recall@${result.k} >= ${target} on the vector index\n`);
      return 1;
    }
    return 0;
  } finally {
    await close();
  }
}

function readFileOr2(path: string, name: string): string {
  if (!existsSync(path)) throw new UsageError(`${name}: file not found`);
  return readFileSync(path, 'utf8');
}

/** --out 이 있으면 파일에 지정 형식으로 쓰고 화면에는 표를, 없으면 화면에 지정 형식을. */
function emit(io: CliIO, rendered: string, table: string, out: string | undefined): void {
  if (out) {
    writeFileSync(resolve(io.cwd, out), rendered);
    io.stdout(table);
  } else {
    io.stdout(rendered);
  }
}

/** CI 게이트: 벡터 인덱스 사용 비율이 먼저, 그다음 recall. */
export function evaluateGate(
  r: ConfigResult,
  minRecall: number | null,
  minIndexUse: number,
  scope: TargetScope,
  k: number,
): GateResult {
  const failures: GateResult['failures'] = [];
  const used = r.summary.indexUsedRatio;
  if (used < minIndexUse) {
    failures.push({
      code: 'index-not-used',
      message: `${(used * 100).toFixed(1)}% of queries used the vector index (< ${(minIndexUse * 100).toFixed(1)}%); recall from exact scans is not index quality (${r.label}). Use --force-index to measure the index, or --min-index-use 0 to accept.`,
    });
  }
  if (minRecall !== null) {
    // 기본(--min-index-use 1): 벡터 인덱스를 탄 질의만의 recall = 인덱스 품질.
    // --min-index-use < 1 로 완화하면 정확 스캔까지 포함한, 앱이 실제로 받는 recall(observed)로 판정한다.
    const observed = minIndexUse < 1;
    const recall = observed ? scopedObserved(r, scope) : scopedRecall(r, scope);
    if (recall === null) {
      if (failures.length === 0) {
        failures.push({ code: 'index-not-used', message: `no query used the vector index, so recall@${k} is undefined (${r.label})` });
      }
    } else if (recall < minRecall) {
      failures.push({
        code: 'recall-below-min',
        message: `${observed ? 'observed ' : ''}recall@${k} ${recall.toFixed(3)}${scope === 'group' ? ' (worst group)' : ''} < ${minRecall} (${r.label})`,
      });
    }
  }
  return { minRecall, minIndexUse, pass: failures.length === 0, failures };
}

function scopedObserved(r: ConfigResult, scope: TargetScope): number | null {
  if (scope === 'mean' || r.groups.length === 0) return r.summary.observedRecall;
  const xs = r.groups.map((g) => g.observedRecall).filter((x): x is number => x !== null);
  return xs.length === 0 ? null : Math.min(...xs);
}

// 직접 실행될 때만(npx·bin·node dist/cli.js) 프로세스 입출력에 연결한다. import 될 때는 아무것도 하지 않는다.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  run(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    progress: process.stderr.isTTY === true,
  }).then((code) => {
    process.exitCode = code;
  });
}
