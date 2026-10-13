# 번역 스위치 · Translate Switch

외국어가 섞인 웹 페이지에서 **그 외국어 문장만** 내 언어로 바꿔 보여 주는 Chrome 확장 프로그램입니다. 페이지를 통째로 번역하지 않고, Chrome 내장 번역기(기기 내 처리)를 써서 페이지 내용이 외부로 나가지 않습니다. 번역된 부분에 마우스를 올리면 원문이 보입니다.

A Chrome extension that replaces only the foreign-language sentences on a page with your language, using Chrome's built-in on-device Translator API. Page content never leaves your computer. Hover translated text to see the original.

- 원문 언어: 자동 감지 또는 지정 · 번역 언어: Chrome 지원 39개 언어(기본값은 브라우저 언어)
- **단축키 ⌘K / Ctrl+K 로 바로 켜고 끄기** (한글·일본어 자판에서도 동작)
- 사이트별 켜기/끄기, 또는 한 번 허용해 모든 사이트에서 사용 · 자동 번역은 사이트별로 정한 곳에서만(처음 가는 사이트는 스위치만 붙음)
- 스위치 위치·숨김·표시 색상 설정 · 화면 언어 40개
- Chrome 138 이상

## 설치 (개발용)
`chrome://extensions` → 개발자 모드 → 「압축해제된 확장 프로그램을 로드합니다」 → 이 폴더 선택.

1.5.0에서 업데이트한 뒤 이미 열린 탭은 한 번 새로고침해 주세요. 같은 격리 world에서 1.5.0이 감지되면 새 인스턴스를 시작하지 않고 새로고침을 안내합니다. 별도 world에서는 탐침이 기존 인스턴스를 볼 수 없어 새 인스턴스가 주입되지만, 1.5.0은 자동 정리할 수 없으므로 수동 새로고침이 필요합니다.

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
| `store/` | 스토어 등록 자료: `listing-<locale>.md` 40개(요약·설명), 권한 사유, 스크린샷 |

## 스토어 업데이트 절차
- **요약**(스토어 카드의 한 줄)은 패키지의 `_locales/<locale>/messages.json` → `extDesc` 에서 읽힌다. 132자 이하. 바꾸면 새 버전 zip 을 올려야 반영된다.
- **설명**은 대시보드에서 언어별로 직접 넣는다. 원본은 `store/listing-<locale>.md` 의 `## Description` 아래 본문(40개 언어, 버튼 이름은 각 언어 `messages.json` 의 `downloadModel`·`turnOn`·`clickToStart` 문구와 맞춤).
- 요약을 고치면 `extDesc` 와 `listing-<locale>.md` 의 `## Summary` 를 같이 고친다(같은 문자열이어야 함).
- 단축키 ⌘K / Ctrl+K 는 핵심 기능이라 모든 언어의 요약·설명 첫머리·특징 첫 줄에 넣어 둔다.
- 순서: `manifest.json` 버전 올림 → zip(루트에 `manifest.json`, `store/`·`test/` 제외) → 대시보드 「패키지」 업로드 → 「스토어 등록정보」에서 언어별 설명 붙여넣기 → 검토 제출.
- 대시보드(`chrome.google.com/webstore/devconsole`)는 Chrome 이 확장 프로그램 조작을 막아(`The extensions gallery cannot be scripted`) Claude in Chrome 으로 자동화할 수 없다. 업로드·붙여넣기는 사람이 한다.
- 2026-10-13: 40개 언어 설명·요약 준비(`7e86214`). kn·mr·bn·ta·te 는 원어민 검수 권장. fi·hr·it·pt_BR·ru 요약은 132자에 딱 맞음.

## 개인정보
수집하는 정보가 없습니다. → [`privacy-policy.md`](privacy-policy.md) · [gist](https://gist.github.com/hada0127/1f5aba252ca56491f31d9f20ee7682e8)

## 라이선스
MIT
