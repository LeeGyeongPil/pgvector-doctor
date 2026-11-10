// AC-8 — CI 게이트 종료 코드, 보고서 형식, 결정적 보고서
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDb, captureIO, type TestDb, CASES_BIG_SMALL_SQL, FILTER_QUERY } from './helpers/pglite.js';
import { run } from '../src/cli.js';

/** 지연(…Ms) 필드를 재귀적으로 뺀 사본 — 지연만 실행마다 다르다. */
function withoutLatency(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutLatency);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).filter(([k]) => !k.endsWith('Ms')).map(([k, v]) => [k, withoutLatency(v)]));
  }
  return x;
}

describe('CLI exit codes and reports', () => {
  let t: TestDb;
  let dir: string;
  let common: string[];
  beforeAll(async () => {
    t = await startDb({ socket: true });
    dir = mkdtempSync(join(tmpdir(), 'pgvd-exit-'));
    common = ['--url', t.url!, '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, '--force-index'];
  });
  afterAll(async () => {
    await t?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('gate below target → exit 1 with FAIL on stderr', async () => {
    const io = captureIO();
    const code = await run(['measure', ...common, '--ef', '40', '--iterative', 'off', '--min-recall', '0.95'], io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/^FAIL recall-below-min: recall@10 0\.\d{3} < 0\.95 \(ef_search=40 iterative_scan=off\)/);
  });

  it('gate met with relaxed_order → exit 0', async () => {
    const io = captureIO();
    const code = await run(['measure', ...common, '--ef', '40', '--iterative', 'relaxed_order', '--min-recall', '0.95'], io);
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    expect(io.out()).toMatch(/PASS quality gate/);
  });

  it('wrong --url → exit 2 (connection error), usage errors → exit 2', async () => {
    const io = captureIO();
    const code = await run(['measure', '--url', 'postgresql://postgres@127.0.0.1:1/postgres', '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL], io);
    expect(code).toBe(2);
    expect(io.err()).toMatch(/^error: could not connect/);

    const cases: string[][] = [
      ['nope'],
      ['measure', ...common, '--format', 'xml'],
      ['measure', '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL], // url 없음
      ['measure', '--url', 'mysql://x', '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL],
      ['measure', '--url', t.url!, '--query', FILTER_QUERY], // 사례 없음
      ['measure', ...common, '--min-recall', '1.5'],
      ['measure', ...common, '--ef', '40,100'], // measure 는 값 하나
      ['measure', ...common, '--unknown-flag'],
      ['measure', '--url', t.url!, '--query', 'missing-file.sql', '--cases-sql', CASES_BIG_SMALL_SQL],
    ];
    for (const argv of cases) {
      const e = captureIO();
      expect(await run(argv, e), argv.join(' ')).toBe(2);
      expect(e.err()).toMatch(/error/);
    }
  });

  it('DATABASE_URL is used when --url is absent', async () => {
    const io = captureIO({ DATABASE_URL: t.url! });
    expect(await run(['measure', '--query', FILTER_QUERY, '--cases-sql', CASES_BIG_SMALL_SQL, '--force-index'], io)).toBe(0);
  });

  it('--format md --out writes a Markdown table', async () => {
    const io = captureIO({}, dir);
    const code = await run(['measure', ...common, '--min-recall', '0.5', '--format', 'md', '--out', 'r.md'], io);
    // 큰 테넌트 10건(≈1.0) + 작은 테넌트 20건(≈0.06) → 평균 ≈ 0.37 < 0.5
    expect(code).toBe(1);
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toMatch(/^- \*\*FAIL\*\* recall-below-min: /m);
    expect(io.out()).not.toMatch(/FAIL/); // 화면 표에는 중복으로 쓰지 않고
    expect(io.err()).toMatch(/^FAIL recall-below-min/); // stderr 에 한 번
    expect(md).toMatch(/^## pgvector-doctor measure/);
    expect(md).toContain('| config | recall@k |');
    expect(md).toContain('### by group — ef_search=40 iterative_scan=off');
    expect(md).not.toContain(dir); // 절대 경로 없음
    // 화면에는 표 형식
    expect(io.out()).toMatch(/^pgvector 0\.8\.\d+ · k=10/);
  });

  it('sweep exits 0 with a recommendation and prints SET LOCAL lines', async () => {
    const io = captureIO();
    const code = await run(['sweep', ...common, '--ef', '40,100', '--iterative', 'off,strict_order'], io);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/^Recommended: ef_search=\d+ iterative_scan=strict_order/m);
    expect(io.out()).toMatch(/^SET LOCAL hnsw\.iterative_scan = strict_order;$/m);

    const none = captureIO();
    expect(await run(['sweep', ...common, '--ef', '40', '--iterative', 'off'], none)).toBe(1);
    expect(none.out()).toMatch(/No configuration met recall@10/);
    expect(none.err()).toMatch(/^FAIL no-config-meets-target/);
  });

  it('two runs give the same JSON apart from latency (no timestamps, no paths)', async () => {
    const argv = ['measure', ...common, '--ef', '100', '--iterative', 'off', '--format', 'json'];
    const a = captureIO();
    const b = captureIO();
    expect(await run(argv, a)).toBe(0);
    expect(await run(argv, b)).toBe(0);
    const ja = JSON.parse(a.out());
    const jb = JSON.parse(b.out());
    expect(withoutLatency(ja)).toEqual(withoutLatency(jb));
    expect(ja.results[0].p50Ms).toEqual(expect.any(Number));
    expect(a.out()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(a.out()).not.toContain(tmpdir());
  });

  it('--version and --help exit 0', async () => {
    const v = captureIO();
    expect(await run(['--version'], v)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+\n$/);
    const h = captureIO();
    expect(await run(['--help'], h)).toBe(0);
    expect(h.out()).toMatch(/Exit codes: 0 ok/);
  });
});
