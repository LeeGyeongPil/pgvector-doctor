-- 검색 SQL 템플릿 — 앱이 실제로 보내는 쿼리를 그대로 둔다.
--   첫 열 = 행 식별자(정확·근사 결과 비교 기준)
--   $1    = 질의 벡터
--   $2…   = 필터 값(cases.sql 의 p2… 열이 채운다)
--   LIMIT = k (숫자. $n 이면 --k 로 준다)
SELECT id
FROM items
WHERE tenant_id = $2
ORDER BY embedding <=> $1
LIMIT 10;
