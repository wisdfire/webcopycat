/**
 * 확장프로그램 전체 흐름 테스트: 실제 Chromium에 확장프로그램을 로드 → 복사 실행 → 클립보드 확인.
 *
 * 실행: npm test  (최초 1회 npx playwright install chromium 필요)
 *      npm test -- <URL>  → 실제 사이트에서 복사 결과만 출력 (검증 없음, 사이트 규칙 점검용)
 *
 * 자동화 환경에서는 사용자 클릭이 없어 activeTab 권한이 생기지 않으므로,
 * 임시 폴더에 확장프로그램을 복사하고 manifest에 host_permissions를 추가한 테스트용 사본을 로드한다.
 * 그 뒤 서비스 워커에서 copyArticle(tab)을 직접 호출한다 (툴바 클릭과 같은 함수).
 */
import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;

// 1) 테스트용 확장프로그램 사본 만들기 (host_permissions 추가)
const extDir = await mkdtemp(join(tmpdir(), 'webcopycat-'));
for (const f of ['manifest.json', 'background.js', 'content.js', 'offscreen.html', 'offscreen.js', 'lib', 'icons']) {
  await cp(join(root, f), join(extDir, f), { recursive: true });
}
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest));

// 2) 픽스처 페이지를 로컬 HTTP 서버로 제공
const html = await readFile(join(root, 'test/fixture.html'));
const server = createServer((_req, res) => res.end(html)).listen(0);
const liveUrl = process.argv[2];
const url = liveUrl || `http://localhost:${server.address().port}/`;

// 3) 확장프로그램을 로드한 브라우저 실행
const context = await chromium.launchPersistentContext('', {
  headless: !process.env.HEADED,
  executablePath: process.env.CHROMIUM_PATH,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  await context.grantPermissions(['clipboard-read'], { origin: `http://localhost:${server.address().port}` });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));

  // 4) 툴바 클릭과 동일한 함수 실행
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await copyArticle(tab);
  });

  // 5) 클립보드 내용 확인
  // 클립보드 읽기 권한을 준 로컬 페이지에서 읽는다 (외부 사이트는 권한 부여가 안 될 수 있음)
  const reader = await context.newPage();
  await reader.goto(`http://localhost:${server.address().port}/`);
  const copied = await reader.evaluate(() => navigator.clipboard.readText());
  console.log('--- 복사된 텍스트 ---\n' + copied + '\n--------------------');
  // URL을 직접 지정한 경우는 결과 출력만 하고 검증은 건너뛴다
  if (!liveUrl) {
    assert.match(copied, /BODY_START/, '본문 시작이 포함되어야 함');
    assert.match(copied, /BODY_END/, '본문 끝이 포함되어야 함');
    assert.match(copied, /추가됩니다\.\n- 신규 보스/, '목록은 "- "로 시작하고 빈 줄 없이 이어져야 함');
    for (const noise of ['NAV_', 'SIDEBAR_', 'COMMENT_', 'FOOTER_']) {
      assert.ok(!copied.includes(noise), `${noise} 잡음이 포함되면 안 됨`);
    }
    assert.ok(!/\n{3,}/.test(copied), '빈 줄이 연속되면 안 됨');
    console.log('✓ 테스트 통과');
  }
} finally {
  await context.close();
  server.close();
  await rm(extDir, { recursive: true, force: true });
}
