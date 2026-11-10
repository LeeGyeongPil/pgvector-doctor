// 라이브러리 진입점 — 앱 테스트·스크립트에서 pg.Client(또는 PGlite)를 넘겨 그대로 쓴다.
// 주의: 여기서는 top-level await 를 쓰지 않는다(CommonJS 의 require(esm) 이 동작해야 하므로).
//       PGlite 는 demo 에서만 늦게 불러오므로 이 파일을 import 해도 로드되지 않는다.
export { check } from './check.js';
export type { CheckOptions, CheckResult, Diagnostic, DiagnosticCode } from './check.js';
export { measure, configLabel, configSettings, EXACT_SETTINGS, FORCE_INDEX_SETTINGS } from './measure.js';
export type { MeasureOptions, MeasureResult, ConfigResult, HnswConfig, IterativeScan, EffectiveSettings } from './measure.js';
export { sweep, buildGrid, setLocalStatements, parseIntList, parseIterativeList } from './sweep.js';
export type { SweepOptions, SweepResult, GridOptions } from './sweep.js';
export { recommend } from './recommend.js';
export type { RecommendOptions, Recommendation, TargetScope } from './recommend.js';
export { createFixture, fixtureRows, fixtureHash, mulberry32 } from './fixture.js';
export type { FixtureOptions, FixtureInfo, FixtureRow } from './fixture.js';
export { parseTemplate, TemplateError, UsageError } from './template.js';
export type { ParsedTemplate } from './template.js';
export { casesFromSql, casesFromJsonl } from './cases.js';
export type { QueryCase } from './cases.js';
export { scoreCase, aggregate, aggregateByGroup, percentile } from './metrics.js';
export type { Aggregate, GroupAggregate, CaseRun, CaseScore } from './metrics.js';
export { analyzePlan } from './plan.js';
export type { PlanVerdict } from './plan.js';
export { withReadOnly, connect, pgliteQueryable, ConnectionError } from './db.js';
export type { Queryable, Setting, PGliteLike } from './db.js';
export { renderMeasure, renderCheck, reportJson, VERSION } from './report.js';
export type { Format, GateResult } from './report.js';
