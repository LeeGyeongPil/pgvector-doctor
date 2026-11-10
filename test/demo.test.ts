// AC-1 회귀 — demo 3장면이 README 가 가르치는 교훈을 실제로 재현하는지(npm start 와 같은 경로)
import { describe, it, expect } from 'vitest';
import { captureIO } from './helpers/pglite.js';
import { run } from '../src/cli.js';

describe('demo (practice mock mode)', () => {
  it('shows fake-perfect blocking, small-tenant collapse and a recommendation within 60 s', async () => {
    const io = captureIO();
    const t0 = Date.now();
    expect(await run(['demo'], io)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(60_000);
    const out = io.out();

    expect(out).toMatch(/practice \(mock\) mode/);
    expect(out).toMatch(/pgvector 0\.8\./);
    // 장면 1: 플래너가 벡터 인덱스를 안 탄 질의를 걸러 낸다
    expect(out).toMatch(/! index not used for \d+\/50 queries — recall not counted/);

    // 장면 2: ef40/off 에서 작은 테넌트 recall 붕괴
    const small = out.split('\n').find((l) => l.startsWith('ef_search=40 iterative_scan=off') && l.includes('small tenants'));
    expect(small).toBeDefined();
    const smallRecall = Number(small!.trim().split(/\s+/).at(-3));
    expect(smallRecall).toBeLessThan(0.3);

    // 장면 3: 추천 recall >= 0.95 와 SET LOCAL
    const rec = out.split('\n').find((l) => l.startsWith('Recommended:'))!;
    expect(rec).toBeDefined();
    const recall = Number(/recall@10 (\d\.\d{3})/.exec(rec)![1]);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(rec).not.toMatch(/Recommended: ef_search=40 iterative_scan=off /);
    expect(out).toMatch(/^SET LOCAL hnsw\.ef_search = \d+;$/m);
  });
});
