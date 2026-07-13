import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  // 워크스페이스 패키지는 TS 소스를 export하므로 번들에 포함한다.
  noExternal: [/^@serpent\//],
});
