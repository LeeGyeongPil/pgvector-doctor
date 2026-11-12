// 화면 언어(영어·한국어) — 메시지 표, 언어 결정 순서, 현지화된 출력, JSON 불변.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDb, captureIO, type TestDb, CASES_BIG_SMALL_SQL, FILTER_QUERY } from './helpers/pglite.js';
import { run, errorText } from '../src/cli.js';
import { messageKeys, resolveLang, langFromEnv, t, type MessageKey } from '../src/i18n.js';
import { textTable, displayWidth } from '../src/report.js';
import { usageError, parseTemplate, UsageError } from '../src/template.js';
import { ConnectionError } from '../src/db.js';

const KO = { LANG: 'ko_KR.UTF-8' };
const HANGUL = /[가-힣]/;

/** 지연(…Ms) 필드를 재귀적으로 뺀 사본 — 지연만 실행마다 다르다. */
function withoutLatency(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutLatency);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).filter(([k]) => !k.endsWith('Ms')).map(([k, v]) => [k, withoutLatency(v)]));
  }
  return x;
}

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

describe('message tables', () => {
  it('en and ko have exactly the same keys and placeholders', () => {
    expect(messageKeys('ko').sort()).toEqual(messageKeys('en').sort());
    for (const key of messageKeys('en') as MessageKey[]) {
      // 자리표시 이름 집합이 같아야 한쪽에서만 값이 빠지지 않는다. help 는 {version} 하나.
      const en = placeholders(t('en', key));
      const ko = placeholders(t('ko', key));
      expect(ko, key).toEqual(en);
    }
  });

  it('ko values are never empty and Korean text appears where the English has prose', () => {
    for (const key of messageKeys('ko') as MessageKey[]) {
      expect(t('ko', key).trim(), key).not.toBe('');
    }
    expect(t('ko', 'help')).toMatch(HANGUL);
  });

  it('ko values never attach a particle right after a placeholder', () => {
    // '}' 뒤에 닫는 따옴표·괄호·공백을 허용한 다음 은|는|이|가|을|를|과|와|도|의|로|으로 가 오면 실패.
    // 받침 유무에 따라 조사가 달라지므로 값이 무엇이든 맞는 문장이어야 한다.
    const bad = /\}[)\]"'”’」』\s]*(?:으로|은|는|이|가|을|를|과|와|도|의|로)(?![가-힣])/;
    // 조사처럼 보이지만 뒤에 한글이 이어지는 낱말('이상', '입니다', '가장', '도달')은 위 lookahead 로 제외한다.
    const offenders = (messageKeys('ko') as MessageKey[]).filter((key) => bad.test(t('ko', key)));
    expect(offenders).toEqual([]);
  });
});

describe('resolveLang', () => {
  it('--lang beats every environment variable', () => {
    const env = { PGVECTOR_DOCTOR_LANG: 'ko', LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' };
    expect(resolveLang(['--lang', 'en', 'demo'], env)).toBe('en');
    expect(resolveLang(['demo', '--lang=en'], env)).toBe('en');
    expect(resolveLang(['--lang', 'ko'], { LANG: 'en_US.UTF-8' })).toBe('ko');
  });

  it('PGVECTOR_DOCTOR_LANG > LC_ALL > LC_MESSAGES > LANG', () => {
    expect(langFromEnv({ PGVECTOR_DOCTOR_LANG: 'en', LC_ALL: 'ko_KR.UTF-8' })).toBe('en');
    expect(langFromEnv({ PGVECTOR_DOCTOR_LANG: 'ko', LC_ALL: 'en_US.UTF-8' })).toBe('ko');
    expect(langFromEnv({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' })).toBe('en');
    expect(langFromEnv({ LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(langFromEnv({ LANG: 'ko_KR.UTF-8' })).toBe('ko');
    // 비어 있는 값은 건너뛴다
    expect(langFromEnv({ PGVECTOR_DOCTOR_LANG: '', LC_ALL: '  ', LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('anything that is not Korean means English', () => {
    expect(langFromEnv({ LANG: 'C' })).toBe('en');
    expect(langFromEnv({ LANG: 'POSIX' })).toBe('en');
    expect(langFromEnv({ LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(langFromEnv({})).toBe('en');
  });

  it('an invalid --lang value is ignored by resolveLang (the CLI reports it)', () => {
    expect(resolveLang(['--lang', 'fr'], KO)).toBe('ko');
    expect(resolveLang(['--', '--lang', 'ko'], {})).toBe('en');
  });
});

describe('table width', () => {
  it('counts Hangul as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('설정')).toBe(4);
    expect(displayWidth('a설')).toBe(3);
  });

  it('keeps columns aligned with Korean headers', () => {
    const out = textTable(['설정', '미달', '인덱스 사용'], [['ef=40', '10.0%', '100.0%']], ['l', 'r', 'r']).split('\n');
    // 머리글·구분선·본문이 같은 표시 폭이어야 열이 맞는다(마지막 열은 오른쪽 정렬이라 공백 꼬리가 없다).
    expect(new Set(out.map(displayWidth)).size).toBe(1);
  });
});

describe('usage errors without a database', () => {
  it('--help, no arguments and parseArgs errors follow --lang and the environment', async () => {
    const ko = captureIO({});
    expect(await run(['--lang', 'ko', '--help'], ko)).toBe(0);
    expect(ko.out()).toContain('사용법');
    expect(ko.out()).toContain('--lang en|ko');

    const env = captureIO(KO);
    expect(await run(['--help'], env)).toBe(0);
    expect(env.out()).toContain('사용법');

    const en = captureIO({});
    expect(await run(['--help'], en)).toBe(0);
    expect(en.out()).toContain('Usage');
    expect(en.out()).toContain('--lang en|ko');

    const none = captureIO(KO);
    expect(await run([], none)).toBe(2);
    expect(none.err()).toContain('사용법');

    const unknown = captureIO({});
    expect(await run(['--lang=ko', '--nope'], unknown)).toBe(2);
    expect(unknown.err()).toBe("error: 알 수 없는 옵션: '--nope'\n");

    const missing = captureIO(KO);
    expect(await run(['check', '--url'], missing)).toBe(2);
    expect(missing.err()).toBe("error: '--url' 옵션에는 값이 필요합니다\n");

    const noValue = captureIO(KO);
    expect(await run(['check', '--force-index=yes'], noValue)).toBe(2);
    expect(noValue.err()).toBe("error: '--force-index' 옵션은 값을 받지 않습니다\n");
  });

  it('English parseArgs errors keep the original Node text', async () => {
    const io = captureIO({});
    expect(await run(['--nope'], io)).toBe(2);
    expect(io.err()).toMatch(/^error: Unknown option '--nope'/);
  });

  it('--lang with a bad value is a usage error (exit 2), reported in the environment language', async () => {
    const io = captureIO(KO);
    expect(await run(['--lang', 'fr', 'demo'], io)).toBe(2);
    expect(io.err()).toBe('error: --lang 은 en 또는 ko 여야 합니다 (받은 값: "fr")\n');
    const en = captureIO({});
    expect(await run(['--lang=fr'], en)).toBe(2);
    expect(en.err()).toBe('error: --lang must be en or ko (got "fr")\n');
  });

  it('validation errors are localized and exit codes do not change', async () => {
    const cases: { argv: string[]; en: string; ko: string }[] = [
      { argv: ['bogus'], en: 'unknown command "bogus" (expected demo, check, measure or sweep)', ko: '알 수 없는 명령: "bogus" (demo, check, measure, sweep 중 하나여야 합니다)' },
      { argv: ['check', '--format', 'xml'], en: '--format must be table, json or md', ko: '--format 은 table, json, md 중 하나여야 합니다' },
      { argv: ['check', '--query', 'q'], en: '--url is required (or set DATABASE_URL)', ko: '--url 이 필요합니다 (또는 DATABASE_URL 을 설정하십시오)' },
      { argv: ['check', '--url', 'mysql://x'], en: '--url must start with postgres:// or postgresql://', ko: '--url 은 postgres:// 또는 postgresql:// 로 시작해야 합니다' },
      { argv: ['check', '--url', 'postgres://x', '--query', 'nofile'], en: '--query: file not found: nofile', ko: '--query: 파일을 찾을 수 없습니다: nofile' },
      { argv: ['check', '--url', 'postgres://x', '--query', 'SELECT 1 LIMIT 1', '--k', 'x'], en: 'query template must use $1 for the query vector (e.g. ORDER BY embedding <=> $1)', ko: '질의 템플릿은 질의 벡터 자리에 $1 을 써야 합니다 (예: ORDER BY embedding <=> $1)' },
      { argv: ['check', '--url', 'postgres://x', '--query', FILTER_QUERY, '--min-recall', '2'], en: '--min-recall must be a number between 0 and 1', ko: '--min-recall: 0 이상 1 이하의 숫자여야 합니다' },
      { argv: ['check', '--url', 'postgres://x', '--query', FILTER_QUERY, '--ef', '4x'], en: '--ef: "4x" is not a whole number', ko: '--ef: 정수가 아닌 값입니다: "4x"' },
      { argv: ['check', '--url', 'postgres://x', '--query', FILTER_QUERY, '--iterative', 'nope'], en: '--iterative: "nope" must be one of off, strict_order, relaxed_order', ko: '--iterative: 다음 중 하나여야 합니다: off, strict_order, relaxed_order (받은 값: "nope")' },
      { argv: ['measure', '--url', 'postgres://x', '--query', FILTER_QUERY], en: 'measure needs --cases-sql or --cases', ko: '명령 measure: --cases-sql 또는 --cases 가 필요합니다' },
      { argv: ['check', 'extra', 'more'], en: 'unexpected argument: extra', ko: '예상하지 못한 인자: extra' },
    ];
    for (const c of cases) {
      const en = captureIO({});
      const ko = captureIO({});
      const enCode = await run(c.argv, en);
      const koCode = await run(['--lang', 'ko', ...c.argv], ko);
      expect(enCode, c.argv.join(' ')).toBe(2);
      expect(koCode, c.argv.join(' ')).toBe(enCode);
      expect(en.err(), c.argv.join(' ')).toBe(`error: ${c.en}\n`);
      expect(ko.err(), c.argv.join(' ')).toBe(`error: ${c.ko}\n`);
    }
  });

  it('library exceptions keep an English message and carry code and params', () => {
    let err: unknown;
    try {
      parseTemplate('SELECT id FROM items LIMIT 5');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe('query template must use $1 for the query vector (e.g. ORDER BY embedding <=> $1)');
    expect((err as UsageError).code).toBe('err.tpl-no-param');
    expect(errorText('ko', err)).toMatch(HANGUL);
    expect(errorText('en', err)).toBe((err as Error).message);

    const plain = new Error('boom');
    expect(errorText('ko', plain)).toBe('boom');
    const custom = new UsageError('custom text');
    expect(errorText('ko', custom)).toBe('custom text');
    expect(usageError('err.no-cases').message).toBe('no query cases');
  });

  it('connection errors localize only the prefix and keep the driver text', () => {
    const err = new ConnectionError('could not connect: ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED 127.0.0.1:1');
    expect(errorText('en', err)).toBe('could not connect: ECONNREFUSED 127.0.0.1:1');
    expect(errorText('ko', err)).toBe('접속하지 못했습니다: ECONNREFUSED 127.0.0.1:1');
  });
});

describe('localized output with a database', () => {
  let db: TestDb;
  let dir: string;
  let common: string[];
  beforeAll(async () => {
    db = await startDb({ socket: true });
    dir = mkdtempSync(join(tmpdir(), 'pgvd-i18n-'));
    common = ['--url', db.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, '--force-index'];
  });
  afterAll(async () => {
    await db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('check table is Korean with --lang ko and English otherwise; tags and rule IDs stay', async () => {
    const en = captureIO({}, dir);
    const ko = captureIO({}, dir);
    const args = ['check', '--url', db.url!, '--query', FILTER_QUERY, '--k', '10'];
    const enCode = await run(args, en);
    const koCode = await run(['--lang', 'ko', ...args], ko);
    expect(koCode).toBe(enCode);
    expect(en.out()).toContain('tables:');
    expect(ko.out()).toContain('테이블:');
    expect(ko.out()).toContain('벡터 인덱스:');
    expect(ko.out()).not.toContain('tables:');
    // 규칙 ID·태그는 번역하지 않는다 — 같은 줄 구조(태그 + 코드)가 en 과 ko 에서 같다.
    const tags = (s: string) => s.split('\n').filter((l) => /^(ERROR|WARN|INFO|OK) /.test(l)).map((l) => l.split(':')[0]);
    expect(tags(ko.out())).toEqual(tags(en.out()));
  });

  it('check diagnostics render in Korean from code and params (index not used)', async () => {
    const ko = captureIO({}, dir);
    const code = await run(['--lang', 'ko', 'check', '--url', db.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL], ko);
    expect(code === 0 || code === 1).toBe(true);
    // 첫 사례 값으로 EXPLAIN 하면 작은 테넌트 값일 수 있어 플랜은 다를 수 있다 — 어느 쪽이든 한글 줄이 나온다.
    expect(ko.out()).toMatch(HANGUL);
    expect(ko.out()).not.toMatch(/no problems found|vector indexes:/);
  });

  it('measure gate: FAIL line is Korean, the code and exit code are unchanged', async () => {
    const args = ['measure', ...common, '--ef', '40', '--iterative', 'off', '--min-recall', '1'];
    const en = captureIO({}, dir);
    const ko = captureIO({}, dir);
    const enCode = await run(args, en);
    const koCode = await run(['--lang', 'ko', ...args], ko);
    expect(enCode).toBe(1);
    expect(koCode).toBe(1);
    expect(en.err()).toMatch(/^FAIL recall-below-min: recall@10 0\.\d{3} < 1 \(ef_search=40 iterative_scan=off\)\n$/);
    expect(ko.err()).toMatch(/^FAIL recall-below-min: recall@10 0\.\d{3} < 1 \(ef_search=40 iterative_scan=off\)\n$/);
    expect(ko.out()).toContain('설정');
    expect(ko.out()).toContain('그룹별');
    expect(en.out()).toContain('by group');
  });

  it('measure gate FAIL for index use renders a Korean sentence', async () => {
    const args = ['measure', '--url', db.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, '--min-recall', '0.5'];
    const ko = captureIO({}, dir);
    const code = await run(['--lang', 'ko', ...args], ko);
    if (code === 1) {
      expect(ko.err()).toMatch(/^FAIL index-not-used: 벡터 인덱스를 쓴 질의 비율 /);
      expect(ko.out()).toContain('! 질의 ');
      expect(ko.out()).toMatch(/플래너 선택: /);
    } else {
      expect(code).toBe(0);
    }
  });

  it('--format json is identical in en and ko (latency aside), gate and exit code included', async () => {
    for (const extra of [
      ['measure', '--ef', '40', '--iterative', 'off', '--min-recall', '1'],
      ['measure', '--min-recall', '0.5'],
      ['sweep', '--ef', '40,100', '--iterative', 'off,relaxed_order', '--target', '1', '--max-short', '0'],
    ]) {
      const args = [extra[0]!, ...common, ...extra.slice(1), '--format', 'json'];
      const en = captureIO({}, dir);
      const ko = captureIO({}, dir);
      const enCode = await run(args, en);
      const koCode = await run(['--lang', 'ko', ...args], ko);
      expect(koCode).toBe(enCode);
      const enJson = JSON.parse(en.out());
      const koJson = JSON.parse(ko.out());
      expect(withoutLatency(koJson)).toEqual(withoutLatency(enJson));
      // 사람이 읽는 문장은 JSON 에서 영어 그대로, 한글이 하나도 없다
      expect(ko.out()).not.toMatch(HANGUL);
    }
  });

  it('check --format json is identical in en and ko', async () => {
    const args = ['check', '--url', db.url!, '--query', FILTER_QUERY, '--k', '10', '--format', 'json'];
    const en = captureIO({}, dir);
    const ko = captureIO({}, dir);
    expect(await run(args, en)).toBe(await run(['--lang', 'ko', ...args], ko));
    expect(ko.out()).toBe(en.out());
  });

  it('sweep prints a Korean recommendation, and the no-config FAIL line is Korean', async () => {
    const ok = captureIO({}, dir);
    expect(await run(['--lang', 'ko', 'sweep', ...common, '--ef', '40,400', '--iterative', 'off,relaxed_order', '--target', '0.5'], ok)).toBe(0);
    expect(ok.out()).toContain('추천: ');
    expect(ok.out()).toContain('SET LOCAL hnsw.ef_search');
    expect(ok.out()).toContain('참고: ');

    const fail = captureIO({}, dir);
    const code = await run(['--lang', 'ko', 'sweep', ...common, '--ef', '40', '--iterative', 'off', '--target', '1'], fail);
    expect(code).toBe(1);
    expect(fail.err()).toMatch(/^FAIL no-config-meets-target: 벡터 인덱스에서 목표 recall@10 >= 1 에 도달한 설정이 없습니다\n$/);
    expect(fail.out()).toContain('조건을 만족하는 설정이 없습니다');
    expect(fail.out()).toContain('설정별 제외 사유');
    expect(fail.out()).toContain('recall-below-target');
  });

  it('markdown report is localized and keeps rule IDs', async () => {
    const ko = captureIO({}, dir);
    await run(['--lang', 'ko', 'measure', ...common, '--ef', '40', '--iterative', 'off', '--min-recall', '1', '--format', 'md'], ko);
    expect(ko.out()).toContain('- **FAIL** recall-below-min: ');
    expect(ko.out()).toContain('| 설정 |');
    expect(ko.out()).toContain('### 그룹별 — ');
  });
});

describe('demo', () => {
  it('first line and scene titles follow the language', async () => {
    const ko = captureIO(KO);
    expect(await run(['demo'], ko)).toBe(0);
    const lines = ko.out().split('\n');
    expect(lines[0]).toBe('pgvector-doctor demo — 연습용(목) 모드');
    expect(ko.out()).toContain('━━ 장면 1');
    expect(ko.out()).toContain('━━ 장면 3');
    expect(ko.out()).toContain('추천: ');

    // --lang en 이 환경 변수(ko)를 이긴다
    const en = captureIO(KO);
    expect(await run(['--lang', 'en', 'demo'], en)).toBe(0);
    expect(en.out().split('\n')[0]).toBe('pgvector-doctor demo — practice (mock) mode');
    expect(en.out()).toContain('━━ Scene 1');
    expect(en.out()).toContain('Recommended: ');
  });
});
