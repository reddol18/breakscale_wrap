// 녹화용 페이지 개발 서버. 원본(vendor/breakscale)에 설치된 vite·react를 그대로 쓰고,
// 원본 폴더에는 아무 파일도 만들지 않는다.
// 실행: node lab/viz/serve.mjs  ->  http://127.0.0.1:4180/
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lab = resolve(here, '..', '..');
const vendor = join(lab, 'vendor', 'breakscale');
const nm = join(vendor, 'node_modules');
const req = createRequire(join(vendor, 'package.json'));
const load = async (id) => import(pathToFileURL(req.resolve(id)).href);

const vite = await load('vite');
const react = (await load('@vitejs/plugin-react')).default;

const server = await vite.createServer({
  configFile: false,
  root: here,
  // 폰트(/fonts/...) 등 원본 정적 파일은 원본 public/에서 그대로 제공한다.
  publicDir: join(vendor, 'public'),
  plugins: [react()],
  resolve: {
    alias: [
      // 우리 파일에서 쓰는 react는 원본이 쓰는 것과 같은 사본이어야 한다(훅 충돌 방지).
      { find: /^react-dom(\/.*)?$/, replacement: join(nm, 'react-dom') + '$1' },
      { find: /^react(\/.*)?$/, replacement: join(nm, 'react') + '$1' },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 4180,
    strictPort: true,
    fs: { allow: [lab] },
  },
  clearScreen: false,
});
await server.listen();
server.printUrls();
