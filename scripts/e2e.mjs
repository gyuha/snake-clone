/**
 * E2E (loop.md C9, PRD §21.3 M4 제품 흐름 · §17.1 E2E):
 * api + game-server + web preview를 기동하고 Playwright(chromium)로
 * 랜딩 → 게스트 → 로비(닉네임/스킨) → Quick Play → HUD/리더보드 →
 * 사망 → 결과 → 다시하기 재입장까지 실제 브라우저로 검증한다.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const API_PORT = '8199';
const GAME_PORT = '2299';
const WEB_PORT = '4399';
const API = `http://127.0.0.1:${API_PORT}`;

const children = [];
let output = '';

function spawnService(name, args, env) {
  const child = spawn('pnpm', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += `[${name}] ${d}`));
  child.stderr.on('data', (d) => (output += `[${name}!] ${d}`));
  children.push(child);
}

let browser = null;
async function shutdown(code, message) {
  if (message) console.log(message);
  if (code !== 0) {
    console.error('--- service output (tail) ---');
    console.error(output.slice(-3000));
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

async function waitForOutput(marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!output.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for "${marker}"`);
    await delay(150);
  }
}

try {
  // ── 빌드 + 서비스 기동 ────────────────────────────────────────────────
  console.log('[e2e] building web...');
  await new Promise((resolve, reject) => {
    const b = spawn('pnpm', ['--filter', '@serpent/web', 'build'], { stdio: 'inherit' });
    b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('web build failed'))));
  });

  spawnService('api', ['--filter', '@serpent/api', 'start'], {
    API_PORT,
    SERPENT_GAME_ENDPOINT: `ws://127.0.0.1:${GAME_PORT}`,
  });
  spawnService('game', ['--filter', '@serpent/game-server', 'start'], {
    PORT: GAME_PORT,
    SERPENT_REQUIRE_JOIN_TOKEN: '1',
    SERPENT_API_URL: API,
    SERPENT_ALLOW_ROOM_OPTIONS: '1',
    SERPENT_ARENA_SIZE: '2000', // 빠른 사망 유도 (최대 ~10초 주행)
  });
  spawnService(
    'web',
    ['--filter', '@serpent/web', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', WEB_PORT, '--strictPort'],
    {},
  );

  await waitForOutput('[api] listening');
  await waitForOutput('[game-server] listening');
  await waitForOutput(`${WEB_PORT}`);
  console.log('[e2e] services up');

  // ── 브라우저 플로우 ──────────────────────────────────────────────────
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20_000);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    // 헤드리스 GPU의 성능 경고(GL Driver Message)는 무해 — 오류만 수집
    if (m.type() === 'error' && !m.text().includes('GL Driver Message')) {
      consoleErrors.push(`[console.error] ${m.text()}`);
    }
  });
  globalThis.__page = page;
  globalThis.__consoleErrors = consoleErrors;

  await page.goto(`http://127.0.0.1:${WEB_PORT}/?api=${encodeURIComponent(API)}`);

  // S-01 랜딩 → Play
  await page.getByTestId('landing').waitFor();
  await page.getByTestId('play-button').click();
  console.log('[e2e] landing → lobby');

  // S-02 로비: 닉네임 + 스킨 선택 → 입장
  await page.getByTestId('nickname-input').fill('E2E뱀');
  await page.getByTestId('skin-3').click();
  await page.getByTestId('enter-button').click();
  console.log('[e2e] lobby → matching');

  // S-04 게임: HUD/리더보드 표시 (매칭 + welcome까지)
  await page.getByTestId('hud-score').waitFor();
  await page.waitForSelector('canvas');
  await page.getByTestId('lb-row-0').waitFor(); // 봇 포함 리더보드 엔트리
  const selfRank = await page.getByTestId('self-rank').textContent();
  if (!selfRank || !selfRank.includes('내 순위')) throw new Error(`self rank missing: ${selfRank}`);
  console.log(`[e2e] in game — leaderboard ok (${selfRank.trim()})`);

  // 사망 유도: 오른쪽으로 직진 (아레나 2000 → 수 초 내 경계)
  await page.mouse.click(640, 400); // 캔버스 포커스
  await page.keyboard.down('d');
  await page.getByTestId('result').waitFor({ timeout: 45_000 });
  await page.keyboard.up('d');
  const resultScore = await page.getByTestId('result-score').textContent();
  console.log(`[e2e] died — result shown (${resultScore?.trim()})`);

  // S-05 결과 → 다시하기 1클릭 재입장 (US-05)
  await page.getByTestId('retry-button').click();
  await page.getByTestId('result').waitFor({ state: 'detached' });
  await page.getByTestId('hud-score').waitFor();
  console.log('[e2e] retry → respawned');

  if (consoleErrors.length > 0) {
    throw new Error(`page errors: ${consoleErrors.join(' | ')}`);
  }

  await shutdown(0, '[e2e] PASS: landing → guest → lobby → play → leaderboard → death → result → retry');
} catch (err) {
  try {
    const page = globalThis.__page;
    if (page) {
      const status = await page.getByTestId('status').textContent({ timeout: 1000 }).catch(() => null);
      console.error(`[e2e] status text: ${status}`);
      console.error(`[e2e] page errors: ${(globalThis.__consoleErrors ?? []).slice(0, 10).join('\n')}`);
    }
  } catch {
    /* ignore */
  }
  await shutdown(1, `[e2e] FAIL: ${err?.message ?? err}`);
}
