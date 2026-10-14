/**
 * 확장프로그램 전체 흐름 테스트: 실제 Chromium에 확장프로그램을 로드 → 복사 실행 → 클립보드 확인.
 *
 * 실행: npm test  (최초 1회 npx playwright install chromium 필요)
 *      npm test -- <URL>  → 실제 사이트에서 복사 결과만 출력 (검증 없음, 사이트 규칙 점검용)
 *
 * 자동화 환경에서는 사용자 클릭이 없어 activeTab 권한이 생기지 않으므로,
 * 임시 폴더에 확장프로그램을 복사하고 manifest에 host_permissions를 추가한 테스트용 사본을 로드한다.
 * 그 뒤 서비스 워커에서 copyArticle(tab) / startPicker(tab)를 직접 호출한다 (툴바 클릭·메뉴와 같은 함수).
 *
 * 주의: 테스트가 시스템 클립보드 내용을 덮어쓴다.
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
for (const f of ['manifest.json', 'background.js', 'common.js', 'content.js', 'picker.js', 'offscreen.html', 'offscreen.js', 'lib', 'icons']) {
  await cp(join(root, f), join(extDir, f), { recursive: true });
}
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest));

// 2) 픽스처 페이지를 로컬 HTTP 서버로 제공
const html = await readFile(join(root, 'test/fixture.html'));
const server = createServer((_req, res) => res.end(html)).listen(0);
const localUrl = `http://localhost:${server.address().port}/`;
const liveUrl = process.argv[2];

// 3) 확장프로그램을 로드한 브라우저 실행
const context = await chromium.launchPersistentContext('', {
  headless: !process.env.HEADED,
  executablePath: process.env.CHROMIUM_PATH,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: localUrl.slice(0, -1) });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  // 클립보드 읽기 전용 탭 (권한을 준 로컬 출처라 외부 사이트 테스트에서도 읽을 수 있음)
  const reader = await context.newPage();
  await reader.goto(localUrl);
  const page = await context.newPage();
  if (liveUrl) {
    // 실제 사이트는 광고 등으로 네트워크가 계속 바빠서 networkidle 대신 load 후 JS 렌더링을 잠시 기다린다
    await page.goto(liveUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2000);
  } else {
    await page.goto(localUrl);
  }

  /** 클립보드를 비운 뒤 서비스 워커에서 fnName(현재 탭)을 실행한다. */
  const run = async (fnName) => {
    await reader.evaluate(() => navigator.clipboard.writeText(''));
    await page.bringToFront();
    await sw.evaluate(async (name) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await globalThis[name](tab);
    }, fnName);
  };
  /** 클립보드 내용을 읽는다 (영역 선택처럼 비동기로 끝나는 경우를 위해 잠시 기다리며 재시도). */
  const readClipboard = async () => {
    for (let i = 0; i < 20; i++) {
      const text = await reader.evaluate(() => navigator.clipboard.readText());
      if (text) return text;
      await page.waitForTimeout(100);
    }
    return '';
  };
  // 영역 선택 모드의 강조 상자·안내 문구 (z-index 최댓값으로 식별)
  const pickerGone = () => page.waitForFunction(() => !document.querySelector('div[style*="2147483647"]'), null, { timeout: 3000 });

  // ---- 자동 복사 ----
  await run('copyArticle');
  const copied = await readClipboard();
  console.log('--- 복사된 텍스트 ---\n' + copied + '\n--------------------');

  // URL을 직접 지정한 경우는 결과 출력만 하고 검증은 건너뛴다
  if (!liveUrl) {
    assert.match(copied, /^안녕하세요, 모험가 여러분\. BODY_START/, '제목 옵션이 꺼져 있으면 본문부터 시작해야 함');
    assert.match(copied, /BODY_END/, '본문 끝이 포함되어야 함');
    assert.match(copied, /추가됩니다\.\n- 신규 보스/, '목록은 "- "로 시작하고 빈 줄 없이 이어져야 함');
    for (const noise of ['NAV_', 'SIDEBAR_', 'COMMENT_', 'FOOTER_', 'HIDDEN_', 'OFFSCREEN_', 'CLIPPED_']) {
      assert.ok(!copied.includes(noise), `${noise} 잡음이 포함되면 안 됨`);
    }
    assert.ok(!/\n{3,}/.test(copied), '빈 줄이 연속되면 안 됨');
    console.log('✓ 자동 복사');

    // ---- 제목 포함 옵션 ----
    await sw.evaluate(() => chrome.storage.sync.set({ includeTitle: true }));
    await run('copyArticle');
    const withTitle = await readClipboard();
    assert.match(withTitle, /^10\/14\(화\) 업데이트 안내.*\n\n안녕하세요/, '첫 줄에 제목, 빈 줄 다음에 본문이 와야 함');
    await sw.evaluate(() => chrome.storage.sync.set({ includeTitle: false }));
    console.log('✓ 제목 포함 옵션');

    // ---- 영역 선택 모드: 첫 번째 댓글을 클릭하면 그 댓글만 복사 ----
    await run('startPicker');
    await page.hover('.comment');
    await page.click('.comment');
    assert.equal(await readClipboard(), 'COMMENT_모험가123: 보스 기대됩니다!');
    await pickerGone(); // 복사 후 선택 모드가 끝나 강조 상자·안내 문구가 사라져야 함
    console.log('✓ 영역 선택 복사');

    // ---- 영역 선택 모드: Esc로 취소 ----
    await run('startPicker');
    await page.keyboard.press('Escape');
    await pickerGone();
    assert.equal(await reader.evaluate(() => navigator.clipboard.readText()), '', '취소하면 아무것도 복사되지 않아야 함');
    console.log('✓ 영역 선택 취소');

    console.log('✓ 테스트 통과');
  }
} finally {
  await context.close();
  server.close();
  await rm(extDir, { recursive: true, force: true });
}
