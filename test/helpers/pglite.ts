// 테스트용 DB — 프로세스 안 PGlite(진짜 PostgreSQL + pgvector, WASM) + 시드 고정 픽스처.
// socket: true 면 pglite-socket 을 127.0.0.1 임의 포트(0)에 띄워 pg 드라이버 경로(CLI --url)를 그대로 시험한다.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { tmpdir } from 'node:os';
import { type Queryable, pgliteQueryable } from '../../src/db.js';
import { createFixture, type FixtureInfo, type FixtureOptions } from '../../src/fixture.js';
import type { CliIO } from '../../src/cli.js';

export interface TestDb {
  pglite: PGlite;
  db: Queryable;
  fixture: FixtureInfo | null;
  /** socket: true 일 때만 */
  url: string | null;
  close: () => Promise<void>;
}

export async function startDb(opts: { socket?: boolean; fixture?: FixtureOptions | false } = {}): Promise<TestDb> {
  const pglite = await PGlite.create({ extensions: { vector } });
  const db: Queryable = pgliteQueryable(pglite);
  const fixture = opts.fixture === false ? null : await createFixture(db, opts.fixture ?? {});
  let server: PGLiteSocketServer | null = null;
  let url: string | null = null;
  if (opts.socket) {
    // maxConnections 를 넉넉히: 앞 연결의 close 처리가 비동기라, 바로 다음 연결이 거절되지 않게.
    server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 4 });
    await server.start();
    url = `postgresql://postgres@${server.getServerConn()}/postgres`;
  }
  return {
    pglite,
    db,
    fixture,
    url,
    close: async () => {
      // 서버를 먼저 닫고 DB 를 닫는다 — 테스트가 끝나면 소켓·WASM 인스턴스가 남지 않게.
      if (server) await server.stop();
      await pglite.close();
    },
  };
}

/** CLI 를 프로세스 없이 부르기 위한 입출력 수집기. */
export function captureIO(
  env: Record<string, string | undefined> = {},
  cwd: string = tmpdir(),
): CliIO & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env,
    cwd,
    out: () => out,
    err: () => err,
  };
}

/** 픽스처용 사례 SQL: 큰 테넌트 15건 + 작은 테넌트 10곳 × 3건. group 열이 없어 p2(tenant_id) 값별로 분해된다. */
export const CASES_BY_TENANT_SQL = `
(SELECT embedding AS vector, tenant_id AS p2, id AS self_id
   FROM items WHERE tenant_id = 0 ORDER BY md5(id::text) LIMIT 15)
UNION ALL
(SELECT embedding, tenant_id, id FROM (
   SELECT embedding, tenant_id, id, row_number() OVER (PARTITION BY tenant_id ORDER BY md5(id::text)) AS rn
   FROM items WHERE tenant_id BETWEEN 1 AND 10) s
 WHERE rn <= 3 ORDER BY tenant_id, rn)`;

/** 큰/작은 두 그룹으로 나눈 사례 SQL(group 열 사용). */
export const CASES_BIG_SMALL_SQL = `
(SELECT embedding AS vector, tenant_id AS p2, id AS self_id, 'big' AS "group"
   FROM items WHERE tenant_id = 0 ORDER BY md5(id::text) LIMIT 10)
UNION ALL
(SELECT DISTINCT ON (tenant_id) embedding, tenant_id, id, 'small'
   FROM items WHERE tenant_id BETWEEN 1 AND 20 ORDER BY tenant_id, md5(id::text))`;

export const FILTER_QUERY = 'SELECT id FROM items WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10';
