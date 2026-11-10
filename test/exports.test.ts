// AC-10 — package.json 배포 형태와 CJS(require)·ESM(import) 양쪽 소비
//   패키지 자기 참조('pgvector-doctor')로 빌드된 dist 를 별도 Node 프로세스에서 불러 본다.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const API = ['check', 'measure', 'sweep', 'recommend', 'createFixture', 'parseTemplate', 'TemplateError'];

function node(args: string[]) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe('package shape', () => {
  it('exports has types/import/require/default, bin and engines are set', () => {
    expect(pkg.type).toBe('module');
    expect(Object.keys(pkg.exports['.'])).toEqual(['types', 'import', 'require', 'default']);
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts');
    expect(pkg.bin).toEqual({ 'pgvector-doctor': 'dist/cli.js' });
    expect(pkg.engines.node).toBe('>=22.12');
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
    // 버전은 ^ 없이 고정
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      for (const v of Object.values(deps) as string[]) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('cli.js has a shebang', () => {
    expect(readFileSync(new URL('../dist/cli.js', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('require() (CommonJS consumer) exposes the API', () => {
    const out = node(['-e', `const m = require('pgvector-doctor'); console.log(JSON.stringify(${JSON.stringify(API)}.map((k) => typeof m[k])))`]);
    expect(JSON.parse(out)).toEqual(['function', 'function', 'function', 'function', 'function', 'function', 'function']);
  });

  it('import (ESM consumer) exposes the API', () => {
    const out = node([
      '--input-type=module',
      '-e',
      `import * as m from 'pgvector-doctor'; console.log(JSON.stringify(${JSON.stringify(API)}.map((k) => typeof m[k])))`,
    ]);
    expect(JSON.parse(out)).toEqual(['function', 'function', 'function', 'function', 'function', 'function', 'function']);
  });

  it('the library entry never imports PGlite (demo-only, lazy) and has no top-level await', () => {
    const dist = new URL('../dist/', import.meta.url);
    const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const src = readFileSync(new URL(f, dist), 'utf8');
      if (f === 'demo.js') {
        // demo 안에서만, 그것도 동적 import 로
        expect(src).not.toMatch(/^import .*@electric-sql\/pglite/m);
        continue;
      }
      expect(src, f).not.toContain('@electric-sql/pglite');
      expect(src, f).not.toMatch(/^await /m);
    }
    expect(readFileSync(new URL('index.js', dist), 'utf8')).not.toMatch(/demo\.js|cli\.js/);
  });

  it('bin prints the package version', () => {
    expect(node(['dist/cli.js', '--version'])).toBe(pkg.version);
  });
});
