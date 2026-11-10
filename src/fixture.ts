// 시드 고정 합성 데이터 — 연습용 목 모드와 테스트가 쓴다.
//   큰 테넌트 1개(0번, 전체의 bigShare) + 작은 테넌트 여러 개(1..smallTenants, 나머지를 고르게 나눔).
//   필터 선택도가 1% 인 작은 테넌트에서 HNSW 후처리 필터가 결과를 잃는 모습을 재현하기 위한 분포다.
import { createHash } from 'node:crypto';
import type { Queryable } from './db.js';

export interface FixtureOptions {
  /** PRNG 시드(기본 42) */
  seed?: number;
  /** 행 수(기본 5000) */
  rows?: number;
  /** 차원(기본 32) */
  dim?: number;
  /** 큰 테넌트 비율(기본 0.5) */
  bigShare?: number;
  /** 작은 테넌트 수(기본 50 → 각 1%) */
  smallTenants?: number;
  /** 테이블 이름(영문·숫자·_ 만, 기본 items) */
  table?: string;
  /** HNSW 연산자 클래스(기본 vector_cosine_ops) */
  opclass?: 'vector_cosine_ops' | 'vector_l2_ops' | 'vector_ip_ops';
  /** tenant_id btree 인덱스도 만들지(기본 true — 실제 멀티테넌트 테이블처럼) */
  tenantIndex?: boolean;
}

export interface FixtureRow {
  id: number;
  tenantId: number;
  /** pgvector 텍스트 표현 '[..]' (소수 4자리, 로캘 무관 toFixed) */
  embedding: string;
}

export interface FixtureInfo {
  table: string;
  rows: number;
  dim: number;
  bigTenant: number;
  smallTenants: number;
  opclass: string;
  /** 생성한 행 전체의 sha256 — 같은 시드면 같다 */
  sha256: string;
}

/** mulberry32 — 작고 빠른 시드 PRNG. 같은 시드면 어느 환경에서도 같은 수열. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 행 생성(순수 함수). DB 없이 결정성을 테스트할 수 있다. */
export function fixtureRows(opts: FixtureOptions = {}): FixtureRow[] {
  const seed = opts.seed ?? 42;
  const n = opts.rows ?? 5000;
  const dim = opts.dim ?? 32;
  const bigShare = opts.bigShare ?? 0.5;
  const small = opts.smallTenants ?? 50;
  const rnd = mulberry32(seed);
  const rows: FixtureRow[] = [];
  let smallSeen = 0;
  for (let i = 0; i < n; i++) {
    // 테넌트 배정: 비율이 정확히 맞도록 누적 방식으로(큰 테넌트 = 0, 작은 테넌트 = 1..small 순환).
    const bigSoFar = i - smallSeen;
    const isBig = bigSoFar < Math.round((i + 1) * bigShare);
    const tenantId = isBig || small === 0 ? 0 : 1 + (smallSeen++ % small);
    const values: string[] = [];
    for (let d = 0; d < dim; d++) values.push((rnd() * 2 - 1).toFixed(4));
    rows.push({ id: i + 1, tenantId, embedding: `[${values.join(',')}]` });
  }
  return rows;
}

export function fixtureHash(rows: readonly FixtureRow[]): string {
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.id}\t${r.tenantId}\t${r.embedding}\n`);
  return h.digest('hex');
}

/**
 * 테이블을 만들고 행을 넣은 뒤 HNSW(+ tenant btree) 인덱스와 ANALYZE 까지.
 * 연습용·테스트용이다 — 실제 DB 에는 쓰지 않는다(이 도구의 측정 명령은 읽기 전용).
 */
export async function createFixture(db: Queryable, opts: FixtureOptions = {}): Promise<FixtureInfo> {
  const table = opts.table ?? 'items';
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
  const dim = opts.dim ?? 32;
  const opclass = opts.opclass ?? 'vector_cosine_ops';
  // SQL 에 이어 붙이는 값은 모두 모양을 확인한다(테이블 이름과 같은 이유 — 주입 방지).
  if (!Number.isInteger(dim) || dim < 1 || dim > 16000) throw new Error(`invalid dim: ${dim}`);
  if (!['vector_cosine_ops', 'vector_l2_ops', 'vector_ip_ops'].includes(opclass)) throw new Error(`invalid opclass: ${opclass}`);
  const rows = fixtureRows(opts);

  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query(`DROP TABLE IF EXISTS ${table}`);
  await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, tenant_id integer NOT NULL, embedding vector(${dim}) NOT NULL)`);
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows
      .slice(i, i + BATCH)
      .map((r) => `(${r.id}, ${r.tenantId}, '${r.embedding}')`)
      .join(',');
    await db.query(`INSERT INTO ${table} (id, tenant_id, embedding) VALUES ${values}`);
  }
  await db.query(`CREATE INDEX ${table}_embedding_idx ON ${table} USING hnsw (embedding ${opclass})`);
  if (opts.tenantIndex ?? true) await db.query(`CREATE INDEX ${table}_tenant_id_idx ON ${table} (tenant_id)`);
  await db.query(`ANALYZE ${table}`);

  return {
    table,
    rows: rows.length,
    dim,
    bigTenant: 0,
    smallTenants: opts.smallTenants ?? 50,
    opclass,
    sha256: fixtureHash(rows),
  };
}
