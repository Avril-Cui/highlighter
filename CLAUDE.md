# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Extension (Manifest V3) called **Web Highlighter**. No build step, no npm, no bundler — all files are plain JS/HTML/CSS loaded directly by Chrome.

## How to load / reload

There is no build command. To test changes:
1. Go to `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder (first time), or click the **↺ reload** icon on the extension card (subsequent changes)
4. Close and reopen the popup after reloading

**Important:** Chrome extension popups can cache JS. After any popup.js/popup.html/popup.css change, always reload the extension AND reopen the popup fresh.

## Architecture

### Script contexts and shared code

There are three isolated JS contexts. They cannot share variables at runtime — only communicate via `chrome.runtime.sendMessage`.

| Context | Files | How it loads |
|---|---|---|
| Service worker | `background.js` | Uses `importScripts('firebase-config.js', 'firebase-api.js')` |
| Popup page | `popup.html` + `popup.js` | Loads `firebase-config.js`, `firebase-api.js`, `popup.js` via `<script>` tags |
| Content script | `content.js` + `content.css` | Injected into every http/https page; **no access to firebase-api.js** |

`firebase-api.js` is the only shared module. It contains all Firebase REST API calls, token management, and Firestore CRUD. It depends on `FIREBASE_CONFIG` being defined (from `firebase-config.js`), which must always be loaded first.

### Message bus (content.js → background.js)

Content scripts cannot use Firebase directly. They send messages to the background service worker:

| Message type | Direction | Purpose |
|---|---|---|
| `GET_HIGHLIGHTS` | content → bg | Fetch saved highlights for current URL |
| `SAVE_HIGHLIGHT` | content → bg | Persist a new highlight |
| `DELETE_HIGHLIGHT` | content → bg | Remove a highlight by id |
| `GET_SAVED_PAGES` | popup → bg | Fetch all saved pages |
| `SAVE_PAGE` | popup → bg | Save current page with title/note |
| `DELETE_SAVED_PAGE` | popup → bg | Remove a saved page by id |
| `SYNC_ON_LOGIN` | popup → bg | Trigger Firestore→local sync after login |
| `SETTINGS_UPDATED` | popup → content | Push new settings to active tab |

### Data storage

Two layers always in sync:
- **`chrome.storage.local`** — primary local cache, works offline. Keys: `user`, `settings`, `highlights` (object keyed by URL), `savedPages` (array), `lastCleanup`
- **Firestore** — source of truth when user is logged in. Synced in background after local write.

Firestore collections under `users/{uid}/`:
- `highlights/{id}` — per-page highlight with XPath position data
- `savedPages/{id}` — saved page with title, note, savedAt
- `stats/{YYYY-MM-DD}` — daily reading stats (kept 7 days, cleaned daily)
- `settings` — single document for user preferences

### Highlight persistence mechanism (content.js)

Highlights are serialized using **element XPath + character offset** (not text-node XPath, which breaks after DOM mutation). On restore, `document.evaluate()` finds the parent element, then a TreeWalker counts characters to the exact position. Falls back to text-content search if XPath fails.

Key functions in `content.js`:
- `serializeRange(range)` → stores `{startXPath, startOffset, endXPath, endOffset, text}`
- `deserializeRange(h)` → reconstructs a Range, verifies text match, falls back to `fallbackTextSearch`
- `applyHighlightRange(range, id, color, textColor)` → splits text nodes and wraps in `<mark class="wh-highlight">`

### Popup initialization pattern

**Critical:** `popup.js` defines all functions first, then runs the boot block at the very bottom using:
```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}
```
This is intentional — Chrome extension popups often have the DOM already parsed when scripts execute, causing `DOMContentLoaded` registered at the top to fire synchronously before later functions are parsed. Never move `initPopup()` back to the top of the file.

### Auth flow

- **Email/password**: Firebase Identity Toolkit REST API (`/accounts:signUp`, `/accounts:signInWithPassword`)
- **Google**: `chrome.identity.getAuthToken()` → exchange access token with Firebase `/accounts:signInWithIdp`
- Tokens stored in `chrome.storage.local` as `user: { uid, email, idToken, refreshToken, expiresAt }`
- `getValidToken()` in `firebase-api.js` auto-refreshes tokens expiring within 60 seconds

## Key files

- `firebase-config.js` — Firebase project credentials (already filled in for project `highlighter-36981`)
- `manifest.json` — declares permissions (`storage`, `identity`, `tabs`), OAuth2 client ID, content script injection
- `icons/generate-icons.html` — open in Chrome to regenerate PNG icons from canvas
