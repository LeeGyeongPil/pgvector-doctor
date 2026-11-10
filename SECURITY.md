# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

pgvector-doctor 는 내 Postgres 에 접속하는 도구입니다. 모든 측정은 `BEGIN READ ONLY` 트랜잭션과 `SET LOCAL` 로만 실행하고, 접속 문자열은 `--url` 또는 `DATABASE_URL` 로만 받으며 어디에도 저장하지 않습니다. 읽기 전용 우회·SQL 주입 가능성을 발견하면 위 경로로 알려 주세요. / pgvector-doctor connects to your Postgres. Every measurement runs in `BEGIN READ ONLY` with `SET LOCAL`; the connection string comes only from `--url` or `DATABASE_URL` and is never stored. Please report any read-only bypass or injection path privately.

읽기 전용 보장 / Read-only guarantee: 모든 SQL 을 확장 질의 프로토콜로 보내 DB 가 한 번에 문장 하나만 실행하므로 `; COMMIT; …` 로 읽기 전용 트랜잭션을 벗어날 수 없습니다. 템플릿 검사기는 `E''` 문자열·달러 인용·중첩 주석을 PostgreSQL 과 같게 읽어 그런 템플릿을 미리 거부합니다(종료 코드 2). / Every statement is sent over the extended query protocol, so the server runs one statement at a time and `; COMMIT; …` cannot leave the read-only transaction. The template checker reads escape strings, dollar quoting and nested comments like PostgreSQL and rejects such templates up front (exit code 2).
