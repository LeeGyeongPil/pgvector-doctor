#!/usr/bin/env node
// pgvector-doctor CLI — 하위 명령 분기·인자 검증·종료 코드.
//   종료 코드: 0 통과 / 1 품질 미달·인덱스 미사용·진단 오류 / 2 사용법·접속·SQL 오류
//   테스트는 프로세스를 띄우지 않고 run(argv, io) 를 직접 부른다.
import { readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connect, ConnectionError } from './db.js';
import { parseTemplate, UsageError, usageError, type ParsedTemplate } from './template.js';
import { t, resolveLang, findLangFlag, isLang, localizedText, withL10n, type Lang } from './i18n.js';
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

/** 도움말 본문은 i18n.ts 의 메시지 표에 있다(언어별). */
const helpText = (lang: Lang): string => t(lang, 'help', { version: VERSION });

/** 파일이면 읽고, 아니면 공백이 들어간 인라인 SQL 로 본다. */
function readSqlArg(value: string, cwd: string, name: string): string {
  const path = resolve(cwd, value);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  if (/\s/.test(value.trim())) return value;
  throw usageError('err.file-not-found', { name, value });
}

function parseFraction(raw: string | undefined, name: string, fallback: number): number;
function parseFraction(raw: string | undefined, name: string, fallback: null): number | null;
function parseFraction(raw: string | undefined, name: string, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(raw.trim())) throw usageError('err.fraction', { name });
  return Number(raw);
}

function parsePositiveInt(raw: string | undefined, name: string, fallback?: number): number | undefined {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) throw usageError('err.positive-int', { name });
  return Number(raw);
}

/** statement_timeout 값 — 숫자 + 단위만(주입 방지). */
function parseTimeout(raw: string | undefined): string {
  const v = (raw ?? '30s').trim();
  if (!/^\d+(ms|s|min)?$/.test(v)) throw usageError('err.timeout');
  return v;
}

function single<T>(list: T[], name: string): T {
  if (list.length !== 1) throw usageError('err.single-value', { name });
  return list[0]!;
}

/**
 * 표시할 오류 문장. 영어는 err.message 그대로, 한국어는 code·params 로 다시 만든다.
 * 드라이버·Postgres 가 준 원문(접속 오류의 detail 등)은 번역하지 않고 그대로 붙인다.
 */
export function errorText(lang: Lang, err: unknown): string {
  if (err instanceof UsageError) {
    return lang === 'en' || !err.code ? err.message : t(lang, err.code, err.params ?? {});
  }
  if (err instanceof ConnectionError) {
    return lang === 'en' || err.detail === undefined ? err.message : t(lang, 'err.connect', { detail: err.detail });
  }
  return (err as Error).message ?? String(err);
}

/** node:util parseArgs 오류 → 옵션 이름만 뽑아 현지화할 수 있는 UsageError(영어 message 는 Node 원문 그대로). */
function parseArgsError(err: Error & { code?: string }): UsageError {
  const quoted = /'([^']+)'/.exec(err.message)?.[1] ?? '';
  const option = quoted.replace(/ <value>$/, '').split(', ').pop() ?? quoted;
  switch (err.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return new UsageError(err.message, 'err.opt-unknown', { option });
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return new UsageError(err.message, /does not take/.test(err.message) ? 'err.opt-no-value' : 'err.opt-missing-value', { option });
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return new UsageError(err.message, 'err.unexpected-arg', { arg: quoted });
    default:
      return new UsageError(err.message, 'err.opt-other', { detail: err.message });
  }
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  // 화면 언어는 parseArgs 보다 먼저 정한다 — --help·인자 오류도 같은 언어로 보이게.
  const lang = resolveLang(argv, io.env);
  try {
    return await runInner(argv, io, lang);
  } catch (err) {
    io.stderr(`error: ${errorText(lang, err)}\n`);
    return 2;
  }
}

async function runInner(argv: string[], io: CliIO, lang: Lang): Promise<number> {
  const langFlag = findLangFlag(argv);
  if (langFlag !== undefined && !isLang(langFlag)) throw usageError('err.lang', { value: langFlag });
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
          lang: { type: 'string' },
          seed: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
        },
      });
    } catch (err) {
      throw parseArgsError(err as Error & { code?: string });
    }
  })();

  if (o.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (o.help || command === 'help') {
    io.stdout(helpText(lang));
    return 0;
  }
  if (!command) {
    io.stderr(helpText(lang));
    return 2;
  }
  if (positionals.length > 1) throw usageError('err.unexpected-arg', { arg: positionals[1]! });

  if (command === 'demo') {
    const { demo } = await import('./demo.js');
    const seed = parsePositiveInt(o.seed, '--seed', 42)!;
    await demo({ seed, out: (line) => io.stdout(`${line}\n`), lang });
    return 0;
  }
  if (command !== 'check' && command !== 'measure' && command !== 'sweep') {
    throw usageError('err.unknown-command', { command });
  }

  // ---- 연결 전에 인자를 모두 검증한다(잘못된 값이 DB 에 닿지 않게). ----
  const format = (o.format ?? 'table') as Format;
  if (!['table', 'json', 'md'].includes(format)) throw usageError('err.format');
  const url = o.url ?? io.env.DATABASE_URL;
  if (!url) throw usageError('err.url-required');
  if (!/^postgres(ql)?:\/\//.test(url)) throw usageError('err.url-scheme');
  if (!o.query) throw usageError('err.query-required');
  const template: ParsedTemplate = parseTemplate(readSqlArg(o.query, io.cwd, '--query'));
  const k = parsePositiveInt(o.k, '--k');
  const maxCases = parsePositiveInt(o['max-cases'], '--max-cases', 50)!;
  const timeout = parseTimeout(o.timeout);
  const forceIndex = o['force-index'] ?? false;
  const targetScope = (o['target-scope'] ?? 'mean') as TargetScope;
  if (targetScope !== 'mean' && targetScope !== 'group') throw usageError('err.target-scope');
  const minRecall = parseFraction(o['min-recall'], '--min-recall', null);
  const minIndexUse = parseFraction(o['min-index-use'], '--min-index-use', 1);
  const gating = o['min-recall'] !== undefined || o['min-index-use'] !== undefined;
  const target = parseFraction(o.target, '--target', 0.95);
  const maxShort = parseFraction(o['max-short'], '--max-short', 0);
  const ef = o.ef === undefined ? undefined : parseIntList(o.ef, '--ef', EF_SEARCH_MIN, EF_SEARCH_MAX);
  const iterative = o.iterative === undefined ? undefined : parseIterativeList(o.iterative);
  const mst = o['max-scan-tuples'] === undefined ? undefined : parseIntList(o['max-scan-tuples'], '--max-scan-tuples', 1, 2_147_483_647);
  if (o['cases-sql'] && o.cases) throw usageError('err.cases-both');
  if (command !== 'check' && !o['cases-sql'] && !o.cases) throw usageError('err.needs-cases', { command });
  const casesSql = o['cases-sql'] ? readSqlArg(o['cases-sql'], io.cwd, '--cases-sql') : null;
  let cases: QueryCase[] | undefined = o.cases
    ? casesFromJsonl(readFileOr2(resolve(io.cwd, o.cases), '--cases'), template, maxCases)
    : undefined;

  const progress = io.progress
    ? (done: number, total: number) => io.stderr(`\r${t(lang, 'progress', { done, total })}${done === total ? '\n' : ''}`)
    : undefined;

  const { db, close } = await connect(url);
  try {
    if (casesSql !== null) cases = await casesFromSql(db, casesSql, template, maxCases, timeout);

    if (command === 'check') {
      const result = await check(db, { template, cases, k, forceIndex, timeout });
      emit(io, renderCheck(result, format, lang), renderCheck(result, 'table', lang), o.out);
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
      emit(io, renderMeasure(input, format, lang), renderMeasure(input, 'table', lang), o.out);
      for (const f of gate?.failures ?? []) io.stderr(`FAIL ${f.code}: ${localizedText(lang, f, f.message)}\n`);
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
    emit(io, renderMeasure(input, format, lang), renderMeasure(input, 'table', lang), o.out);
    if (!result.recommendation.choice) {
      io.stderr(`FAIL no-config-meets-target: ${t(lang, 'fail.no-config', { k: result.k, target })}\n`);
      return 1;
    }
    return 0;
  } finally {
    await close();
  }
}

function readFileOr2(path: string, name: string): string {
  if (!existsSync(path)) throw usageError('err.file-not-found-short', { name });
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
    failures.push(
      failure('index-not-used', (l) =>
        t(l, 'gate.index-not-used', { used: (used * 100).toFixed(1), min: (minIndexUse * 100).toFixed(1), label: r.label }),
      ),
    );
  }
  if (minRecall !== null) {
    // 기본(--min-index-use 1): 벡터 인덱스를 탄 질의만의 recall = 인덱스 품질.
    // --min-index-use < 1 로 완화하면 정확 스캔까지 포함한, 앱이 실제로 받는 recall(observed)로 판정한다.
    const observed = minIndexUse < 1;
    const recall = observed ? scopedObserved(r, scope) : scopedRecall(r, scope);
    if (recall === null) {
      if (failures.length === 0) {
        failures.push(failure('index-not-used', (l) => t(l, 'gate.no-index-query', { k, label: r.label })));
      }
    } else if (recall < minRecall) {
      failures.push(
        failure('recall-below-min', (l) =>
          t(l, 'gate.recall-below-min', {
            observed: observed ? t(l, 'word.observed') : '',
            k,
            recall: recall.toFixed(3),
            worst: scope === 'group' ? t(l, 'word.worst-group') : '',
            min: minRecall,
            label: r.label,
          }),
        ),
      );
    }
  }
  return { minRecall, minIndexUse, pass: failures.length === 0, failures };
}

/** 게이트 실패 한 건. message 는 영어(JSON 용), 한국어 렌더러는 비열거 속성으로 JSON 에 나타나지 않는다. */
function failure(code: GateResult['failures'][number]['code'], build: (lang: Lang) => string): GateResult['failures'][number] {
  return withL10n({ code, message: build('en') }, build);
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
