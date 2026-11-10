// 배포 형태 검사 — npm pack 결과 파일 목록 + 새 임시 프로젝트에 설치해 bin·require·import 확인.
//   `npm run check:pack` (build 뒤 실행). 성공하면 마지막 줄에 PACK_OK.
//   주의: npm pack 은 lifecycle 로그가 stdout 에 섞일 수 있어 JSON 배열 부분만 잘라 파싱한다.
//         실행 중인 npm(npm_execpath)을 그대로 써서 CI 최저 Node 의 번들 npm 으로도 같은 경로를 탄다.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'pgvd-pack-'));

function fail(msg) {
  console.error(`check-pack: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

/** 지금 이 스크립트를 띄운 npm 으로 실행(없으면 PATH 의 npm). */
function npm(args, cwd) {
  const execpath = process.env.npm_execpath;
  const r = execpath
    ? spawnSync(process.execPath, [execpath, ...args], { cwd, encoding: 'utf8', timeout: 300_000 })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', timeout: 300_000, shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`npm ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

/** stdout 에서 JSON 배열 부분만: 줄 머리의 '[' 부터 마지막 ']' 까지. */
function parsePackJson(stdout) {
  const start = stdout.search(/^\[/m);
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end < start) fail(`no JSON array in npm pack output:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

try {
  // 1) pack — 빌드는 check:pack 스크립트가 먼저 했으므로 lifecycle 스크립트는 건너뛴다.
  const packed = parsePackJson(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', work], root))[0];
  const files = packed.files.map((f) => f.path).sort();
  const required = ['package.json', 'LICENSE', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts'];
  if (existsSync(join(root, 'README.md'))) required.push('README.md');
  for (const f of required) if (!files.includes(f)) fail(`missing from package: ${f}`);
  const forbidden = files.filter((f) => /^(test|src|scripts|examples|probe|node_modules|\.github)\//.test(f) || /vitest|tsconfig|\.env/.test(f));
  if (forbidden.length > 0) fail(`should not be packed: ${forbidden.join(', ')}`);
  const tarball = join(work, packed.filename);

  // 2) 새 임시 프로젝트(CommonJS)에 설치 — 실제 소비자처럼.
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }));
  npm(['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline'], consumer);

  // 3) bin --version
  const installed = join(consumer, 'node_modules', 'pgvector-doctor');
  const binVersion =
    process.platform === 'win32'
      ? run(process.execPath, [join(installed, 'dist', 'cli.js'), '--version'], consumer)
      : run(join(consumer, 'node_modules', '.bin', 'pgvector-doctor'), ['--version'], consumer);
  if (binVersion !== pkg.version) fail(`bin --version printed ${binVersion}, expected ${pkg.version}`);

  // 4) require (CJS) 와 import (ESM) 둘 다
  const api = ['check', 'measure', 'sweep', 'recommend', 'createFixture'];
  const cjs = run(process.execPath, ['-e', `const m = require('pgvector-doctor'); console.log(${JSON.stringify(api)}.every((k) => typeof m[k] === 'function'))`], consumer);
  if (cjs !== 'true') fail('require("pgvector-doctor") is missing API functions');
  const esm = run(
    process.execPath,
    ['--input-type=module', '-e', `import * as m from 'pgvector-doctor'; console.log(${JSON.stringify(api)}.every((k) => typeof m[k] === 'function'))`],
    consumer,
  );
  if (esm !== 'true') fail('import "pgvector-doctor" is missing API functions');

  // 5) 설치본으로 demo — 런타임 의존성(PGlite·pgvector 확장)이 dependencies 에 제대로 들어갔는지
  const demo = run(process.execPath, [join(installed, 'dist', 'cli.js'), 'demo'], consumer);
  if (!/^Recommended: /m.test(demo) || !/^SET LOCAL hnsw\./m.test(demo)) fail(`demo from the installed package did not finish:\n${demo}`);

  console.log(`${packed.filename}: ${files.length} files, ${packed.size} bytes packed`);
  console.log(`files: ${files.join(', ')}`);
  console.log(`bin --version ${binVersion} · require ok · import ok · demo ok · node ${process.version}`);
  console.log('PACK_OK');
} catch (err) {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
