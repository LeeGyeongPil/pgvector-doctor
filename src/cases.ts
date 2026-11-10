// 질의 사례 읽기 — 어떤 벡터·필터 값으로 템플릿을 돌려 볼지.
//   열/필드 규칙: vector → $1, p2…pN → $2…$N, self_id(선택) → 자기 행 제외, group(선택) → 분해 기준.
import { type Queryable, withReadOnly, toVectorText, idText } from './db.js';
import { type ParsedTemplate, UsageError, maskSql, stripTrailing } from './template.js';

export interface QueryCase {
  /** pgvector 텍스트 표현 '[..]' */
  vector: string;
  /** $2..$N 값. 인덱스 0 = $2. LIMIT $n 자리는 측정할 때 k 로 채운다. */
  params: unknown[];
  /** 질의 벡터를 테이블에서 뽑았다면 그 행 id — 정확·근사 결과 둘 다에서 뺀다. */
  selfId?: string;
  /** 분해 기준 이름(없으면 p2…pN 값) */
  group: string;
}

/** 사례 한 줄(SQL 행 또는 JSONL 객체)을 QueryCase 로. */
export function toCase(row: Record<string, unknown>, template: ParsedTemplate, where: string): QueryCase {
  if (!('vector' in row) || row.vector === null || row.vector === undefined) {
    throw new UsageError(`${where}: missing "vector" (it fills $1)`);
  }
  let vector: string;
  try {
    vector = toVectorText(row.vector);
  } catch (err) {
    throw new UsageError(`${where}: ${(err as Error).message}`);
  }
  const params: unknown[] = [];
  for (let n = 2; n <= template.maxParam; n++) {
    if (n === template.limitParam) {
      params.push(null); // 측정 때 k 로 채움
      continue;
    }
    const key = `p${n}`;
    if (!(key in row)) throw new UsageError(`${where}: missing "${key}" (template uses $${n})`);
    params.push(row[key]);
  }
  const selfRaw = row.self_id;
  const groupRaw = row.group;
  const fallbackGroup = params.filter((_, i) => i + 2 !== template.limitParam).map(idText).join(', ');
  const c: QueryCase = {
    vector,
    params,
    group: groupRaw !== undefined && groupRaw !== null ? String(groupRaw) : fallbackGroup || 'all',
  };
  if (selfRaw !== undefined && selfRaw !== null) c.selfId = idText(selfRaw);
  return c;
}

/** `--cases-sql` — 사례를 고르는 SELECT 를 읽기 전용 트랜잭션에서 실행한다. */
export async function casesFromSql(
  db: Queryable,
  casesSql: string,
  template: ParsedTemplate,
  maxCases: number,
  timeout = '30s',
): Promise<QueryCase[]> {
  const sql = stripTrailing(casesSql);
  if (sql === '') throw new UsageError('cases SQL is empty');
  if (maskSql(sql).includes(';')) throw new UsageError('cases SQL must be a single statement');
  // 빈 파라미터 배열 = 확장 프로토콜 → DB 도 문장 하나만 받는다(READ ONLY 를 벗어나는 '; COMMIT; …' 차단).
  const rows = await withReadOnly(db, [['statement_timeout', timeout]], async () => (await db.query(sql, [])).rows);
  return limitCases(
    rows.map((r, i) => toCase(r, template, `cases row ${i + 1}`)),
    maxCases,
  );
}

/** `--cases file.jsonl` — 한 줄에 JSON 객체 하나. 빈 줄·# 주석 줄은 건너뛴다. */
export function casesFromJsonl(text: string, template: ParsedTemplate, maxCases: number): QueryCase[] {
  const out: QueryCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new UsageError(`cases line ${i + 1}: not valid JSON`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new UsageError(`cases line ${i + 1}: expected a JSON object`);
    }
    out.push(toCase(obj as Record<string, unknown>, template, `cases line ${i + 1}`));
  }
  return limitCases(out, maxCases);
}

function limitCases(cases: QueryCase[], maxCases: number): QueryCase[] {
  if (cases.length === 0) throw new UsageError('no query cases (cases SQL/JSONL returned 0 rows)');
  // 앞에서부터 상한만큼. 무작위 추출은 사례 SQL 쪽(ORDER BY md5(id::text) 등)에서 결정적으로 한다.
  return cases.slice(0, maxCases);
}

/** 사례 + k → 템플릿에 넘길 파라미터 배열($1..$N). */
export function bindParams(c: QueryCase, template: ParsedTemplate, k: number): unknown[] {
  const params: unknown[] = [c.vector, ...c.params];
  if (template.limitParam !== null) params[template.limitParam - 1] = k;
  return params;
}
