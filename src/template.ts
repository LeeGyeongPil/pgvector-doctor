// SQL 템플릿 검사 — 사용자가 넣은 검색 SQL 을 그대로 쓰되, 측정에 필요한 규칙만 확인한다.
//   규칙: 첫 열 = 행 식별자, $1 = 질의 벡터, LIMIT 필수(숫자 또는 $n), 문장은 하나.

import { t, type MessageKey, type Params } from './i18n.js';

/**
 * 사용법 오류(인자·템플릿·사례 형식) — CLI 에서 종료 코드 2.
 * `message` 는 항상 영어. `code`·`params` 가 있으면 CLI 가 표시할 때 고른 언어로 다시 만든다.
 */
export class UsageError extends Error {
  override name = 'UsageError';
  /** i18n 메시지 키(선택) */
  readonly code?: MessageKey;
  readonly params?: Params;
  constructor(message: string, code?: MessageKey, params?: Params) {
    super(message);
    if (code !== undefined) this.code = code;
    if (params !== undefined) this.params = params;
  }
}

/** 템플릿이 규칙에 맞지 않을 때. */
export class TemplateError extends UsageError {
  override name = 'TemplateError';
}

/** 영어 메시지를 사전에서 만들고 code·params 를 함께 붙인 UsageError. */
export function usageError(code: MessageKey, params: Params = {}): UsageError {
  return new UsageError(t('en', code, params), code, params);
}

function templateError(code: MessageKey, params: Params = {}): TemplateError {
  return new TemplateError(t('en', code, params), code, params);
}

/** 거리 연산자 → 짝이 맞는 연산자 클래스 접미사(vector_/halfvec_/sparsevec_ 공통). */
export const OPERATOR_OPCLASS: Readonly<Record<string, string>> = {
  '<->': 'l2_ops',
  '<#>': 'ip_ops',
  '<=>': 'cosine_ops',
  '<+>': 'l1_ops',
  '<~>': 'hamming_ops',
  '<%>': 'jaccard_ops',
};

export interface ParsedTemplate {
  /** 끝의 세미콜론을 뗀 실행용 SQL */
  sql: string;
  /** 템플릿이 쓰는 가장 큰 파라미터 번호($1..$N) */
  maxParam: number;
  /** LIMIT 이 숫자면 그 값, `$n` 이면 null */
  limit: number | null;
  /** LIMIT 이 `$n` 일 때 그 번호 */
  limitParam: number | null;
  /** 템플릿에 나온 거리 연산자들(등장 순) */
  operators: string[];
}

/** 식별자에 들어가는 글자(PostgreSQL: 글자·숫자·_·$). 이 뒤에 붙은 `$`·`E'` 는 식별자의 일부다. */
const IDENT_CHAR = /[\p{L}\p{N}_$]/u;

/** 달러 인용 여는 태그: `$$` 또는 `$이름$`(이름은 숫자로 시작하지 않는다 — `$1` 은 파라미터). */
const DOLLAR_TAG = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u;

/**
 * 문자열 리터럴·따옴표 식별자·주석을 공백으로 가린 사본을 만든다.
 * 그래야 `'a;b'` 안의 세미콜론이나 주석 속 `LIMIT` 을 잘못 읽지 않는다. 길이는 원문과 같다.
 *
 * PostgreSQL 어휘 규칙을 그대로 따른다(하나라도 다르면 "검사기는 문자열로, DB 는 코드로" 읽는 틈이 생긴다):
 *   '…'  ''  이스케이프          E'…'  백슬래시 이스케이프(\' \\)도 인정
 *   "…"  "" 이스케이프           $$…$$, $tag$…$tag$  달러 인용(안에는 이스케이프 없음)
 *   -- 줄 끝까지                 /* … *\/  중첩 가능(/* /* *\/ *\/ 가 주석 하나)
 * 이 검사는 친절한 오류를 위한 1차 방어선이다. 진짜 안전 장치는 db.ts 의 확장 프로토콜(문장 하나만 실행)이다.
 */
export function maskSql(sql: string): string {
  let out = '';
  let i = 0;
  // i..stop 구간을 공백으로 가리고 다음으로
  const hide = (stop: number) => {
    stop = Math.min(sql.length, stop);
    out += ' '.repeat(stop - i);
    i = stop;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    const prev = i > 0 ? sql[i - 1]! : '';
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      hide(end === -1 ? sql.length : end);
    } else if (c === '/' && next === '*') {
      // 중첩 주석: /* 마다 깊이 +1, */ 마다 -1, 0 이 되면 끝.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      hide(j);
    } else if ((c === 'E' || c === 'e') && next === "'" && !IDENT_CHAR.test(prev)) {
      // E'…' — 백슬래시 다음 글자는 무엇이든(따옴표 포함) 문자열 안이다.
      let j = i + 2;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      hide(j + 1);
    } else if (c === '$' && !IDENT_CHAR.test(prev) && DOLLAR_TAG.test(sql.slice(i))) {
      // $tag$ … $tag$ — 같은 태그가 다시 나올 때까지 전부 문자열.
      const tag = DOLLAR_TAG.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      hide(end === -1 ? sql.length : end + tag.length);
    } else if (c === "'" || c === '"') {
      // 같은 따옴표 두 개('')는 이스케이프다.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      hide(j + 1);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 끝의 세미콜론과 그 뒤 주석을 잘라 낸다(가린 사본 기준으로 잘라야 주석 속 글자에 속지 않는다). */
export function stripTrailing(raw: string): string {
  const trimmed = raw.trim();
  const end = maskSql(trimmed).replace(/[\s;]+$/, '').length;
  return trimmed.slice(0, end);
}

export function parseTemplate(raw: string): ParsedTemplate {
  const sql = stripTrailing(raw);
  if (sql === '') throw templateError('err.tpl-empty');
  const masked = maskSql(sql);

  if (masked.includes(';')) {
    throw templateError('err.tpl-multi');
  }

  const params = [...masked.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  if (!params.includes(1)) {
    throw templateError('err.tpl-no-param');
  }
  const maxParam = Math.max(...params);

  // 가장 마지막 LIMIT 을 결과 개수로 본다(MATERIALIZED CTE 재정렬 패턴도 마지막 LIMIT 이 바깥 개수).
  const limits = [...masked.matchAll(/\bLIMIT\s+(\d+|\$\d+)/gi)];
  const last = limits.at(-1);
  if (!last) {
    throw templateError('err.tpl-no-limit');
  }
  const token = last[1]!;
  const limit = token.startsWith('$') ? null : Number(token);
  const limitParam = token.startsWith('$') ? Number(token.slice(1)) : null;
  if (limit !== null && limit < 1) throw templateError('err.tpl-limit-min');
  if (limitParam === 1) throw templateError('err.tpl-limit-param');

  const operators = [...masked.matchAll(/<->|<#>|<=>|<\+>|<~>|<%>/g)].map((m) => m[0]);
  if (operators.length === 0) {
    throw templateError('err.tpl-no-operator');
  }

  return { sql, maxParam, limit, limitParam, operators };
}
