// 카탈로그 조회 — pgvector 버전, 벡터 인덱스(hnsw/ivfflat) 이름·연산자 클래스, 현재 설정.
import type { Queryable } from './db.js';

export interface VectorIndex {
  schema: string;
  table: string;
  index: string;
  method: 'hnsw' | 'ivfflat';
  opclass: string;
  /** 식 인덱스면 null */
  column: string | null;
}

/** `CREATE EXTENSION vector` 가 안 돼 있으면 null. */
export async function pgvectorVersion(db: Queryable): Promise<string | null> {
  const r = await db.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const v = r.rows[0]?.extversion;
  return typeof v === 'string' ? v : null;
}

/** DB 안의 모든 hnsw/ivfflat 인덱스. EXPLAIN 판정의 '벡터 인덱스 이름' 목록으로 쓴다. */
export async function vectorIndexes(db: Queryable): Promise<VectorIndex[]> {
  const r = await db.query(`
    SELECT n.nspname AS schema, t.relname AS "table", i.relname AS index,
           am.amname AS method, opc.opcname AS opclass, a.attname AS column
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_opclass opc ON opc.oid = x.indclass[0]
    LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0] AND x.indkey[0] <> 0
    WHERE am.amname IN ('hnsw', 'ivfflat')
    ORDER BY n.nspname, t.relname, i.relname`);
  return r.rows.map((row) => ({
    schema: String(row.schema),
    table: String(row.table),
    index: String(row.index),
    method: row.method === 'ivfflat' ? 'ivfflat' : 'hnsw',
    opclass: String(row.opclass),
    column: row.column === null || row.column === undefined ? null : String(row.column),
  }));
}

/** `current_setting(name, true)` — 확장이 아직 로드되지 않았으면 null. */
export async function currentSetting(db: Queryable, name: string): Promise<string | null> {
  const r = await db.query('SELECT current_setting($1, true) AS v', [name]);
  const v = r.rows[0]?.v;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** '0.8.7' 같은 버전 문자열 비교. a<b 면 음수. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** iterative scan(hnsw.iterative_scan)은 pgvector 0.8.0 부터. */
export function supportsIterativeScan(version: string | null): boolean {
  return version !== null && compareVersions(version, '0.8.0') >= 0;
}
