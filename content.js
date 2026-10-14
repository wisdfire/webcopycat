/**
 * 페이지(각 프레임)에 주입되어 게시물 본문 텍스트를 추출하는 스크립트.
 *
 * background.js가 lib/Readability.js와 함께 주입하며,
 * 이 파일 마지막 표현식의 값({ text, byRule } 또는 null)이 executeScript의 결과로 돌아간다.
 *
 * 같은 탭에서 여러 번 주입될 수 있으므로 전역 변수를 만들지 않도록 전체를 IIFE로 감싼다.
 * (최상위 const를 쓰면 두 번째 주입 때 "already declared" 오류 발생)
 */
(() => {
  /**
   * 사이트 전용 규칙: hostname → 본문 영역 CSS 선택자.
   * 쉼표로 여러 개를 적으면 문서에서 먼저 나오는 요소가 선택된다.
   * 선택자가 아무것도 찾지 못하면 Readability 자동 추출로 넘어간다.
   */
  const SITE_RULES = {
    // 넥슨 포럼: 제목/댓글/목록을 제외한 게시물 본문
    'forum.nexon.com': '.view-box .contents-box',
    // 네이버 카페·블로그: SmartEditor ONE(.se-main-container), 구형 에디터(#tbody, #postViewArea)
    'cafe.naver.com': '.se-main-container, .ContentRenderer, #tbody',
    'blog.naver.com': '.se-main-container, #postViewArea',
  };

  // htmlToText에서 앞뒤로 빈 줄(문단 구분)을 넣는 요소
  const PARAGRAPH_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'DL', 'TABLE', 'BLOCKQUOTE', 'FIGURE', 'HR',
  ]);
  // 앞뒤로 줄바꿈 하나만 넣는 요소
  const LINE_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'LI', 'DT', 'DD', 'TR', 'FIGCAPTION',
  ]);

  /**
   * DOM 노드를 줄바꿈이 살아 있는 일반 텍스트로 변환한다.
   * Readability 결과는 화면에 붙어 있지 않은 HTML이라 innerText를 쓸 수 없어서 직접 변환한다.
   * @param {Node} root - 변환할 최상위 노드
   * @returns {string} 정리 전 텍스트
   */
  function htmlToText(root) {
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

      const breaks = PARAGRAPH_TAGS.has(tag) ? 2 : LINE_TAGS.has(tag) ? 1 : 0;
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
  function cleanText(text) {
    return text
      .replace(/ /g, ' ')
      .replace(/[​﻿]/g, '')
      .split('\n')
      .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 사이트 전용 규칙으로 본문 요소를 찾는다.
   * @returns {Element|null} 본문 요소, 규칙이 없거나 못 찾으면 null
   */
  function findByRule() {
    const selector = SITE_RULES[location.hostname];
    return selector ? document.querySelector(selector) : null;
  }

  /**
   * Readability로 본문을 자동 추출한다.
   * Readability는 넘겨받은 문서를 변형하므로 반드시 복제본에 실행한다.
   * @returns {string|null} 본문 텍스트, 추출 실패 시 null
   */
  function extractWithReadability() {
    // 본문이 거의 없는 프레임(광고, 빈 iframe)은 건너뜀
    if (!document.body || document.body.innerText.trim().length < 50) return null;

    // charThreshold: 본문 판정 최소 글자 수 (기본 500).
    // 한글은 글자당 정보량이 많아 짧은 게시물이 기준 미달 → 댓글까지 포함되는 문제가 있어 낮춘다.
    const article = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse();
    if (!article || !article.content) return null;

    // Readability 결과 HTML을 DOMParser로 파싱 (스크립트가 실행되지 않는 안전한 방식)
    const doc = new DOMParser().parseFromString(article.content, 'text/html');
    return htmlToText(doc.body);
  }

  // ---- 실행부: 규칙 → Readability 순서로 시도 ----
  const ruleElement = findByRule();
  if (ruleElement) {
    // 화면에 렌더링된 요소는 innerText가 줄바꿈·숨김 요소를 가장 정확히 반영한다.
    // 복사 방지(user-select: none, copy 이벤트 차단)는 innerText 읽기에 영향을 주지 않는다.
    const text = cleanText(ruleElement.innerText);
    if (text) return { text, byRule: true };
  }

  const text = cleanText(extractWithReadability() || '');
  return text ? { text, byRule: false } : null;
})();
