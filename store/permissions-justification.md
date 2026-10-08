# 권한 사유 (대시보드 「개인정보 보호 관행」 탭에 붙여 넣을 내용)

## 단일 목적 설명
Translates the foreign-language text on web pages the user chooses, using Chrome's built-in on-device translator, and shows the original on hover.

## storage
Stores the user's settings: which sites are enabled, source/target languages, auto-translate, shortcut, switch position and highlight color. Synced via chrome.storage.sync so settings follow the user's Chrome profile.

## activeTab
When the user clicks the toolbar icon and turns the extension on, the content script is injected into that tab only, so translation works immediately without a broad permission.

## scripting
Registers the content script for sites the user has allowed (chrome.scripting.registerContentScripts) and injects it into the current tab after the user turns it on. No remote code; all scripts ship inside the package.

## Host permissions (optional, *://*/*)
Requested at runtime only when the user explicitly allows a site (or chooses "Allow all sites") so the switch can attach automatically on later visits. Nothing is requested at install time. Page content is processed locally by Chrome's Translator API and never transmitted.

## Remote code
No. All code is included in the package.

## Data usage
The extension does not collect, transmit or sell any user data. Page text is passed only to Chrome's built-in on-device Translator/LanguageDetector APIs. Settings are stored in chrome.storage.sync.
