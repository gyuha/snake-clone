import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // colyseus가 끌어오는 @pm2/io가 fork pool의 process.send IPC를 오염시키므로
    // worker_threads 풀을 사용한다 (threads에는 process.send가 없음).
    pool: 'threads',
    // 테스트 서버가 고정 포트를 사용하므로 파일 단위 병렬 실행을 금지한다.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
