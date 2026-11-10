# Changelog

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [SemVer](https://semver.org/lang/ko/)를 따릅니다.

## [0.1.0] - 2026-11-11

첫 버전.

### Added
- `demo`: 서버 없이 프로세스 안 PGlite(연습용 목 모드)로 세 장면(가짜 만점 차단, 작은 필터 값 recall 붕괴, 가장 싼 설정 추천)을 보여 줍니다.
- `check`: pgvector 버전, 벡터 인덱스와 연산자 클래스, 현재 설정에서 인덱스 사용 여부, `LIMIT > ef_search` 를 진단합니다.
- `measure`: 내 검색 SQL 의 recall@k, LIMIT 미달률, 인덱스 사용 비율, 읽은 버퍼 수, p50/p95 지연을 필터 값(그룹)별로 잽니다. `--min-recall` 게이트(종료 코드 1).
- `sweep`: `ef_search` x `iterative_scan` 격자를 재서 목표 recall 을 가장 싸게(읽은 버퍼 최소) 맞추는 설정과 붙여 넣을 `SET LOCAL` 문을 추천합니다.
- EXPLAIN 으로 카탈로그상 HNSW/IVFFlat 인덱스 사용 여부를 판정해 순차 스캔·btree 스캔이 만든 가짜 recall 1.0 을 집계에서 뺍니다.
- `--format table|json|md`, `--out`. 모든 측정은 `BEGIN READ ONLY` + `SET LOCAL`.
- 라이브러리 API(`connect`, `measure`, `sweep`, `check`, `recommend`, `createFixture` 등), ESM 과 CommonJS(`require`) 모두 지원.

### 알려진 한계
- `demo` 끝의 "Try it on your database" 안내는 npm 게시 전이라 `npx pgvector-doctor` 대신 `node dist/cli.js` 로 바꿔 쳐야 하고, 안내된 measure 줄은 `--force-index` 없이 `--min-recall` 을 씁니다.
- 예시 출력의 recall 소수 셋째 자리와 buffers 값은 HNSW 난수 때문에 실행마다 조금 달라집니다.
