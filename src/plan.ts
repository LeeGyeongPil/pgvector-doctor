// EXPLAIN (FORMAT JSON) 트리 판정 — "정말 벡터 인덱스를 탔나?"
// 'Index Scan' 글자만 보면 tenant_id btree 인덱스 스캔도 인덱스 사용으로 오인한다.
// 그래서 카탈로그에서 읽은 hnsw/ivfflat 인덱스 이름과 노드의 'Index Name' 을 맞춰 본다.

export interface PlanVerdict {
  /** 카탈로그상 벡터 인덱스 이름의 스캔 노드가 하나라도 있으면 true */
  vectorIndexUsed: boolean;
  /** 읽은 버퍼 합(공유 hit + read). EXPLAIN 에 버퍼 정보가 없으면 null */
  buffers: number | null;
  /** 사람이 읽을 스캔 요약 — 예: 'Seq Scan on items', 'Index Scan using items_tenant_id_idx' */
  scans: string[];
  /** 플랜에 나온 테이블 이름들 */
  relations: string[];
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** EXPLAIN 결과 행에서 최상위 Plan 객체를 꺼낸다(pg·PGlite 모두 'QUERY PLAN' 열에 JSON 배열). */
export function planRoot(rows: Record<string, unknown>[]): PlanNode {
  const cell = rows[0]?.['QUERY PLAN'];
  const parsed: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const plan = (first as { Plan?: PlanNode } | undefined)?.Plan;
  if (!plan) throw new Error('unexpected EXPLAIN output (no Plan)');
  return plan;
}

export function analyzePlan(root: PlanNode, vectorIndexNames: ReadonlySet<string>): PlanVerdict {
  const scans: string[] = [];
  const relations = new Set<string>();
  let vectorIndexUsed = false;

  // 트리를 위에서 아래로 훑는다(CTE·서브쿼리·Append 아래까지).
  const queue: PlanNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const type = String(node['Node Type'] ?? '');
    const indexName = typeof node['Index Name'] === 'string' ? (node['Index Name'] as string) : null;
    const relation = typeof node['Relation Name'] === 'string' ? (node['Relation Name'] as string) : null;
    if (relation) relations.add(relation);

    if (indexName) {
      const isVector = vectorIndexNames.has(indexName);
      if (isVector) vectorIndexUsed = true;
      scans.push(`${type} using ${indexName}${isVector ? '' : ' (not a vector index)'}`);
    } else if (/Scan$/.test(type) && relation) {
      scans.push(`${type} on ${relation}`);
    }
    for (const child of node.Plans ?? []) queue.push(child);
  }

  // 최상위 노드의 버퍼 수는 자식 노드를 모두 포함한 누적값이다.
  const hit = root['Shared Hit Blocks'];
  const read = root['Shared Read Blocks'];
  const buffers = typeof hit === 'number' && typeof read === 'number' ? hit + read : null;

  return { vectorIndexUsed, buffers, scans, relations: [...relations].sort() };
}

/** 벡터 인덱스를 안 탔을 때 사유 문구 — 'planner chose Seq Scan on items' 등. */
export function notIndexedReason(v: PlanVerdict): string {
  if (v.scans.length === 0) return 'planner chose a plan without a scan node';
  return `planner chose ${v.scans.join(' + ')}`;
}
