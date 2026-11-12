# Changelog

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [SemVer](https://semver.org/lang/ko/)를 따릅니다.

## [0.2.0] - 2026-11-13

### Added
- 화면 언어 선택(영어·한국어): `--lang en|ko` > `PGVECTOR_DOCTOR_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG` 순으로 정하고, 한국어(`ko…`)가 아니면 영어입니다. 도움말, 사용법 오류, 표·Markdown 보고서, `demo` 안내, 진행 표시, 게이트 `FAIL` 사유가 선택한 언어로 나옵니다. `--lang` 값이 `en`·`ko` 가 아니면 종료 코드 2 입니다.
- 한글 열이 있는 표를 한글 2칸 기준으로 정렬합니다.
- 라이브러리: 패키지가 내보내는 `renderMeasure`·`renderCheck` 에 선택 인자 `lang`(기본 `'en'`)을 추가했습니다. `UsageError` 는 선택 `code`·`params` 를, `ConnectionError` 는 `detail` 을 갖습니다. `message` 는 그대로 영어입니다.

### Changed
- 한국어 로캘(`LANG=ko_KR.UTF-8` 등)에서는 사람이 읽는 출력이 한국어로 바뀝니다. 출력 문구를 `grep` 하는 스크립트는 `--lang en` 을 붙이거나 `PGVECTOR_DOCTOR_LANG=en` 을 설정하십시오. `PASS`·`FAIL`·`ERROR`·`WARN`·`INFO`·`OK` 태그, 규칙 ID(`index-not-used`, `recall-below-min`, `no-config-meets-target` 등), `SET LOCAL` 문, Postgres·드라이버 오류 원문은 번역하지 않습니다.
- `--format json` 출력은 언어와 관계없이 바이트 단위로 같습니다(측정한 지연(latency) 값은 실행마다 달라지므로 제외. 진단·게이트·추천 사유 문장은 영어 그대로).

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
