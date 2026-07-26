/**
 * DictAI Dictionary Extension - Background Service Worker / Script
 * High-Performance Edition: Includes a local DictAI word index, ranked
 * inflection resolution, bounded network requests, caching, and an optional
 * private Google AI Mode fallback bridge.
 * Fully compatible with both Firefox (Promise-based messaging) and Chrome (Service Worker).
 */

const extAPI = typeof browser !== 'undefined' ? browser : chrome;

// Default settings configuration
const DEFAULT_SETTINGS = {
  enabled: true,
  triggerMode: 'dblclick', // 'dblclick' or 'alt_dblclick'
  displayMode: 'separate_window', // 'separate_window' or 'in_page'
  popupWidth: 480,
  popupHeight: 520,
  theme: 'system',
  allowInInputs: false,
  dictionaryProvider: 'dictai'
};

// In-memory definition cache for instant repeat lookups.
const dictCache = new Map();
const pendingFetches = new Map();
const wiktionaryCache = new Map();
const pendingWiktionaryFetches = new Map();
const aiCache = new Map();
const pendingAiFetches = new Map();
const MAX_CACHE_SIZE = 250;
const PERSISTENT_CACHE_NAME = 'dictai-definitions-v2';
const PERSISTENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DICT_FETCH_TIMEOUT_MS = 5000;
const WIKTIONARY_FETCH_TIMEOUT_MS = 7000;
const AI_FETCH_TIMEOUT_MS = 90000;
const AI_FALLBACK_URL = 'http://127.0.0.1:9235/v1/define';
// Deliberately distinctive staging geometry lets KWin identify and hide the
// native Wayland surface before Firefox has published its title.
const NATIVE_STAGING_WIDTH = 137;
const NATIVE_STAGING_HEIGHT = 139;
let persistentCacheWrites = 0;
let wordIndexPromise = null;

// Pre-fetched etymology stylesheet inlining to eliminate external CSS network requests
let cachedEtymologyCss = '';
let etymologyCssPromise = null;
function preloadEtymologyCss() {
  if (cachedEtymologyCss) return Promise.resolve(cachedEtymologyCss);
  if (etymologyCssPromise) return etymologyCssPromise;

  etymologyCssPromise = fetchWithTimeout('https://www.dictai.org/etymology.css', {
    cache: 'force-cache'
  }, 3500)
    .then(async (res) => {
      if (!res.ok) return '';
      cachedEtymologyCss = await res.text();
      return cachedEtymologyCss;
    })
    .catch(() => '')
    .finally(() => {
      if (!cachedEtymologyCss) etymologyCssPromise = null;
    });

  return etymologyCssPromise;
}
preloadEtymologyCss();

// Initialize settings on installation
extAPI.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      const stored = await extAPI.storage.sync.get(null);
      const newSettings = { ...DEFAULT_SETTINGS, ...stored };
      await extAPI.storage.sync.set(newSettings);
      console.log('DictAI Extension initialized with settings:', newSettings);
    } catch (e) {
      console.warn('Storage sync failed, using local storage fallback', e);
      await extAPI.storage.local.set(DEFAULT_SETTINGS);
    }
  }
});

// Listener for messages from content script or popup
extAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  if (message.action === 'FETCH_DICT_HTML' || message.action === 'PREFETCH_DICT_HTML') {
    const word = message.word ? message.word.trim().toLowerCase() : '';
    const isPrefetch = message.action === 'PREFETCH_DICT_HTML';
    const provider = normalizeProvider(message.provider);
    const useWiktionaryApi =
      provider === 'wiktionary' && message.wiktionaryApiFallback === true;
    const lookup =
      provider === 'wiktionary'
        ? handleFetchWiktionaryHtml(word, useWiktionaryApi)
        : handleFetchDictHtml(word);
    const promise = lookup
      .then((result) => {
        // Prefetch callers never consume the document. Avoid cloning tens of
        // kilobytes back into the content page just to discard it.
        const res = isPrefetch
          ? { success: true, prefetched: true }
          : {
              success: true,
              source: provider,
              data: result.html,
              requestedWord: result.requestedWord,
              resolvedWord: result.resolvedWord,
              transport: result.transport || ''
            };
        try { sendResponse(res); } catch (_) {}
        return res;
      })
      .catch((err) => {
        const res = {
          success: false,
          error: err.message,
          errorKind: err.kind || 'network'
        };
        try { sendResponse(res); } catch (_) {}
        return res;
      });
    return promise; // Firefox requires returning a Promise for async responses
  }

  if (message.action === 'FETCH_AI_DEFINITION') {
    const word = message.word ? message.word.trim().toLowerCase() : '';
    const promise = fetchAiDefinition(word)
      .then((result) => {
        const res = {
          success: true,
          source: 'google_ai',
          data: result.definition,
          chatId: result.chatId || '',
          requestedWord: word,
          resolvedWord: word
        };
        try { sendResponse(res); } catch (_) {}
        return res;
      })
      .catch((err) => {
        const res = {
          success: false,
          error: err.message,
          errorKind: err.kind || 'ai_unavailable'
        };
        try { sendResponse(res); } catch (_) {}
        return res;
      });
    return promise;
  }

  if (message.action === 'SHOW_AI_CHAT') {
    const chatId = message.chatId ? String(message.chatId).trim() : '';
    const promise = showAiChat(chatId)
      .then(() => {
        const res = { success: true };
        try { sendResponse(res); } catch (_) {}
        return res;
      })
      .catch((err) => {
        const res = {
          success: false,
          error: err.message,
          errorKind: err.kind || 'ai_unavailable'
        };
        try { sendResponse(res); } catch (_) {}
        return res;
      });
    return promise;
  }

  if (message.action === 'OPEN_WINDOW_POPUP') {
    const word = message.word ? message.word.trim().toLowerCase() : 'dictionary';
    const provider = normalizeProvider(message.provider);
    const width = Number.isFinite(message.width) ? Math.round(message.width) : 480;
    const height = Number.isFinite(message.height) ? Math.round(message.height) : 520;
    const left = Number.isFinite(message.left) ? Math.round(message.left) : 100;
    const top = Number.isFinite(message.top) ? Math.round(message.top) : 100;
    const relativeLeft = Number.isFinite(message.relativeLeft)
      ? Math.round(message.relativeLeft)
      : left;
    const relativeTop = Number.isFinite(message.relativeTop)
      ? Math.round(message.relativeTop)
      : top;
    const viewportInsetX = Number.isFinite(message.viewportInsetX)
      ? Math.round(message.viewportInsetX)
      : 0;
    const viewportInsetY = Number.isFinite(message.viewportInsetY)
      ? Math.round(message.viewportInsetY)
      : 0;
    const cursorOffsetX = Number.isFinite(message.cursorOffsetX)
      ? Math.round(message.cursorOffsetX)
      : Math.round(-width / 2);
    const cursorOffsetY = Number.isFinite(message.cursorOffsetY)
      ? Math.round(message.cursorOffsetY)
      : 18;
    const popupParams = new URLSearchParams({
      word,
      positionX: String(left),
      positionY: String(top),
      windowWidth: String(width),
      windowHeight: String(height),
      relativeX: String(relativeLeft),
      relativeY: String(relativeTop),
      viewportInsetX: String(viewportInsetX),
      viewportInsetY: String(viewportInsetY),
      cursorOffsetX: String(cursorOffsetX),
      cursorOffsetY: String(cursorOffsetY),
      provider
    });
    const popupUrl = extAPI.runtime.getURL(`popup_frame.html?${popupParams}`);
    const nativePositionMarker =
      `[DICTAI_POPUP|${left}|${top}|${width}|${height}` +
      `|${relativeLeft}|${relativeTop}|${viewportInsetX}|${viewportInsetY}` +
      `|${cursorOffsetX}|${cursorOffsetY}] `;

    // Ensure the fetch is running even if pointer-based speculation was not
    // available on the source page. Do not delay creation of the local window.
    const prefetch =
      provider === 'wiktionary'
        ? handleFetchWiktionaryHtml(word)
        : handleFetchDictHtml(word);
    prefetch.catch(() => {});

    const windowConfig = {
      url: popupUrl,
      type: 'popup',
      width: NATIVE_STAGING_WIDTH,
      height: NATIVE_STAGING_HEIGHT,
      left,
      top,
      focused: false,
      // Supplying the complete geometry in the native title prefix lets KWin
      // position the surface while the window is first being managed, before
      // popup_frame.js or the definition page has loaded.
      titlePreface: nativePositionMarker
    };

    const promise = extAPI.windows.create(windowConfig)
      .then((win) => {
        const res = { success: true, positioned: true, windowId: win.id };
        try { sendResponse(res); } catch (_) {}
        return res;
      })
      .catch((err) => {
        console.error('Failed to open native window:', err);
        const res = { success: false, error: err.message };
        try { sendResponse(res); } catch (_) {}
        return res;
      });
    return promise;
  }

  if (message.action === 'GET_SETTINGS') {
    const promise = getSettings().then((settings) => {
      const res = { success: true, settings };
      try { sendResponse(res); } catch (_) {}
      return res;
    });
    return promise;
  }

  if (message.action === 'SAVE_SETTINGS') {
    const promise = extAPI.storage.sync.set(message.settings).then(() => {
      const res = { success: true };
      try { sendResponse(res); } catch (_) {}
      return res;
    });
    return promise;
  }

  if (message.action === 'OPEN_DICT_TAB') {
    if (message.word) {
      const cleanWord = message.word.trim().toLowerCase();
      const promise = (async () => {
        const settings = await getSettings();
        const provider = normalizeProvider(message.provider || settings.dictionaryProvider);
        const resolvedWord =
          provider === 'wiktionary' ? await resolveIndexedLemma(cleanWord) : cleanWord;
        const targetUrl =
          provider === 'wiktionary'
            ? `https://en.wiktionary.org/wiki/${encodeURIComponent(resolvedWord)}#English`
            : `https://www.dictai.org/w/${encodeURIComponent(resolvedWord)}`;
        await extAPI.tabs.create({ url: targetUrl });
        return { success: true };
      })();
      return promise;
    }
    return false;
  }

  return false;
});

class LookupError extends Error {
  constructor(message, kind = 'network', status = 0) {
    super(message);
    this.name = 'LookupError';
    this.kind = kind;
    this.status = status;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DICT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new LookupError(`Request timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function fnv1a64(value) {
  let result = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    result ^= BigInt(byte);
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result;
}

async function loadWordIndex() {
  if (wordIndexPromise) return wordIndexPromise;
  wordIndexPromise = fetch(extAPI.runtime.getURL('word-index.bin'))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Word index returned ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength % 8 !== 0) {
        throw new Error('Word index has an invalid size');
      }
      return new DataView(buffer);
    })
    .catch((error) => {
      wordIndexPromise = null;
      throw error;
    });
  return wordIndexPromise;
}

function indexContains(view, word) {
  const target = fnv1a64(word);
  let low = 0;
  let high = (view.byteLength / 8) - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = view.getBigUint64(middle * 8, true);
    if (current === target) return true;
    if (current < target) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

const IRREGULAR_LEMMAS = Object.freeze({
  am: 'be', are: 'be', is: 'be', was: 'be', were: 'be', been: 'be',
  has: 'have', had: 'have',
  does: 'do', did: 'do', done: 'do',
  went: 'go', gone: 'go',
  children: 'child', people: 'person',
  men: 'man', women: 'woman',
  mice: 'mouse', geese: 'goose',
  feet: 'foot', teeth: 'tooth',
  better: 'good', best: 'good',
  worse: 'bad', worst: 'bad'
});

function generateLemmaCandidates(word) {
  const candidates = [];
  const seen = new Set([word]);
  const add = (candidate) => {
    if (
      typeof candidate === 'string' &&
      candidate.length >= 2 &&
      !seen.has(candidate)
    ) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };
  const undouble = (stem) => {
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
  };

  add(IRREGULAR_LEMMAS[word]);

  if (word.endsWith("'s") || word.endsWith('’s')) add(word.slice(0, -2));
  if (word.endsWith("s'") || word.endsWith('s’')) add(word.slice(0, -1));

  if (word.endsWith('ying') && word.length > 5) add(`${word.slice(0, -4)}ie`);
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3);
    add(`${stem}e`);
    add(stem);
    undouble(stem);
  }

  if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ed') && word.length > 4) {
    const stem = word.slice(0, -2);
    if (word.endsWith('d')) add(word.slice(0, -1));
    add(stem);
    add(`${stem}e`);
    undouble(stem);
  }

  if (word.endsWith('ies') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves') && word.length > 4) {
    add(`${word.slice(0, -3)}f`);
    add(`${word.slice(0, -3)}fe`);
  }
  if (word.endsWith('es') && word.length > 4) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    add(word.slice(0, -1));
  }

  if (word.endsWith('iest') && word.length > 5) add(`${word.slice(0, -4)}y`);
  if (word.endsWith('ier') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('est') && word.length > 5) {
    const stem = word.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    undouble(stem);
  }
  if (word.endsWith('er') && word.length > 4) {
    const stem = word.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    undouble(stem);
  }

  if (word.endsWith('ily') && word.length > 5) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ly') && word.length > 4) {
    const stem = word.slice(0, -2);
    add(stem);
    add(`${stem}e`);
  }
  if (word.endsWith('ness') && word.length > 6) {
    add(word.slice(0, -4));
    if (word.endsWith('iness')) add(`${word.slice(0, -5)}y`);
  }

  return candidates;
}

async function indexedLookupCandidates(cleanWord) {
  const candidates = [cleanWord, ...generateLemmaCandidates(cleanWord)];
  try {
    const index = await loadWordIndex();
    const present = candidates.filter((candidate) => indexContains(index, candidate));
    // If the local sitemap snapshot knows no candidate, still try the original
    // once so recently-added DictAI entries continue to work.
    return present.length ? present : [cleanWord];
  } catch (error) {
    console.warn('DictAI word index unavailable; using bounded rule fallback:', error);
    return candidates.slice(0, 4);
  }
}

function normalizeProvider(provider) {
  return provider === 'wiktionary' ? 'wiktionary' : 'dictai';
}

async function resolveIndexedLemma(cleanWord) {
  const candidates = await indexedLookupCandidates(cleanWord);
  return candidates[0] || cleanWord;
}

/**
 * Resolves inflections locally before making a bounded DictAI request.
 */
async function handleFetchDictHtml(word) {
  if (!word) throw new LookupError('No word provided', 'invalid');
  const cleanWord = word.trim().toLowerCase();

  if (dictCache.has(cleanWord)) return dictCache.get(cleanWord);
  if (pendingFetches.has(cleanWord)) return pendingFetches.get(cleanWord);

  const fetchPromise = (async () => {
    const persisted = await readPersistentCache(cleanWord);
    if (persisted) {
      rememberInMemory(cleanWord, persisted);
      return persisted;
    }

    const candidates = await indexedLookupCandidates(cleanWord);
    let lastNotFound = null;
    for (const candidate of candidates) {
      try {
        const html = await fetchAndProcessWord(candidate);
        const result = {
          html,
          requestedWord: cleanWord,
          resolvedWord: candidate
        };
        rememberInMemory(cleanWord, result);
        writePersistentCache(cleanWord, result).catch(() => {});
        return result;
      } catch (error) {
        if (error && error.kind === 'not_found') {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }
    throw lastNotFound || new LookupError(
      `DictAI word "${cleanWord}" not found`,
      'not_found',
      404
    );
  })();

  pendingFetches.set(cleanWord, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (pendingFetches.get(cleanWord) === fetchPromise) {
      pendingFetches.delete(cleanWord);
    }
  }
}

async function handleFetchWiktionaryHtml(word, useApiFallback = false) {
  if (!word) throw new LookupError('No word provided', 'invalid');
  const cleanWord = word.trim().toLowerCase();
  const transport = useApiFallback ? 'api' : 'page';
  const cacheKey = `${transport}:${cleanWord}`;

  if (wiktionaryCache.has(cacheKey)) return wiktionaryCache.get(cacheKey);
  if (pendingWiktionaryFetches.has(cacheKey)) {
    return pendingWiktionaryFetches.get(cacheKey);
  }

  const fetchPromise = (async () => {
    const resolvedWord = await resolveIndexedLemma(cleanWord);
    const html = useApiFallback
      ? await fetchWiktionaryEnglishSection(resolvedWord)
      : await fetchWiktionaryPage(resolvedWord);
    const result = {
      html,
      requestedWord: cleanWord,
      resolvedWord,
      transport
    };
    if (wiktionaryCache.has(cacheKey)) wiktionaryCache.delete(cacheKey);
    wiktionaryCache.set(cacheKey, result);
    if (wiktionaryCache.size > MAX_CACHE_SIZE * 2) {
      wiktionaryCache.delete(wiktionaryCache.keys().next().value);
    }
    return result;
  })();

  pendingWiktionaryFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (pendingWiktionaryFetches.get(cacheKey) === fetchPromise) {
      pendingWiktionaryFetches.delete(cacheKey);
    }
  }
}

async function fetchWiktionaryPage(resolvedWord) {
  const url = `https://en.wiktionary.org/wiki/${encodeURIComponent(resolvedWord)}`;
  const response = await fetchWithTimeout(
    url,
    {
      cache: 'force-cache',
      headers: {
        'Accept': 'text/html,application/xhtml+xml'
      }
    },
    WIKTIONARY_FETCH_TIMEOUT_MS
  );
  if (response.status === 404) {
    throw new LookupError(
      `Wiktionary page not found for "${resolvedWord}"`,
      'not_found',
      404
    );
  }
  if (!response.ok) {
    throw new LookupError(
      `Wiktionary request failed (status ${response.status})`,
      'network',
      response.status
    );
  }
  const html = await response.text();
  if (!html) {
    throw new LookupError('Wiktionary returned an empty page', 'network');
  }
  return html;
}

async function fetchWiktionaryEnglishSection(resolvedWord) {
  const sectionsPayload = await fetchWiktionaryApi({
    action: 'parse',
    page: resolvedWord,
    prop: 'sections',
    redirects: '1'
  });
  const sections =
    sectionsPayload && sectionsPayload.parse && Array.isArray(sectionsPayload.parse.sections)
      ? sectionsPayload.parse.sections
      : [];
  const englishSection = sections.find(
    (section) =>
      String(section.line || '').trim().toLowerCase() === 'english' &&
      String(section.level || '') === '2'
  );
  if (!englishSection) {
    throw new LookupError(
      `Wiktionary has no English entry for "${resolvedWord}"`,
      'not_found',
      404
    );
  }

  const textPayload = await fetchWiktionaryApi({
    action: 'parse',
    page: resolvedWord,
    prop: 'text',
    section: String(englishSection.index),
    redirects: '1'
  });
  const html =
    textPayload && textPayload.parse && typeof textPayload.parse.text === 'string'
      ? textPayload.parse.text
      : '';
  if (!html) {
    throw new LookupError(
      `Wiktionary returned no English definitions for "${resolvedWord}"`,
      'not_found',
      404
    );
  }
  return html;
}

async function fetchWiktionaryApi(parameters) {
  const url = new URL('https://en.wiktionary.org/w/api.php');
  const query = {
    ...parameters,
    format: 'json',
    formatversion: '2',
    origin: '*'
  };
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithTimeout(
    url.toString(),
    {
      cache: 'force-cache',
      headers: {
        'Accept': 'application/json'
      }
    },
    WIKTIONARY_FETCH_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new LookupError(
      `Wiktionary request failed (status ${response.status})`,
      response.status === 404 ? 'not_found' : 'network',
      response.status
    );
  }

  const payload = await response.json();
  if (payload && payload.error) {
    const missing = payload.error.code === 'missingtitle';
    throw new LookupError(
      missing
        ? `Wiktionary page not found`
        : (payload.error.info || 'Wiktionary API request failed'),
      missing ? 'not_found' : 'network',
      missing ? 404 : 0
    );
  }
  return payload;
}

function rememberInMemory(word, result) {
  if (dictCache.has(word)) dictCache.delete(word);
  dictCache.set(word, result);

  if (dictCache.size > MAX_CACHE_SIZE) {
    dictCache.delete(dictCache.keys().next().value);
  }
}

function persistentCacheUrl(word) {
  return `https://dictai-extension-cache.invalid/v2/${encodeURIComponent(word)}`;
}

async function readPersistentCache(word) {
  if (typeof caches === 'undefined') return null;

  try {
    const cache = await caches.open(PERSISTENT_CACHE_NAME);
    const response = await cache.match(persistentCacheUrl(word));
    if (!response) return null;

    const cachedAt = Number(response.headers.get('x-dictai-cached-at'));
    if (!cachedAt || Date.now() - cachedAt > PERSISTENT_CACHE_TTL_MS) {
      await cache.delete(persistentCacheUrl(word));
      return null;
    }
    return {
      html: await response.text(),
      requestedWord: word,
      resolvedWord: response.headers.get('x-dictai-resolved-word') || word
    };
  } catch (_) {
    return null;
  }
}

async function writePersistentCache(word, result) {
  if (typeof caches === 'undefined' || typeof Response === 'undefined') return;

  try {
    const cache = await caches.open(PERSISTENT_CACHE_NAME);
    await cache.put(
      persistentCacheUrl(word),
      new Response(result.html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-dictai-cached-at': String(Date.now()),
          'x-dictai-resolved-word': result.resolvedWord
        }
      })
    );

    persistentCacheWrites += 1;
    if (persistentCacheWrites % 25 === 0) {
      const keys = await cache.keys();
      const excess = keys.length - MAX_CACHE_SIZE;
      for (let index = 0; index < excess; index += 1) {
        await cache.delete(keys[index]);
      }
    }
  } catch (_) {
    // CacheStorage is an optional acceleration; memory caching still works.
  }
}

/**
 * Internal helper to fetch and clean DictAI page HTML
 */
async function fetchAndProcessWord(cleanWord) {
  const cssPromise = preloadEtymologyCss();

  const url = `https://www.dictai.org/w/${encodeURIComponent(cleanWord)}`;

  const response = await fetchWithTimeout(url, {
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': navigator.userAgent
    }
  }, DICT_FETCH_TIMEOUT_MS);

  if (response.status === 404) {
    throw new LookupError(
      `DictAI word "${cleanWord}" not found (status 404)`,
      'not_found',
      404
    );
  }
  if (!response.ok) {
    throw new LookupError(
      `DictAI request failed (status ${response.status})`,
      'network',
      response.status
    );
  }

  const [rawHtml, etymologyCss] = await Promise.all([
    response.text(),
    cssPromise
  ]);

  // Check if HTML content itself indicates 404 / Not Found
  if (
    rawHtml.includes('<title>404') ||
    rawHtml.includes('404 Not Found') ||
    rawHtml.includes('Page Not Found')
  ) {
    throw new LookupError(
      `DictAI word "${cleanWord}" returned 404 page content`,
      'not_found',
      404
    );
  }

  return prepareDefinitionHtml(rawHtml, etymologyCss);
}

async function fetchAiDefinition(word) {
  if (!word) throw new LookupError('No word provided', 'invalid');
  const cleanWord = word.trim().toLowerCase();
  if (aiCache.has(cleanWord)) return aiCache.get(cleanWord);
  if (pendingAiFetches.has(cleanWord)) return pendingAiFetches.get(cleanWord);

  const request = (async () => {
    let response;
    try {
      response = await fetchWithTimeout(AI_FALLBACK_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-DictAI-Extension': '1'
        },
        body: JSON.stringify({ word: cleanWord })
      }, AI_FETCH_TIMEOUT_MS);
    } catch (error) {
      if (error && error.kind === 'timeout') {
        throw new LookupError('Google AI Mode fallback timed out', 'ai_timeout');
      }
      throw new LookupError(
        'Google AI Mode fallback service is not running',
        'ai_unavailable'
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {}
    if (!response.ok || !payload || !payload.success || !payload.definition) {
      throw new LookupError(
        (payload && payload.error) || `AI fallback failed (status ${response.status})`,
        'ai_error',
        response.status
      );
    }

    const definition = String(payload.definition).trim();
    if (!definition) throw new LookupError('AI fallback returned an empty response', 'ai_error');
    const result = {
      definition,
      chatId: payload.chatId ? String(payload.chatId) : ''
    };
    rememberAiDefinition(cleanWord, result);
    return result;
  })();

  pendingAiFetches.set(cleanWord, request);
  try {
    return await request;
  } finally {
    if (pendingAiFetches.get(cleanWord) === request) {
      pendingAiFetches.delete(cleanWord);
    }
  }
}

function rememberAiDefinition(word, result) {
  if (aiCache.has(word)) aiCache.delete(word);
  aiCache.set(word, result);
  if (aiCache.size > MAX_CACHE_SIZE) {
    aiCache.delete(aiCache.keys().next().value);
  }
}

async function showAiChat(chatId) {
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
    throw new LookupError('This AI Mode conversation is no longer available', 'ai_chat_expired');
  }

  let response;
  try {
    response = await fetchWithTimeout(
      AI_FALLBACK_URL.replace('/v1/define', '/v1/show-chat'),
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-DictAI-Extension': '1'
        },
        body: JSON.stringify({ chatId })
      },
      5000
    );
  } catch (_) {
    throw new LookupError('Google AI Mode fallback service is not running', 'ai_unavailable');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}
  if (!response.ok || !payload || !payload.success) {
    throw new LookupError(
      (payload && payload.error) || 'Could not open the AI Mode conversation',
      'ai_chat_expired',
      response.status
    );
  }
}

function prepareDefinitionHtml(rawHtml, etymologyCss) {
  let html = rawHtml
    // The definition is static. Removing every script eliminates analytics,
    // fingerprinting, Cloudflare injection, and iframe main-thread work.
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // This server-generated list dominates the document size but is not part
    // of the selected word's definition.
    .replace(/<!-- RELATED_WORDS_START -->[\s\S]*?<!-- RELATED_WORDS_END -->/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '');

  const baseTag = '<base href="https://www.dictai.org/">';
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, `<head$1>${baseTag}`);
  } else {
    html = `${baseTag}${html}`;
  }

  if (etymologyCss) {
    html = html.replace(
      /<link\b(?=[^>]*\brel=["']?stylesheet["']?)[^>]*\bhref=["'][^"']*etymology\.css[^"']*["'][^>]*>/gi,
      `<style>${etymologyCss}</style>`
    );
  }

  return html;
}

/**
 * Helper to retrieve stored settings
 */
async function getSettings() {
  try {
    const stored = await extAPI.storage.sync.get(null);
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (err) {
    const stored = await extAPI.storage.local.get(null);
    return { ...DEFAULT_SETTINGS, ...stored };
  }
}
