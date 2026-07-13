import { defineConfig } from 'tsup';

/**
 * 워크스페이스 config 패키지는 TypeScript source를 export한다. API 컨테이너는
 * tsx가 아닌 plain Node로 dist/main.js를 실행하므로 반드시 번들에 포함해야 한다.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  noExternal: [/^@serpent\//],
});
