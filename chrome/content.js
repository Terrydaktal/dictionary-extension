/**
 * DictAI Dictionary Extension - Content Script
 * High-Performance Edition: Supports speculative mousedown pre-fetching and instant rendering.
 * Triggers on double-click selection of a word and displays a separate popup window positioned right below the word.
 * Cross-browser compatible (Firefox & Chrome).
 */

(function () {
  'use strict';

  const isFirefox = typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined';
  const extAPI = isFirefox ? browser : chrome;

  // Extension State
  let shadowHost = null;
  let shadowRoot = null;
  let popupElement = null;
  let currentWord = '';
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let lastPrefetchWord = '';
  let lastPrefetchAt = 0;

  // User Settings Cache - default displayMode set to separate_window
  let settings = {
    enabled: true,
    triggerMode: 'dblclick', // 'dblclick' or 'alt_dblclick'
    displayMode: 'separate_window', // 'separate_window' (standalone OS popup window) or 'in_page' (floating card)
    popupWidth: 480,
    popupHeight: 520,
    theme: 'system',
    allowInInputs: false,
    dictionaryProvider: 'dictai',
    hidePopupHeader: false
  };

  // Helper for cross-browser messaging (Promise-based for Firefox, callback fallback for Chrome)
  async function sendMessageAsync(msg) {
    if (isFirefox && browser.runtime && browser.runtime.sendMessage) {
      try {
        const res = await browser.runtime.sendMessage(msg);
        return res;
      } catch (e) {
        // Fallback
      }
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Load initial settings
  loadSettings();

  // Listen for settings changes
  try {
    extAPI.storage.onChanged.addListener((changes) => {
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in settings) {
          settings[key] = newValue;
        }
      }
      if (changes.hidePopupHeader && popupElement) {
        popupElement.classList.toggle(
          'dictai-header-hidden',
          changes.hidePopupHeader.newValue === true
        );
      }
    });
  } catch (e) {
    // Ignore storage listener errors
  }

  async function loadSettings() {
    try {
      const response = await sendMessageAsync({ action: 'GET_SETTINGS' });
      if (response && response.settings) {
        settings = { ...settings, ...response.settings };
      }
    } catch (e) {
      // Fallback defaults
    }
  }

  // Bind event listeners for double-click word highlighting and speculative prefetching
  document.addEventListener('dblclick', handleDoubleClick, true);
  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('keydown', handleKeyDown, true);

  /**
   * Speculative Prefetch Handler on Mouse Down
   * Initiates network fetch ~200ms before dblclick completes for zero-wait rendering.
   */
  function handleMouseDown(e) {
    if (!settings.enabled) return;
    handleOutsideClick(e);

    // Resolve the word under the pointer before the browser finishes the first
    // click. This starts the network request a full click ahead of dblclick.
    const pointerWord = getWordAtPoint(e.clientX, e.clientY);
    if (pointerWord) {
      prefetchWord(pointerWord);
      return;
    }

    const selection = window.getSelection();
    if (selection) {
      const rawText = selection.toString();
      const word = extractSingleWord(rawText);
      if (word) {
        prefetchWord(word);
      }
    }
  }

  function prefetchWord(word) {
    const now = performance.now();
    if (word === lastPrefetchWord && now - lastPrefetchAt < 2000) return;

    lastPrefetchWord = word;
    lastPrefetchAt = now;
    sendMessageAsync({
      action: 'PREFETCH_DICT_HTML',
      word,
      provider: settings.dictionaryProvider
    });
  }

  /**
   * Extracts the word at a viewport point without changing page selection.
   * Firefox exposes caretPositionFromPoint; Chromium uses caretRangeFromPoint.
   */
  function getWordAtPoint(clientX, clientY) {
    let textNode = null;
    let offset = 0;

    try {
      if (typeof document.caretPositionFromPoint === 'function') {
        const caret = document.caretPositionFromPoint(clientX, clientY);
        textNode = caret && caret.offsetNode;
        offset = caret ? caret.offset : 0;
      } else if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(clientX, clientY);
        textNode = range && range.startContainer;
        offset = range ? range.startOffset : 0;
      }
    } catch (_) {
      return null;
    }

    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !textNode.textContent) {
      return null;
    }

    const text = textNode.textContent;
    const isWordCharacter = (character) => /[\p{L}\p{N}\p{M}'’-]/u.test(character);

    if (offset >= text.length || !isWordCharacter(text[offset])) {
      if (offset > 0 && isWordCharacter(text[offset - 1])) {
        offset -= 1;
      } else {
        return null;
      }
    }

    let start = offset;
    let end = offset + 1;
    while (start > 0 && isWordCharacter(text[start - 1])) start -= 1;
    while (end < text.length && isWordCharacter(text[end])) end += 1;

    return extractSingleWord(text.slice(start, end));
  }

  /**
   * Main Double-Click Handler
   */
  function handleDoubleClick(e) {
    if (!settings.enabled) return;

    // Check modifier key condition if set to alt_dblclick
    if (settings.triggerMode === 'alt_dblclick' && !e.altKey) {
      return;
    }

    // Ignore editable inputs unless explicitly allowed in settings
    const target = e.target;
    const isEditable =
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA';

    if (isEditable && !settings.allowInInputs) {
      return;
    }

    const clickPosition = {
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY
    };

    // dblclick fires after the second mousedown has updated selection. A
    // microtask preserves that ordering without adding an artificial timer.
    queueMicrotask(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const rawText = selection.toString();
      const word = extractSingleWord(rawText);

      if (!word) return;

      // Correct a speculative miss without duplicating an in-flight request.
      prefetchWord(word);

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      // Check user setting for separate window vs in-page popup card
      if (settings.displayMode !== 'in_page') {
        openSeparateWindowBelowWord(word, rect, clickPosition, e);
      } else {
        // Show floating in-page dictionary popup card
        showPopup(word, rect, e);
      }
    });
  }

  /**
   * Opens standalone native OS window positioned JUST BELOW the highlighted word using Wayland coordinates
   */
  async function openSeparateWindowBelowWord(word, rect, clickPosition, mouseEvent) {
    const popupWidth = settings.popupWidth || 480;
    const popupHeight = settings.popupHeight || 520;

    let wordScreenX;
    let wordScreenTop;
    let wordScreenBottom;

    // screenX/screenY and clientX/clientY come from the same pointer event, so
    // their delta gives the viewport's screen origin without guessing browser
    // toolbar height. This is the most accurate coordinate source on Wayland.
    const hasPointerCoordinates =
      clickPosition &&
      Number.isFinite(clickPosition.screenX) &&
      Number.isFinite(clickPosition.screenY) &&
      Number.isFinite(clickPosition.clientX) &&
      Number.isFinite(clickPosition.clientY);

    if (hasPointerCoordinates) {
      const viewportScreenX = clickPosition.screenX - clickPosition.clientX;
      const viewportScreenY = clickPosition.screenY - clickPosition.clientY;
      wordScreenX = Math.round(viewportScreenX + rect.left + (rect.width / 2));
      wordScreenTop = Math.round(viewportScreenY + rect.top);
      wordScreenBottom = Math.round(viewportScreenY + rect.bottom);
    } else if (
      Number.isFinite(window.mozInnerScreenX) &&
      Number.isFinite(window.mozInnerScreenY)
    ) {
      wordScreenX = Math.round(window.mozInnerScreenX + rect.left + (rect.width / 2));
      wordScreenTop = Math.round(window.mozInnerScreenY + rect.top);
      wordScreenBottom = Math.round(window.mozInnerScreenY + rect.bottom);
    } else {
      const chromeTopHeight = Math.max(35, window.outerHeight - window.innerHeight);
      wordScreenX = Math.round(window.screenX + rect.left + (rect.width / 2));
      wordScreenTop = Math.round(window.screenY + chromeTopHeight + rect.top);
      wordScreenBottom = Math.round(window.screenY + chromeTopHeight + rect.bottom);
    }

    if (!Number.isFinite(wordScreenX)) {
      wordScreenX = Number.isFinite(clickPosition && clickPosition.screenX)
        ? clickPosition.screenX
        : 100;
    }
    if (!Number.isFinite(wordScreenTop)) {
      wordScreenTop = Number.isFinite(clickPosition && clickPosition.screenY)
        ? clickPosition.screenY
        : 100;
    }
    if (!Number.isFinite(wordScreenBottom)) {
      wordScreenBottom = wordScreenTop + Math.max(rect.height, 1);
    }

    let winLeft = Math.round(wordScreenX - (popupWidth / 2));
    let winTop = Math.round(wordScreenBottom + 8);

    const screenLeft = window.screen.availLeft || 0;
    const screenTop = window.screen.availTop || 0;
    const screenWidth = window.screen.availWidth || window.screen.width || 1920;
    const screenHeight = window.screen.availHeight || window.screen.height || 1080;

    const viewportPadding = 12;
    let relativeLeft = Math.round(rect.left + (rect.width / 2) - (popupWidth / 2));
    relativeLeft = Math.max(
      viewportPadding,
      Math.min(relativeLeft, window.innerWidth - popupWidth - viewportPadding)
    );

    let relativeTop = Math.round(rect.bottom + 8);
    if (relativeTop + popupHeight > window.innerHeight - viewportPadding) {
      relativeTop = Math.round(rect.top - popupHeight - 8);
    }
    relativeTop = Math.max(
      viewportPadding,
      Math.min(relativeTop, window.innerHeight - popupHeight - viewportPadding)
    );

    const cursorOffsetX =
      clickPosition && Number.isFinite(clickPosition.clientX)
        ? relativeLeft - clickPosition.clientX
        : Math.round(-popupWidth / 2);
    const cursorOffsetY =
      clickPosition && Number.isFinite(clickPosition.clientY)
        ? relativeTop - clickPosition.clientY
        : 18;

    // KWin combines these viewport-relative coordinates with the source
    // Firefox window's compositor-known geometry. Unlike screenX/screenY,
    // this remains exact on native Wayland.
    const viewportInsetX = Math.max(
      0,
      Math.round((window.outerWidth - window.innerWidth) / 2)
    );
    const viewportInsetY = Math.max(
      0,
      Math.round(window.outerHeight - window.innerHeight - viewportInsetX)
    );

    winLeft = Math.max(screenLeft + 10, Math.min(winLeft, screenLeft + screenWidth - popupWidth - 10));

    if (winTop + popupHeight > screenTop + screenHeight - 15) {
      winTop = Math.round(wordScreenTop - popupHeight - 8);
    }
    winTop = Math.max(screenTop + 10, winTop);

    const response = await sendMessageAsync({
      action: 'OPEN_WINDOW_POPUP',
      word,
      left: winLeft,
      top: winTop,
      width: popupWidth,
      height: popupHeight,
      relativeLeft,
      relativeTop,
      viewportInsetX,
      viewportInsetY,
      cursorOffsetX,
      cursorOffsetY,
      provider: settings.dictionaryProvider,
      hidePopupHeader: settings.hidePopupHeader === true
    });

    // Never substitute an in-page card for separate-window mode. KWin's
    // DictAI positioner handles native Wayland coordinates from the window
    // title marker embedded by popup_frame.js.
    if (!response || !response.success) {
      console.warn('Could not open the separate DictAI window.');
    }
  }

  /**
   * Cleans and validates single word selection. Converts word to lower case.
   * Ensures no spaces, strips punctuation at boundaries, keeps valid word chars.
   */
  function extractSingleWord(rawText) {
    if (!rawText) return null;

    let trimmed = rawText.trim();
    if (!trimmed || trimmed.length > 50) return null;

    // Strip surrounding punctuation & quotes and convert to lowercase
    const cleaned = trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();

    if (!cleaned || cleaned.length === 0) return null;

    // Reject if contains whitespace (multiple words) or internal linebreaks
    if (/\s/.test(cleaned)) return null;

    // Reject pure single-character punctuation or invalid symbols
    if (!/^[\p{L}\p{N}\p{M}'-]+$/u.test(cleaned)) return null;

    return cleaned;
  }

  /**
   * Creates or gets the Shadow DOM container for popup isolation
   */
  function ensureShadowDOM() {
    if (shadowHost && shadowRoot) return;

    shadowHost = document.createElement('div');
    shadowHost.id = 'dictai-extension-shadow-host';
    shadowHost.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';

    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    // Inject Stylesheet into Shadow DOM
    const style = document.createElement('style');
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);

    document.documentElement.appendChild(shadowHost);
  }

  /**
   * Display floating popup near target word rectangle
   */
  function showPopup(word, targetRect, mouseEvent) {
    currentWord = word.toLowerCase();
    ensureShadowDOM();

    // Remove existing popup if open
    hidePopup();

    popupElement = document.createElement('div');
    popupElement.className =
      `dictai-popup ${getThemeClass()}` +
      (settings.hidePopupHeader ? ' dictai-header-hidden' : '');
    popupElement.setAttribute('role', 'dialog');
    popupElement.setAttribute('aria-label', `Dictionary definition for ${currentWord}`);

    const provider =
      settings.dictionaryProvider === 'wiktionary' ? 'wiktionary' : 'dictai';
    const providerName = provider === 'wiktionary' ? 'Wiktionary' : 'DictAI';
    const providerHome =
      provider === 'wiktionary' ? 'https://en.wiktionary.org' : 'https://www.dictai.org';
    const wordUrl =
      provider === 'wiktionary'
        ? `https://en.wiktionary.org/wiki/${encodeURIComponent(currentWord)}#English`
        : `https://www.dictai.org/w/${encodeURIComponent(currentWord)}`;

    popupElement.innerHTML = `
      <div class="dictai-header" id="dictai-drag-handle">
        <div class="dictai-brand">
          <svg class="dictai-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" rx="6" fill="url(#dictai-grad)"/>
            <path d="M7 6H13C15.2091 6 17 7.79086 17 10C17 12.2091 15.2091 14 13 14H7V6Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
            <path d="M7 6V18" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <defs>
              <linearGradient id="dictai-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                <stop stop-color="#6366F1"/>
                <stop offset="1" stop-color="#06B6D4"/>
              </linearGradient>
            </defs>
          </svg>
          <span class="dictai-brand-text">DictAI</span>
        </div>
        <div class="dictai-word-pill" title="Selected word">${escapeHtml(currentWord)}</div>
        <div class="dictai-actions">
          <button class="dictai-icon-btn" id="btn-pop-window" title="Pop out into separate OS window">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
            </svg>
          </button>
          <button class="dictai-icon-btn" id="btn-open-tab" title="Open page in new tab">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </button>
          <button class="dictai-icon-btn dictai-close-btn" id="btn-close" title="Close (Esc)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="dictai-body">
        <div class="dictai-loader" id="dictai-loader">
          <div class="dictai-spinner"></div>
          <div class="dictai-loader-text">Loading definition for <strong>"${escapeHtml(currentWord)}"</strong>...</div>
        </div>
        <iframe class="dictai-iframe" id="dictai-frame" frameborder="0" allow="autoplay; clipboard-write"></iframe>
        <div class="dictai-fallback" id="dictai-fallback" style="display:none;">
          <div class="dictai-fallback-msg">Could not load preview directly.</div>
          <a href="${wordUrl}" target="_blank" class="dictai-btn-action">Open on ${providerName} ↗</a>
        </div>
      </div>
      <div class="dictai-footer">
        <span class="dictai-footer-left">Definitions from <a href="${providerHome}" target="_blank" class="dictai-footer-link">${providerName}</a></span>
        <span class="dictai-drag-hint">Drag header to move</span>
      </div>
    `;

    shadowRoot.appendChild(popupElement);

    // Initial sizing
    const width = settings.popupWidth || 460;
    const height = settings.popupHeight || 440;
    popupElement.style.width = `${width}px`;
    popupElement.style.height = `${height}px`;

    // Position calculation JUST BELOW target word
    positionPopup(targetRect, width, height);

    // Event handlers inside Shadow Root
    const btnClose = popupElement.querySelector('#btn-close');
    const btnOpenTab = popupElement.querySelector('#btn-open-tab');
    const btnPopWindow = popupElement.querySelector('#btn-pop-window');
    const iframe = popupElement.querySelector('#dictai-frame');
    const loader = popupElement.querySelector('#dictai-loader');
    const fallback = popupElement.querySelector('#dictai-fallback');
    const header = popupElement.querySelector('#dictai-drag-handle');

    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePopup();
    });

    btnOpenTab.addEventListener('click', (e) => {
      e.stopPropagation();
      sendMessageAsync({
        action: 'OPEN_DICT_TAB',
        word: currentWord,
        provider
      });
    });

    btnPopWindow.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePopup();
      const clickPosition = mouseEvent ? {
        clientX: mouseEvent.clientX,
        clientY: mouseEvent.clientY,
        screenX: mouseEvent.screenX,
        screenY: mouseEvent.screenY
      } : null;
      openSeparateWindowBelowWord(currentWord, targetRect, clickPosition, mouseEvent);
    });

    // Header drag listeners
    header.addEventListener('mousedown', startDragging);

    // Load definition content via background script
    loadDefinition(currentWord, iframe, loader, fallback);
  }

  /**
   * Fetches DictAI page HTML via background script and renders in iframe srcdoc.
   * Strips anti-bot/Cloudflare scripts that cause iframe load hangs.
   */
  async function loadDefinition(word, iframe, loader, fallback) {
    let isDone = false;
    const cleanWord = word.trim().toLowerCase();

    const showFallback = () => {
      if (isDone) return;
      isDone = true;
      if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
      if (fallback) {
        fallback.classList.add('dictai-visible');
        fallback.style.setProperty('display', 'flex', 'important');
      }
    };

    // Hard 3.5s timer guard to ensure spinner NEVER hangs indefinitely under any network condition
    const safetyTimer = setTimeout(() => {
      showFallback();
    }, settings.dictionaryProvider === 'wiktionary' ? 18000 : 3500);

    const renderHtml = (rawHtml) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(safetyTimer);

      // HTML is sanitized, trimmed, and made self-contained once in the
      // background worker so this UI can paint it without another large parse.
      iframe.srcdoc = rawHtml;

      // Show iframe and remove loader overlay node entirely
      iframe.classList.add('dictai-visible');
      iframe.style.setProperty('display', 'block', 'important');

      if (fallback) {
        fallback.classList.remove('dictai-visible');
        fallback.style.setProperty('display', 'none', 'important');
      }

      if (loader && loader.parentNode) {
        loader.parentNode.removeChild(loader);
      }
    };

    // Use background script messaging (Works reliably across origins in Firefox and Chrome)
    try {
      let response = await sendMessageAsync({
        action: 'FETCH_DICT_HTML',
        word: cleanWord,
        provider: settings.dictionaryProvider
      });
      let renderedWiktionaryHtml = '';
      if (response && response.success && response.source === 'wiktionary') {
        try {
          renderedWiktionaryHtml = WiktionaryView.buildDocument(
            response.data,
            response.resolvedWord || cleanWord
          );
        } catch (_) {
          if (response.transport !== 'api') {
            const loaderText = loader && loader.querySelector('.dictai-loader-text');
            if (loaderText) loaderText.textContent = 'Retrying through the Wiktionary API...';
            response = await sendMessageAsync({
              action: 'FETCH_DICT_HTML',
              word: cleanWord,
              provider: 'wiktionary',
              wiktionaryApiFallback: true
            });
            if (response && response.success && response.data) {
              renderedWiktionaryHtml = WiktionaryView.buildDocument(
                response.data,
                response.resolvedWord || cleanWord
              );
            }
          }
        }
      }
      if (response && response.success && response.data) {
        let renderedHtml = response.data;
        if (response.source === 'wiktionary') {
          renderedHtml = renderedWiktionaryHtml;
          if (!renderedHtml) throw new Error('Could not extract English Wiktionary definitions');
          const wordPill = popupElement && popupElement.querySelector('.dictai-word-pill');
          if (wordPill && response.resolvedWord && response.resolvedWord !== cleanWord) {
            wordPill.textContent = `${cleanWord} → ${response.resolvedWord}`;
            wordPill.title = 'Selected word → resolved lemma';
          }
        }
        renderHtml(renderedHtml);
      } else {
        showFallback();
      }
    } catch (e) {
      showFallback();
    }
  }

  /**
   * Viewport positioning: places popup EXACTLY JUST BELOW the clicked word
   */
  function positionPopup(targetRect, popupWidth, popupHeight) {
    if (!popupElement) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const padding = 12;

    // Horizontal centering relative to word
    let left = targetRect.left + (targetRect.width / 2) - (popupWidth / 2);
    left = Math.max(padding, Math.min(left, viewportW - popupWidth - padding));

    // Vertical positioning: default to JUST BELOW the clicked word
    let top = targetRect.bottom + 8;

    // If not enough room below, place above target word
    if (top + popupHeight > viewportH - padding) {
      top = targetRect.top - popupHeight - 8;
    }

    // Clamp top position inside viewport
    top = Math.max(padding, Math.min(top, viewportH - popupHeight - padding));

    popupElement.style.left = `${left}px`;
    popupElement.style.top = `${top}px`;
  }

  /**
   * Draggable popup header implementation
   */
  function startDragging(e) {
    if (e.target.closest('.dictai-actions')) return; // Ignore close/link buttons

    isDragging = true;
    const rect = popupElement.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    document.addEventListener('mousemove', onDragging, true);
    document.addEventListener('mouseup', stopDragging, true);
    e.preventDefault();
  }

  function onDragging(e) {
    if (!isDragging || !popupElement) return;

    let newLeft = e.clientX - dragOffsetX;
    let newTop = e.clientY - dragOffsetY;

    // Viewport bounds
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const rect = popupElement.getBoundingClientRect();

    newLeft = Math.max(0, Math.min(newLeft, viewportW - rect.width));
    newTop = Math.max(0, Math.min(newTop, viewportH - rect.height));

    popupElement.style.left = `${newLeft}px`;
    popupElement.style.top = `${newTop}px`;
  }

  function stopDragging() {
    isDragging = false;
    document.removeEventListener('mousemove', onDragging, true);
    document.removeEventListener('mouseup', stopDragging, true);
  }

  /**
   * Close popup on outside click
   */
  function handleOutsideClick(e) {
    if (!popupElement) return;

    // Check if click was inside shadow host
    if (shadowHost && shadowHost.contains(e.target)) {
      return;
    }

    hidePopup();
  }

  /**
   * Close popup on Escape key
   */
  function handleKeyDown(e) {
    if (e.key === 'Escape' && popupElement) {
      hidePopup();
    }
  }

  /**
   * Hide and remove floating popup
   */
  function hidePopup() {
    if (popupElement) {
      popupElement.classList.add('dictai-closing');
      setTimeout(() => {
        if (popupElement && popupElement.parentNode) {
          popupElement.parentNode.removeChild(popupElement);
        }
        popupElement = null;
      }, 150);
    }
  }

  /**
   * Determine theme class based on settings or system dark mode
   */
  function getThemeClass() {
    if (settings.theme === 'dark') return 'dictai-theme-dark';
    if (settings.theme === 'light') return 'dictai-theme-light';
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dictai-theme-dark' : 'dictai-theme-light';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Isolated CSS styles to be injected inside Shadow DOM
   */
  function getShadowStyles() {
    return `
      :host {
        all: initial !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      }
      
      .dictai-popup {
        position: fixed !important;
        pointer-events: auto !important;
        display: flex !important;
        flex-direction: column !important;
        background: #ffffff !important;
        color: #0f172a !important;
        border-radius: 14px !important;
        box-shadow: 0 20px 45px -10px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.08) !important;
        overflow: hidden !important;
        z-index: 2147483647 !important;
        animation: dictai-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
        box-sizing: border-box !important;
      }

      .dictai-popup.dictai-closing {
        animation: dictai-fade-out 0.15s ease-in forwards !important;
      }

      .dictai-popup.dictai-theme-dark {
        background: #0f172a !important;
        color: #f8fafc !important;
        box-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
      }

      @keyframes dictai-fade-in {
        from { opacity: 0; transform: scale(0.96) translateY(6px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }

      @keyframes dictai-fade-out {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0; transform: scale(0.96); }
      }

      /* Header Bar */
      .dictai-header {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 10px 14px !important;
        background: rgba(248, 250, 252, 0.95) !important;
        border-bottom: 1px solid rgba(226, 232, 240, 0.8) !important;
        cursor: move !important;
        user-select: none !important;
      }

      .dictai-theme-dark .dictai-header {
        background: rgba(30, 41, 59, 0.95) !important;
        border-bottom: 1px solid rgba(51, 65, 85, 0.8) !important;
      }

      .dictai-popup.dictai-header-hidden .dictai-header {
        display: none !important;
      }

      .dictai-brand {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }

      .dictai-logo {
        width: 22px !important;
        height: 22px !important;
        flex-shrink: 0 !important;
      }

      .dictai-brand-text {
        font-weight: 700 !important;
        font-size: 13px !important;
        background: linear-gradient(135deg, #4f46e5, #06b6d4) !important;
        -webkit-background-clip: text !important;
        -webkit-text-fill-color: transparent !important;
        letter-spacing: -0.2px !important;
      }

      .dictai-word-pill {
        background: rgba(99, 102, 241, 0.1) !important;
        color: #4f46e5 !important;
        font-weight: 600 !important;
        font-size: 13px !important;
        padding: 3px 10px !important;
        border-radius: 20px !important;
        max-width: 160px !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        border: 1px solid rgba(99, 102, 241, 0.2) !important;
      }

      .dictai-theme-dark .dictai-word-pill {
        background: rgba(129, 140, 248, 0.15) !important;
        color: #a5b4fc !important;
        border: 1px solid rgba(129, 140, 248, 0.3) !important;
      }

      .dictai-actions {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
      }

      .dictai-icon-btn {
        background: transparent !important;
        border: none !important;
        color: #64748b !important;
        padding: 5px !important;
        border-radius: 6px !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: all 0.15s ease !important;
        outline: none !important;
      }

      .dictai-icon-btn:hover {
        background: rgba(226, 232, 240, 0.7) !important;
        color: #0f172a !important;
      }

      .dictai-theme-dark .dictai-icon-btn:hover {
        background: rgba(51, 65, 85, 0.8) !important;
        color: #f8fafc !important;
      }

      .dictai-close-btn:hover {
        background: rgba(239, 68, 68, 0.15) !important;
        color: #ef4444 !important;
      }

      /* Body Area */
      .dictai-body {
        position: relative !important;
        flex: 1 !important;
        width: 100% !important;
        height: 100% !important;
        background: #ffffff !important;
        overflow: hidden !important;
      }

      .dictai-theme-dark .dictai-body {
        background: #0f172a !important;
      }

      .dictai-iframe {
        width: 100% !important;
        height: 100% !important;
        border: none !important;
        display: none;
      }

      .dictai-iframe.dictai-visible {
        display: block !important;
      }

      /* Loader Overlay */
      .dictai-loader {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        display: flex;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 12px !important;
        background: rgba(255, 255, 255, 0.95) !important;
        z-index: 10 !important;
      }

      .dictai-theme-dark .dictai-loader {
        background: rgba(15, 23, 42, 0.95) !important;
      }

      .dictai-spinner {
        width: 32px !important;
        height: 32px !important;
        border: 3px solid rgba(99, 102, 241, 0.2) !important;
        border-top-color: #4f46e5 !important;
        border-radius: 50% !important;
        animation: dictai-spin 0.8s linear infinite !important;
      }

      @keyframes dictai-spin {
        to { transform: rotate(360deg); }
      }

      .dictai-loader-text {
        font-size: 13px !important;
        color: #64748b !important;
      }

      .dictai-theme-dark .dictai-loader-text {
        color: #94a3b8 !important;
      }

      /* Fallback UI */
      .dictai-fallback {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        display: none;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 14px !important;
        padding: 24px !important;
        text-align: center !important;
        z-index: 5 !important;
      }

      .dictai-fallback.dictai-visible {
        display: flex !important;
      }

      .dictai-fallback-msg {
        font-size: 14px !important;
        color: #64748b !important;
      }

      .dictai-btn-action {
        background: #4f46e5 !important;
        color: #ffffff !important;
        border: none !important;
        padding: 8px 16px !important;
        border-radius: 8px !important;
        font-weight: 600 !important;
        font-size: 13px !important;
        cursor: pointer !important;
        text-decoration: none !important;
        transition: background 0.15s ease !important;
      }

      .dictai-btn-action:hover {
        background: #4338ca !important;
      }

      /* Footer */
      .dictai-footer {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 6px 14px !important;
        background: rgba(248, 250, 252, 0.95) !important;
        border-top: 1px solid rgba(226, 232, 240, 0.8) !important;
        font-size: 11px !important;
        color: #94a3b8 !important;
        user-select: none !important;
      }

      .dictai-theme-dark .dictai-footer {
        background: rgba(30, 41, 59, 0.95) !important;
        border-top: 1px solid rgba(51, 65, 85, 0.8) !important;
        color: #64748b !important;
      }

      .dictai-footer-link {
        color: #4f46e5 !important;
        text-decoration: none !important;
        font-weight: 600 !important;
      }

      .dictai-theme-dark .dictai-footer-link {
        color: #818cf8 !important;
      }

      .dictai-drag-hint {
        font-size: 10px !important;
        opacity: 0.7 !important;
      }

      .dictai-popup.dictai-header-hidden .dictai-drag-hint {
        display: none !important;
      }
    `;
  }
})();
