# DictAI Dictionary Extension (Chrome & Firefox)

A browser extension for **Google Chrome** and **Mozilla Firefox** that displays
a floating or standalone definition popup whenever you double-click a word.
Definitions can come from DictAI or the English section of Wiktionary.

---

## Features

- **Selectable Main Dictionary**: Choose DictAI or English Wiktionary from the extension settings.
- **Double-Click Word Lookup**: Double-click any single word on a web page to view its definition from the selected source.
- **Local Inflection Resolution**: Uses a compact local index of more than 410,000 DictAI entries to resolve forms such as `investigating` → `investigate` before making a request.
- **Structured Wiktionary View**: Extracts only English parts of speech, numbered definitions, context labels, and concise usage examples instead of embedding the Wiktionary page.
- **Private AI Fallback**: When the selected dictionary definitively has no matching entry, a loopback-only helper can return a Google AI Mode definition from an isolated Chromium profile.
- **Continue the AI Conversation**: AI fallback results include a button that restores and focuses the exact incognito AI Mode tab so follow-up questions can continue there.
- **Bounded Loading**: DictAI and AI requests have explicit timeouts, so the popup cannot remain on “Loading definition…” indefinitely.
- **Smart Floating Card**: Positioned relative to the selected word with smooth entrance animations and automatic screen boundary adjustment.
- **Header Header & Resizable**: Drag the popup by its header bar or resize it from the options menu.
- **Shadow DOM Style Isolation**: Prevents target web page CSS from breaking the popup layout.
- **DeclarativeNetRequest Rules**: Strips iframe header blocks (`X-Frame-Options` and `Content-Security-Policy`) for `dictai.org` so page previews load smoothly inside the popup.
- **Resilient Fallback**: Includes a background service worker fetch mechanism to render `dictai.org` content if strict host page CSP rules block standard iframe loading.
- **Full Settings Control**: Choose the main dictionary, trigger keys, theme, display mode, and default window dimensions.
- **Chrome & Firefox Support**: Built for Manifest V3 in both browsers.

---

## Directory Structure

```
dictionary-extension/
├── ai-fallback-server.js       # Warm, loopback-only Google AI Mode bridge
├── ai-fallback-profile-setup   # Optional persistent-profile setup helper
├── build.py                    # Generates Chrome and Firefox extensions
├── install-ai-fallback-service.sh # Installs the per-user AI bridge service
├── install-kwin-positioner.sh  # Installs the KWin Wayland positioner
├── lib/
│   └── ai-mode-page.js         # Google AI Mode page extraction used by the bridge
├── README.md                   # Project documentation
├── kwin/
│   └── dictai-positioner/     # KWin script that places native popup windows
├── shared/                    # Core source files shared between Chrome and Firefox
│   ├── background.js          # Service worker for fetching fallback HTML and handling tabs
│   ├── content.js             # Content script listening for dblclick and rendering Shadow DOM popup
│   ├── content.css            # Styles for content script container
│   ├── wiktionary.js          # English definition extractor and compact renderer
│   ├── popup.html             # Toolbar extension popup interface
│   ├── popup.css              # Styling for toolbar extension popup
│   ├── popup.js               # Logic for extension popup options and word search
│   ├── rules.json             # DeclarativeNetRequest header modification rules
│   ├── word-index.bin         # Sorted 64-bit hashes of known DictAI words
│   ├── word-index.meta.json   # Index provenance, size, count, and checksum
│   └── icons/                 # Extension icons (16x16, 48x48, 128x128)
├── scripts/
│   └── update-word-index.py   # Rebuilds the local index from DictAI sitemaps
├── systemd/
│   └── dictai-ai-fallback.service # User-service definition for the bridge
├── chrome/                    # Production-ready Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── content.css
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── rules.json
│   └── icons/
└── firefox/                   # Production-ready Firefox extension (Manifest V3)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── content.css
    ├── popup.html
    ├── popup.css
    ├── popup.js
    ├── rules.json
    └── icons/
```

---

## Script Descriptions & Inputs / Outputs

### 1. `build.py`
- **Description**: Python build and synchronization script. Copies shared assets from `shared/` into browser-specific `chrome/` and `firefox/` build folders and generates target `manifest.json` files tailored to Chrome (Service Worker) and Firefox (Background Scripts & Gecko ID).
- **Input**: Files in `shared/` directory.
- **Output**: Populated `chrome/` and `firefox/` directories with correct `manifest.json` files.
- **Execution**: `UV_CACHE_DIR=/data/.cache/uv uv run --no-project python build.py`

### 2. `shared/background.js` (Service Worker / Background Script)
- **Description**: Resolves inflections against the local DictAI word index, routes lookups to the selected dictionary, fetches normal Wiktionary pages with a MediaWiki parse-API fallback, sanitizes and caches results, and contacts the loopback AI helper only after a definite dictionary miss.
- **Input**: Runtime extension messages (`FETCH_DICT_HTML`, `PREFETCH_DICT_HTML`, `FETCH_AI_DEFINITION`, `OPEN_DICT_TAB`, `GET_SETTINGS`, `SAVE_SETTINGS`).
- **Output**: DictAI HTML, Wiktionary English-section HTML, plain-text AI definitions, errors with typed causes, or a new browser tab.

### 3. `shared/content.js` (Content Script)
- **Description**: Injected into all web pages (`<all_urls>`). Listens for `dblclick` events, extracts valid single words, creates an isolated Shadow DOM floating container, and positions the preview iframe near the selected word.
- **Input**: DOM events (`dblclick`, `mousedown`, `keydown`).
- **Output**: Rendered DictAI or structured Wiktionary floating popup UI.

### 4. `shared/popup.html` / `popup.js` / `popup.css` (Toolbar Control Panel)
- **Description**: Interface shown when clicking the extension toolbar icon. Allows selecting DictAI or Wiktionary, searching words directly, toggling extension state, setting trigger keys, changing themes, and configuring popup dimensions.
- **Input**: User clicks and form input.
- **Output**: Persisted settings in `chrome.storage.sync` / `browser.storage.sync`.

### 5. `install-kwin-positioner.sh` / `kwin/dictai-positioner`
- **Description**: Installs and starts the KWin script required to position independent Firefox popup windows on native Wayland.
- **Input**: Temporary geometry marker placed in the DictAI popup's window title.
- **Output**: KWin applies the requested screen coordinates and size to the native popup window.
- **Installed files**: KWin package files under `~/.local/share/kwin/` are symlinks to `kwin/` in this repository.
- **Execution order**: Run the installer once, then load or reload the Firefox extension.

### 6. `scripts/update-word-index.py`

- **Description**: Downloads DictAI's word sitemap shards, normalizes their `/w/WORD` paths, hashes them with 64-bit FNV-1a, and writes a sorted binary membership index.
- **Input**: `https://www.dictai.org/sitemap.xml` and its numbered sitemap shards.
- **Output**: `shared/word-index.bin` and `shared/word-index.meta.json`.
- **Execution**: `UV_CACHE_DIR=/data/.cache/uv uv run --no-project python scripts/update-word-index.py`

### 7. `ai-fallback-server.js`

- **Description**: Uses this repository's `lib/ai-mode-page.js` with the Puppeteer packages installed for `~/Dev/chatbot`. It keeps one Google AI Mode tab warm, serializes requests, caches repeat definitions in memory, and accepts extension requests only over `127.0.0.1:9235`.
- **Input**: `POST /v1/define` containing `{ "word": "..." }`, or `POST /v1/show-chat` containing the returned chat identifier, from a Firefox or Chrome extension origin.
- **Output**: JSON containing a plain-text AI-generated definition and temporary chat identifier, or restoration of its incognito AI Mode tab.
- **Profile**: `~/.config/chromium-dictai-fallback`, separate from both normal Chrome and `~/.config/chromium-chatbot`.

### 8. `ai-fallback-profile-setup` / `install-ai-fallback-service.sh`

- **Description**: The installer enables the signed-out incognito bridge as a systemd user service. The profile helper is only needed if Google challenges fresh incognito sessions and opens a separate signed-out persistent profile for cookie setup.
- **Execution order**: Normally run only `./install-ai-fallback-service.sh`.
- **Installed unit**: `~/.config/systemd/user/dictai-ai-fallback.service` is a symlink to `systemd/dictai-ai-fallback.service` in this repository.

---

## Installation & Setup Instructions

### 1. Building the Extensions
If you make changes to any source files in `shared/`, run:
```bash
UV_CACHE_DIR=/data/.cache/uv uv run --no-project python build.py
```

### 2. Loading into Google Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `chrome/` folder inside this project repository (`/home/lewis/Dev/dictionary-extension/chrome`).

### 3. Loading into Mozilla Firefox
1. Open Mozilla Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select the `manifest.json` file inside the `firefox/` directory (`/home/lewis/Dev/dictionary-extension/firefox/manifest.json`).

### 4. Native Wayland Window Positioning on KDE Plasma

Wayland does not allow Firefox to position a top-level window directly. Install
the included KWin script once so separate DictAI windows can be moved to the
selected word's screen coordinates:

```bash
./install-kwin-positioner.sh
```

The helper runs inside KWin, handles only windows carrying DictAI's temporary
markers, and leaves each result as an independently movable and closable OS
window. A first-frame marker makes the new surface transparent; KWin applies
its final geometry and only then restores opacity, preventing a centered-window
flash before the popup appears beside the selected word.

### 5. Private Google AI Mode Fallback

The bridge launches Chrome normally, then connects through a private debugging
port using the same approach as `~/Dev/chatbot`. Its default browser context is
incognito and signed out: no Google account is used, and Chrome does not retain
local history after the process closes.
On KDE Wayland, the bridge uses `kdotool` to raise only its own Chrome process
when **Continue chat in incognito** is clicked.

1. Install and start the background bridge:

   ```bash
   ./install-ai-fallback-service.sh
   ```

2. Reload the browser extension after rebuilding it.

Check the helper with:

```bash
curl http://127.0.0.1:9235/health
systemctl --user status dictai-ai-fallback.service
```

If Google challenges a completely fresh incognito session, initialize the
separate, still-signed-out persistent profile:

```bash
systemctl --user stop dictai-ai-fallback.service
./ai-fallback-profile-setup
```

Then set `DICTAI_AI_INCOGNITO=0` in
`~/.config/dictai-ai-fallback.env` and restart the service. This fallback
profile is isolated from normal Chrome and `chromium-chatbot`; it must remain
signed out.

### Pipeline Order

1. Consult the local DictAI word index and rank exact, irregular, plural, possessive,
   participle, past-tense, comparative, adverb, and noun-form candidates.
2. Resolve the selected word to the highest-ranked locally known lemma.
3. Fetch that lemma from the selected provider: sanitized DictAI HTML, or a
   CDN-served normal Wiktionary page.
4. For Wiktionary, extract and group only parts of speech, numbered senses,
   context labels, and usage examples into a compact local document. If that
   page cannot be parsed, retry through Wiktionary's MediaWiki parse API.
5. If the selected dictionary has no entry, request Google AI Mode through the
   loopback helper, with a 90-second timeout.
6. Render DictAI HTML, the structured Wiktionary document, or escaped AI output
   in the same independently movable popup window.

---

## How to Use

1. Navigate to any web page.
2. **Double-click on any single word** (e.g., "dictionary", "science", "astronomy").
3. A popup window will appear near the word displaying the definition from the selected dictionary.
4. Click the **↗** icon in the popup header to open the full definition page in a new tab, or press **Esc** / click outside to close the popup.
