/**
 * 아이콘과 웹스토어 이미지를 PNG로 렌더링한다.
 * 실행: npm run assets
 *
 * - icons/icon.svg → icons/icon{16,32,48,128}.png
 *   (128px은 웹스토어 가이드대로 96px 그림 + 사방 16px 투명 여백)
 * - store/assets.html의 각 섹션 → store/promo-440x280.png, store/marquee-1400x560.png, store/screenshot-2.png
 * - test/fixture.html + 복사 완료 오버레이 → store/screenshot-1.png
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

// 1) 확장프로그램 아이콘
const svg = await readFile(root + 'icons/icon.svg', 'utf8');
for (const size of [16, 32, 48, 128]) {
  const art = size === 128 ? 96 : size;
  const pad = (size - art) / 2;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${art}px;height:${art}px;margin:${pad}px}</style>${svg}`);
  await page.screenshot({ path: `${root}icons/icon${size}.png`, omitBackground: true });
  await page.close();
}

// 2) 프로모션 타일과 비교 스크린샷 (assets.html의 섹션 단위 캡처)
const assets = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await assets.goto('file://' + root + 'store/assets.html');
await assets.locator('#promo').screenshot({ path: root + 'store/promo-440x280.png' });
await assets.locator('#marquee').screenshot({ path: root + 'store/marquee-1400x560.png' });
await assets.locator('#compare').screenshot({ path: root + 'store/screenshot-2.png' });

// 3) 사용 장면 스크린샷: 픽스처 페이지에 "복사되는 영역 강조 + 설명 문구" 오버레이를 그린다
//    (실제 확장프로그램에 없는 UI처럼 보이지 않도록 설명 문구로 표현)
const shot = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await shot.goto('file://' + root + 'test/fixture.html');
await shot.addStyleTag({ content: `
  .post-body { outline: 3px solid #4F46E5; outline-offset: 10px; border-radius: 4px; background: rgba(79,70,229,.05); }
  #wcc-toast { position: fixed; top: 72px; right: 28px; background: #111827; color: #fff; padding: 14px 20px; border-radius: 12px;
    font: 600 16px "Apple SD Gothic Neo", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.25); display: flex; gap: 12px; align-items: center; }
  #wcc-toast img { width: 28px; height: 28px; }
  #wcc-toast small { display: block; font-weight: 400; opacity: .7; font-size: 13px; }` });
await shot.evaluate((iconUrl) => {
  // 테스트용 표식(NAV_, BODY_START 등)은 스크린샷에서 숨긴다
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    walker.currentNode.nodeValue = walker.currentNode.nodeValue.replace(/(NAV|SIDEBAR|COMMENT|FOOTER)_|BODY_(START|END) ?/g, '');
  }
  const toast = document.createElement('div');
  toast.id = 'wcc-toast';
  toast.innerHTML = `<img src="${iconUrl}"><div>아이콘 클릭 한 번으로<small>표시된 본문만 복사 (메뉴·사이드바·댓글 제외)</small></div>`;
  document.body.append(toast);
}, 'file://' + root + 'icons/icon.svg');
await shot.screenshot({ path: root + 'store/screenshot-1.png' });

await browser.close();
console.log('✓ 아이콘·스토어 이미지 생성 완료');
