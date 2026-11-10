// DB 접근 계층 — pg 드라이버(실제 DB)와 PGlite(연습용 목 모드)를 같은 모양으로 다룬다.
import pg from 'pg';

/**
 * `query(text, params)` 하나만 있으면 된다. pg.Client 와 PGlite 가 둘 다 이 모양이다.
 * 약속: `text` 는 문장 하나로만 실행한다(여러 문장이면 오류). 아래 두 어댑터는 확장 프로토콜로 이를 지킨다.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** 트랜잭션 안에서만 바꿀 설정 하나(GUC 이름, 값). 값은 sweep.ts 에서 화이트리스트로 검증한다. */
export type Setting = readonly [name: string, value: string];

/** 접속 실패 — CLI 에서 종료 코드 2 로 바뀐다. */
export class ConnectionError extends Error {
  override name = 'ConnectionError';
}

/** 접속 문자열로 pg Client 를 연다. 끝나면 반드시 `close()` 를 부른다. */
export async function connect(url: string): Promise<{ db: Queryable; close: () => Promise<void> }> {
  // 실제 DB 는 공유 자원이라 느릴 수 있다 — 접속 대기는 넉넉히(30초) 둔다.
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
  // 연결이 끊겨도 프로세스가 'error' 이벤트로 죽지 않게 한다(다음 query 가 오류를 던진다).
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw new ConnectionError(`could not connect: ${(err as Error).message}`);
  }
  const db: Queryable = {
    query: async (text, params) => {
      // 모든 문장을 확장 프로토콜로 보낸다(파라미터가 없어도 빈 배열). 확장 프로토콜은 문장 하나만
      // 받으므로, 사용자 SQL 에 '; COMMIT; DELETE …' 가 어떤 인용·주석 트릭으로 숨어 있어도
      // DB 가 "cannot insert multiple commands" 로 거부한다 — READ ONLY 트랜잭션을 벗어날 길이 없다.
      // (단순 프로토콜 경로를 아예 두지 않는 것이 핵심: 예외 경로가 하나라도 있으면 그곳이 구멍이 된다.)
      const config = { text, values: params ?? [], queryMode: 'extended' } as pg.QueryConfig;
      const r: unknown = await client.query(config);
      // 결과가 배열이면 문장이 여러 개 실행됐다는 뜻 — 확장 프로토콜에서는 나올 수 없지만 한 번 더 막는다.
      if (Array.isArray(r)) throw new Error('multiple statements are not allowed');
      return { rows: (r as pg.QueryResult).rows as Record<string, unknown>[] };
    },
  };
  return { db, close: () => client.end() };
}

/** PGlite 의 필요한 부분만(타입 의존 없이). */
export interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * PGlite → Queryable. pg 드라이버 경로와 똑같이 모든 문장을 확장 프로토콜(`query`)로 보낸다 —
 * 다중 문장을 실행하는 `exec`(단순 프로토콜)는 쓰지 않는다.
 */
export function pgliteQueryable(pglite: PGliteLike): Queryable {
  return {
    query: async (text, params) => ({ rows: (await pglite.query<Record<string, unknown>>(text, params ?? [])).rows }),
  };
}

/**
 * 읽기 전용 트랜잭션 안에서 `fn` 을 실행한다.
 * - `BEGIN READ ONLY` → 쓰기 SQL 은 DB 가 거부한다(운영 DB 보호).
 * - 설정은 `set_config(name, value, true)` = `SET LOCAL` 과 같다. 트랜잭션이 끝나면 원래 값으로 돌아간다.
 *   값은 SQL 문자열에 이어 붙이지 않고 바인드 파라미터로 넘긴다(주입 방지 이중 장치).
 * - 성공이면 COMMIT, 실패면 ROLLBACK — 어느 경로든 트랜잭션을 열어 둔 채 끝나지 않는다.
 */
export async function withReadOnly<T>(db: Queryable, settings: readonly Setting[], fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN READ ONLY');
  try {
    for (const [name, value] of settings) {
      await db.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** 벡터 값을 pgvector 텍스트 표현 `[1,2,3]` 으로 맞춘다(드라이버마다 문자열·배열로 다르게 돌려준다). */
export function toVectorText(value: unknown): string {
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^\[.*\]$/s.test(s)) throw new TypeError(`vector must look like [1,2,3], got ${s.slice(0, 40)}`);
    return s;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const nums = Array.from(value as ArrayLike<unknown>, (x) => Number(x));
    if (nums.some((x) => !Number.isFinite(x))) throw new TypeError('vector contains a non-finite number');
    return `[${nums.join(',')}]`;
  }
  throw new TypeError(`unsupported vector value: ${typeof value}`);
}

/** 행 식별자를 비교 가능한 문자열로(int·bigint·uuid·text 모두). */
export function idText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return String(value);
}
