-- 질의 사례 — 어떤 벡터·필터 값으로 search.sql 을 돌려 볼지 고르는 SELECT 한 문장.
--   vector  → $1 (테이블의 벡터를 그대로 써도 된다)
--   p2      → $2 (여기서는 tenant_id)
--   self_id → 질의 벡터를 뽑은 행. 정확·근사 결과 둘 다에서 빼서 '자기 자신 1위'로 recall 이 부풀지 않게 한다
--   group   → 결과를 나눠 볼 이름(없으면 p2 값별로 나뉜다)
-- ORDER BY md5(id::text) 는 매번 같은 '무작위' 표본을 고르는 방법이다.
SELECT embedding AS vector,
       tenant_id AS p2,
       id        AS self_id,
       'tenant ' || tenant_id AS "group"
FROM items
ORDER BY md5(id::text)
LIMIT 50;
