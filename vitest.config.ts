import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite 기동 + 5,000행 픽스처 + HNSW 생성이 파일마다 몇 초 걸린다. 느린 CI 러너를 위해 넉넉히.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 파일마다 WASM Postgres 를 띄우므로 동시 실행 수를 제한해 메모리를 아낀다.
    maxWorkers: 4,
  },
});
