/**
 * content.js(자동 추출)와 picker.js(영역 선택)가 함께 쓰는 공통 함수.
 * background.js가 두 스크립트보다 먼저 주입한다.
 *
 * 같은 탭에 여러 번 주입될 수 있어 최상위에는 함수 선언만 둔다.
 * (함수 선언은 다시 선언해도 오류가 없지만, 최상위 const/let은 두 번째 주입 때 오류 발생)
 * 확장프로그램 스크립트는 페이지와 분리된 공간(isolated world)에서 실행되므로 페이지 변수와 충돌하지 않는다.
 */

/**
 * 사이트 전용 규칙을 돌려준다. hostname → { body: 본문 선택자, title?: 제목 선택자 }
 * 쉼표로 여러 선택자를 적으면 문서에서 먼저 나오는 요소가 선택된다.
 * body 선택자가 아무것도 찾지 못하거나 비어 있으면 Readability 자동 추출로 넘어간다.
 * @returns {{body: string, title?: string}|undefined} 현재 프레임 사이트의 규칙
 */
function wccSiteRule() {
  const rules = {
    // 넥슨 포럼: 제목/댓글/목록을 제외한 게시물 본문 (제목은 og:title이 정확해서 생략)
    'forum.nexon.com': { body: '.view-box .contents-box' },
    // 네이버 카페·블로그: SmartEditor ONE(.se-main-container), 구형 에디터(#tbody, #postViewArea)
    'cafe.naver.com': { body: '.se-main-container, .ContentRenderer, #tbody', title: '.title_text' },
    'blog.naver.com': { body: '.se-main-container, #postViewArea', title: '.se-title-text, .pcol1' },
    // 게임 커뮤니티 (2026-10 실제 게시물에서 확인)
    'gall.dcinside.com': { body: '.write_div', title: '.title_subject' },
    'm.dcinside.com': { body: '.thum-txtin', title: '.tit' },
    'www.inven.co.kr': { body: '#powerbbsContent', title: '.articleTitle h1' },
    'bbs.ruliweb.com': { body: '.view_content', title: '.subject_inner_text' },
    'arca.live': { body: '.article-body .fr-view', title: '.article-head .title' },
  };
  return rules[location.hostname];
}

/**
 * 게시물 제목을 찾는다. 순서: 사이트 규칙 → og:title → 첫 h1 → 문서 제목
 * @returns {string} 제목 (못 찾으면 빈 문자열)
 */
function wccFindTitle() {
  const selector = wccSiteRule()?.title;
  const candidates = [
    selector && document.querySelector(selector)?.innerText,
    document.querySelector('meta[property="og:title"]')?.content,
    document.querySelector('h1')?.innerText,
    document.title,
  ];
  return wccCleanText(candidates.find((t) => t && t.trim()) || '').replace(/\n+/g, ' ');
}

/**
 * DOM 노드를 줄바꿈이 살아 있는 일반 텍스트로 변환한다.
 * Readability 결과는 화면에 붙어 있지 않은 HTML이라 innerText를 쓸 수 없어서 직접 변환한다.
 * @param {Node} root - 변환할 최상위 노드
 * @returns {string} 정리 전 텍스트
 */
function wccHtmlToText(root) {
  // 앞뒤로 빈 줄(문단 구분)을 넣는 요소 / 줄바꿈 하나만 넣는 요소
  const PARAGRAPH_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'DL', 'TABLE', 'BLOCKQUOTE', 'FIGURE', 'HR'];
  const LINE_TAGS = ['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'LI', 'DT', 'DD', 'TR', 'FIGCAPTION'];
  let out = '';

  // 결과 끝이 최소 count개의 줄바꿈으로 끝나도록 보충 (중복 줄바꿈 방지)
  const breakLine = (count) => {
    if (!count) return;
    // 태그 사이 공백 텍스트(예: </li> <li>)가 줄바꿈 개수 계산을 방해하지 않도록 먼저 제거
    out = out.replace(/[ \t]+$/, '');
    const trailing = out.match(/\n*$/)[0].length;
    if (out && trailing < count) out += '\n'.repeat(count - trailing);
  };

  const walk = (node) => {
    // 텍스트 노드: HTML 소스의 줄바꿈·연속 공백은 화면처럼 공백 하나로 합친다
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if (tag === 'BR') { out += '\n'; return; }
    // 이미지·스크립트 등 텍스트가 아닌 요소는 건너뛴다 (텍스트만 복사)
    if (['IMG', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME'].includes(tag)) return;
    // PRE(코드 블록)는 공백과 줄바꿈을 그대로 유지
    if (tag === 'PRE') { breakLine(2); out += node.textContent; breakLine(2); return; }
    // 표 셀은 탭으로 구분
    if (tag === 'TD' || tag === 'TH') out += '\t';

    const breaks = PARAGRAPH_TAGS.includes(tag) ? 2 : LINE_TAGS.includes(tag) ? 1 : 0;
    breakLine(breaks);
    if (tag === 'LI') out += '- ';
    node.childNodes.forEach(walk);
    breakLine(breaks);
  };

  walk(root);
  return out;
}

/**
 * 추출한 텍스트의 불필요한 공백을 정리한다.
 * - &nbsp;( )·제로폭 문자 정리, 줄 앞뒤 공백 제거
 * - 연속된 빈 줄은 빈 줄 하나로 줄임
 * @param {string} text - 원본 텍스트
 * @returns {string} 정리된 텍스트
 */
function wccCleanText(text) {
  return text
    .replace(/ /g, ' ')
    .replace(/[​﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
