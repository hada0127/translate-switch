# 번역 스위치 · Translate Switch

외국어가 섞인 웹 페이지에서 **그 외국어 문장만** 내 언어로 바꿔 보여 주는 Chrome 확장 프로그램입니다. 페이지를 통째로 번역하지 않고, Chrome 내장 번역기(기기 내 처리)를 써서 페이지 내용이 외부로 나가지 않습니다. 번역된 부분에 마우스를 올리면 원문이 보입니다.

A Chrome extension that replaces only the foreign-language sentences on a page with your language, using Chrome's built-in on-device Translator API. Page content never leaves your computer. Hover translated text to see the original.

- 원문 언어: 자동 감지 또는 지정 · 번역 언어: Chrome 지원 39개 언어(기본값은 브라우저 언어)
- 사이트별 켜기/끄기, 또는 한 번 허용해 모든 사이트에서 사용 · 페이지를 열면 자동 번역
- 단축키 ⌘K / Ctrl+K · 스위치 위치·숨김·표시 색상 설정 · 화면 언어 40개
- Chrome 138 이상

## 설치 (개발용)
`chrome://extensions` → 개발자 모드 → 「압축해제된 확장 프로그램을 로드합니다」 → 이 폴더 선택.

## 구조
| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 매니페스트 (`storage`·`scripting`·`activeTab`, 선택적 호스트 권한) |
| `background.js` | 허용된 사이트에 content script 등록, 권한 허용 마무리 |
| `content.js` | 페이지 번역(격리 world, 노드 글자만 교체 + CSS Highlight), 알약 스위치, 툴팁, 단축키 |
| `popup.html/js` | 툴바 팝업: 모델 받기, 켜기/끄기, 자동 번역, 모든 사이트에서 사용 |
| `options.html/js` | 전체 설정 |
| `grant.html/js` | 페이지 위 레이어에서 사이트 접근 권한 요청 |
| `common.js` · `ui.js` · `ui.css` | 공용 상수·설정 저장·화면 조각 |
| `_locales/` | 40개 언어 문구 |
| `store/` | 스토어 등록 자료(설명문, 권한 사유, 스크린샷) |

## 개인정보
수집하는 정보가 없습니다. → [`privacy-policy.md`](privacy-policy.md) · [gist](https://gist.github.com/hada0127/1f5aba252ca56491f31d9f20ee7682e8)

## 라이선스
MIT
