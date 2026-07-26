/**
 * DictAI Standalone Window Script
 * Handles rendering the DictAI definition inside a standalone detachable browser window.
 * Converts words to lower case.
 */

document.addEventListener('DOMContentLoaded', () => {
  const isFirefox =
    typeof browser !== 'undefined' &&
    browser.runtime &&
    typeof browser.runtime.getBrowserInfo === 'function';
  const extAPI = isFirefox ? browser : chrome;
  const MAX_POPUP_OUTER_HEIGHT = 450;

  const params = new URLSearchParams(window.location.search);
  const initialWord = (params.get('word') || 'dictionary').toLowerCase();
  const provider = params.get('provider') === 'wiktionary' ? 'wiktionary' : 'dictai';
  const providerName = provider === 'wiktionary' ? 'Wiktionary' : 'DictAI';
  const positionX = Number.parseInt(params.get('positionX'), 10);
  const positionY = Number.parseInt(params.get('positionY'), 10);
  const hidePopupHeader = params.get('hidePopupHeader') === 'true';
  const windowWidth = Number.parseInt(params.get('windowWidth'), 10);
  const windowHeight = Number.parseInt(params.get('windowHeight'), 10);
  const relativeX = Number.parseInt(params.get('relativeX'), 10);
  const relativeY = Number.parseInt(params.get('relativeY'), 10);
  const viewportInsetX = Number.parseInt(params.get('viewportInsetX'), 10);
  const viewportInsetY = Number.parseInt(params.get('viewportInsetY'), 10);
  const cursorOffsetX = Number.parseInt(params.get('cursorOffsetX'), 10);
  const cursorOffsetY = Number.parseInt(params.get('cursorOffsetY'), 10);
  const verticalAnchor =
    params.get('verticalAnchor') === 'bottom' ? 'bottom' : 'top';
  let normalWindowTitle = initialWord;
  let positionMarkerActive = false;
  let autoFitMarkerActive = false;
  let autoFitSequence = 0;

  document.body.classList.toggle('popup-header-hidden', hidePopupHeader);

  try {
    extAPI.storage.onChanged.addListener((changes) => {
      if (changes.hidePopupHeader) {
        document.body.classList.toggle(
          'popup-header-hidden',
          changes.hidePopupHeader.newValue === true
        );
        requestAnimationFrame(() => {
          if (lastMeasuredContentHeight > 0) {
            fitWindowToContent(lastMeasuredContentHeight);
          }
        });
      }
    });
  } catch (_) {
    // The initial URL parameter still applies if storage events are unavailable.
  }

  if (
    Number.isFinite(positionX) &&
    Number.isFinite(positionY) &&
    Number.isFinite(windowWidth) &&
    Number.isFinite(windowHeight) &&
    Number.isFinite(relativeX) &&
    Number.isFinite(relativeY) &&
    Number.isFinite(viewportInsetX) &&
    Number.isFinite(viewportInsetY) &&
    Number.isFinite(cursorOffsetX) &&
    Number.isFinite(cursorOffsetY)
  ) {
    // Native Wayland does not expose absolute positioning to Firefox. This
    // short-lived marker lets the installed KWin script identify and move only
    // this popup, while preserving a genuinely independent OS window.
    positionMarkerActive = true;
    document.title =
      `[DICTAI_POPUP|${positionX}|${positionY}|${windowWidth}|${windowHeight}` +
      `|${relativeX}|${relativeY}|${viewportInsetX}|${viewportInsetY}` +
      `|${cursorOffsetX}|${cursorOffsetY}|${verticalAnchor}] ${initialWord}`;

    let markerTimeout;
    const clearPositionMarker = () => {
      if (!positionMarkerActive) return;
      positionMarkerActive = false;
      clearTimeout(markerTimeout);
      window.removeEventListener('resize', clearMarkerWhenPositioned);
      if (!autoFitMarkerActive) {
        document.title = normalWindowTitle;
      }
    };
    const clearMarkerWhenPositioned = () => {
      if (
        Math.abs(window.outerWidth - windowWidth) <= 2 &&
        Math.abs(window.outerHeight - windowHeight) <= 2
      ) {
        clearPositionMarker();
      }
    };
    window.addEventListener('resize', clearMarkerWhenPositioned);
    markerTimeout = setTimeout(clearPositionMarker, 400);
    requestAnimationFrame(clearMarkerWhenPositioned);
  }

  const wordBadge = document.getElementById('word-badge');
  const sourceBadge = document.getElementById('source-badge');
  const searchInput = document.getElementById('window-search-input');
  const searchBtn = document.getElementById('window-search-btn');
  const linkExternal = document.getElementById('link-external');
  const frameContent = document.getElementById('frame-content');
  const loader = document.getElementById('window-loader');
  const loaderLabel = document.getElementById('loader-label');
  const aiContent = document.getElementById('ai-content');
  const aiDefinition = document.getElementById('ai-definition');
  const continueAiChat = document.getElementById('continue-ai-chat');
  const errorView = document.getElementById('window-error');
  const errorMessage = document.getElementById('error-message');
  const errorLink = document.getElementById('error-link');
  const retryButton = document.getElementById('retry-button');
  const windowHeader = document.querySelector('.window-header');
  let currentWord = initialWord;
  let currentChatId = '';
  let loadSequence = 0;
  let lastMeasuredContentHeight = 0;

  function updateCurrentWindowHeight(height) {
    if (isFirefox) {
      return browser.windows
        .getCurrent()
        .then((currentWindow) =>
          currentWindow && Number.isInteger(currentWindow.id)
            ? browser.windows.update(currentWindow.id, { height })
            : null
        )
        .catch(() => null);
    }

    return new Promise((resolve) => {
      try {
        chrome.windows.getCurrent({}, (currentWindow) => {
          if (
            chrome.runtime.lastError ||
            !currentWindow ||
            !Number.isInteger(currentWindow.id)
          ) {
            resolve(null);
            return;
          }
          chrome.windows.update(currentWindow.id, { height }, (updatedWindow) => {
            void chrome.runtime.lastError;
            resolve(updatedWindow || null);
          });
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function fitWindowToContent(contentHeight) {
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    lastMeasuredContentHeight = Math.ceil(contentHeight);

    const headerHeight =
      windowHeader && getComputedStyle(windowHeader).display !== 'none'
        ? Math.ceil(windowHeader.getBoundingClientRect().height)
        : 0;
    const nativeFrameHeight = Math.max(
      0,
      Math.round(window.outerHeight - window.innerHeight)
    );
    const targetHeight = Math.min(
      MAX_POPUP_OUTER_HEIGHT,
      Math.ceil(nativeFrameHeight + headerHeight + lastMeasuredContentHeight)
    );
    if (Math.abs(window.outerHeight - targetHeight) < 2) return;

    const sequence = ++autoFitSequence;
    autoFitMarkerActive = true;
    document.title =
      `[DICTAI_AUTOFIT|${verticalAnchor}] ${normalWindowTitle}`;
    // Let the native title reach KWin before the browser applies the geometry
    // update; otherwise frameGeometryChanged can race ahead of captionChanged.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    if (sequence !== autoFitSequence) return;
    await updateCurrentWindowHeight(targetHeight);
    setTimeout(() => {
      if (sequence !== autoFitSequence) return;
      autoFitMarkerActive = false;
      if (!positionMarkerActive) {
        document.title = normalWindowTitle;
      }
    }, 120);
  }

  function measureFrameDocument(frameDocument) {
    const previousHeight = frameContent.style.height;
    frameContent.style.height = '1px';
    const measuredHeight = Math.max(
      frameDocument.body ? frameDocument.body.scrollHeight : 0,
      frameDocument.documentElement
        ? frameDocument.documentElement.scrollHeight
        : 0
    );
    frameContent.style.height = previousHeight;
    return measuredHeight;
  }

  function measureElementContent(element) {
    const previous = {
      height: element.style.height,
      overflowY: element.style.overflowY,
      position: element.style.position,
      top: element.style.top,
      right: element.style.right,
      bottom: element.style.bottom,
      left: element.style.left
    };
    element.style.height = 'auto';
    element.style.overflowY = 'visible';
    if (getComputedStyle(element).position === 'absolute') {
      element.style.position = 'static';
      element.style.top = 'auto';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.left = 'auto';
    }
    const measuredHeight = element.scrollHeight;
    Object.assign(element.style, previous);
    return measuredHeight;
  }

  function scheduleElementFit(element) {
    requestAnimationFrame(() => {
      if (getComputedStyle(element).display !== 'none') {
        fitWindowToContent(measureElementContent(element));
      }
    });
  }

  frameContent.addEventListener('load', () => {
    try {
      const frameDocument = frameContent.contentDocument;
      if (!frameDocument) return;
      frameDocument.addEventListener('copy', (event) => {
        const selection = frameDocument.getSelection();
        if (selection && !selection.isCollapsed) return;

        const activeElement = frameDocument.activeElement;
        if (
          activeElement &&
          (activeElement.tagName === 'INPUT' ||
            activeElement.tagName === 'TEXTAREA') &&
          Number.isInteger(activeElement.selectionStart) &&
          Number.isInteger(activeElement.selectionEnd) &&
          activeElement.selectionEnd > activeElement.selectionStart
        ) {
          return;
        }
        if (!event.clipboardData) return;

        event.clipboardData.setData('text/plain', currentWord);
        event.preventDefault();
      }, true);

      const fitFrame = () => {
        if (getComputedStyle(frameContent).display !== 'none') {
          fitWindowToContent(measureFrameDocument(frameDocument));
        }
      };
      requestAnimationFrame(fitFrame);
      if (frameDocument.fonts && frameDocument.fonts.ready) {
        frameDocument.fonts.ready.then(fitFrame).catch(() => {});
      }
      frameDocument.querySelectorAll('img').forEach((image) => {
        if (!image.complete) image.addEventListener('load', fitFrame, { once: true });
      });
    } catch (_) {
      // srcdoc is same-origin, but native copying remains available if access fails.
    }
  });

  // Helper for cross-browser messaging
  async function sendMessageAsync(msg) {
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
      try {
        const res = await browser.runtime.sendMessage(msg);
        return res;
      } catch (e) {
        console.warn('browser.runtime.sendMessage failed:', e);
      }
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      );
    });
  }

  function showError(
    message,
    externalUrl,
    externalLabel =
      (provider === 'wiktionary' ? 'Open Wiktionary Page ↗' : 'Open DictAI Page ↗')
  ) {
    loader.style.display = 'none';
    frameContent.style.display = 'none';
    aiContent.style.display = 'none';
    errorMessage.textContent = message;
    errorLink.href = externalUrl;
    errorLink.textContent = externalLabel;
    errorView.style.display = 'flex';
    scheduleElementFit(errorView);
  }

  async function loadWordDefinition(word) {
    if (!word) return;
    const cleanWord = word.trim().toLowerCase();
    const sequence = ++loadSequence;
    currentWord = cleanWord;
    window.dispatchEvent(
      new CustomEvent('dictai-popup-word-changed', { detail: cleanWord })
    );

    // Update UI title and header
    normalWindowTitle = cleanWord;
    if (!positionMarkerActive && !autoFitMarkerActive) {
      document.title = normalWindowTitle;
    }
    wordBadge.textContent = cleanWord;
    sourceBadge.hidden = true;
    sourceBadge.textContent = '';
    searchInput.value = cleanWord;

    let externalUrl =
      provider === 'wiktionary'
        ? `https://en.wiktionary.org/wiki/${encodeURIComponent(cleanWord)}#English`
        : `https://www.dictai.org/w/${encodeURIComponent(cleanWord)}`;
    linkExternal.href = externalUrl;
    linkExternal.title = `Open on ${providerName} (new tab)`;
    errorLink.href = externalUrl;

    loader.style.display = 'flex';
    loaderLabel.textContent = 'Loading definition...';
    errorView.style.display = 'none';
    frameContent.style.display = 'none';
    aiContent.style.display = 'none';
    aiDefinition.textContent = '';
    currentChatId = '';
    continueAiChat.hidden = true;
    continueAiChat.disabled = false;
    continueAiChat.textContent = 'Continue chat in incognito ↗';

    let response;
    try {
      response = await withTimeout(
        sendMessageAsync({ action: 'FETCH_DICT_HTML', word: cleanWord, provider }),
        provider === 'wiktionary' ? 11000 : 8000,
        `${providerName} lookup timed out`
      );
    } catch (error) {
      if (sequence !== loadSequence) return;
      showError(error.message, externalUrl);
      return;
    }
    if (sequence !== loadSequence) return;

    let preparedWiktionaryHtml = '';
    if (response && response.success && response.source === 'wiktionary') {
      try {
        preparedWiktionaryHtml = WiktionaryView.buildDocument(
          response.data,
          response.resolvedWord || cleanWord
        );
      } catch (pageParseError) {
        if (response.transport === 'api') {
          showError(
            pageParseError.message || 'Could not extract English Wiktionary definitions.',
            externalUrl,
            'Open Wiktionary Page ↗'
          );
          return;
        }

        loaderLabel.textContent = 'Retrying through the Wiktionary API...';
        try {
          response = await withTimeout(
            sendMessageAsync({
              action: 'FETCH_DICT_HTML',
              word: cleanWord,
              provider,
              wiktionaryApiFallback: true
            }),
            16000,
            'Wiktionary API fallback timed out'
          );
        } catch (error) {
          if (sequence !== loadSequence) return;
          showError(error.message, externalUrl, 'Open Wiktionary Page ↗');
          return;
        }
        if (sequence !== loadSequence) return;
        if (response && response.success && response.data) {
          try {
            preparedWiktionaryHtml = WiktionaryView.buildDocument(
              response.data,
              response.resolvedWord || cleanWord
            );
          } catch (apiParseError) {
            showError(
              apiParseError.message || 'Could not extract English Wiktionary definitions.',
              externalUrl,
              'Open Wiktionary Page ↗'
            );
            return;
          }
        }
      }
    }

    if (response && response.success && response.data) {
      const renderedHtml =
        response.source === 'wiktionary' ? preparedWiktionaryHtml : response.data;
      if (response.resolvedWord && response.resolvedWord !== cleanWord) {
        wordBadge.textContent = `${cleanWord} → ${response.resolvedWord}`;
      }
      externalUrl =
        response.source === 'wiktionary'
          ? `https://en.wiktionary.org/wiki/${encodeURIComponent(response.resolvedWord || cleanWord)}#English`
          : externalUrl;
      linkExternal.href = externalUrl;
      errorLink.href = externalUrl;
      frameContent.srcdoc = renderedHtml;
      sourceBadge.textContent =
        response.source === 'wiktionary' ? 'Wiktionary' : 'DictAI';
      sourceBadge.hidden = false;
      loader.style.display = 'none';
      frameContent.style.display = 'block';
      return;
    }

    if (!response || response.errorKind !== 'not_found') {
      showError(
        (response && response.error) || `Could not contact ${providerName}.`,
        externalUrl,
        provider === 'wiktionary' ? 'Open Wiktionary Page ↗' : 'Open DictAI Page ↗'
      );
      return;
    }

    loaderLabel.textContent =
      `No English ${providerName} entry — asking Google AI Mode...`;
    let aiResponse;
    try {
      aiResponse = await withTimeout(
        sendMessageAsync({ action: 'FETCH_AI_DEFINITION', word: cleanWord }),
        95000,
        'Google AI Mode fallback timed out'
      );
    } catch (error) {
      if (sequence !== loadSequence) return;
      showError(
        error.message,
        `https://www.google.com/search?udm=50&aep=1&ntc=1&cs=1&q=${encodeURIComponent(`define ${cleanWord}`)}`,
        'Open Google AI Mode ↗'
      );
      return;
    }
    if (sequence !== loadSequence) return;

    const googleUrl =
      `https://www.google.com/search?udm=50&aep=1&ntc=1&cs=1&q=${encodeURIComponent(`define ${cleanWord}`)}`;
    if (aiResponse && aiResponse.success && aiResponse.data) {
      aiDefinition.textContent = aiResponse.data;
      currentChatId = aiResponse.chatId || '';
      continueAiChat.hidden = !currentChatId;
      sourceBadge.textContent = 'Google AI';
      sourceBadge.hidden = false;
      linkExternal.href = googleUrl;
      linkExternal.title = 'Open in Google AI Mode (new tab)';
      loader.style.display = 'none';
      aiContent.style.display = 'block';
      scheduleElementFit(aiContent);
      return;
    }

    const fallbackMessage =
      aiResponse && aiResponse.errorKind === 'ai_unavailable'
        ? 'AI fallback service is not running. Start dictai-ai-fallback.service and retry.'
        : (aiResponse && aiResponse.error) || 'Google AI Mode could not generate a definition.';
    showError(fallbackMessage, googleUrl, 'Open Google AI Mode ↗');
  }

  searchBtn.addEventListener('click', () => {
    const val = searchInput.value.trim().toLowerCase();
    if (val) loadWordDefinition(val);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = searchInput.value.trim().toLowerCase();
      if (val) loadWordDefinition(val);
    }
  });

  retryButton.addEventListener('click', () => {
    loadWordDefinition(currentWord);
  });

  continueAiChat.addEventListener('click', async () => {
    if (!currentChatId || continueAiChat.disabled) return;
    continueAiChat.disabled = true;
    continueAiChat.textContent = 'Opening incognito chat...';
    try {
      const response = await withTimeout(
        sendMessageAsync({ action: 'SHOW_AI_CHAT', chatId: currentChatId }),
        6000,
        'Timed out while opening the AI Mode conversation'
      );
      if (!response || !response.success) {
        throw new Error(
          (response && response.error) || 'Could not open the AI Mode conversation'
        );
      }
      continueAiChat.textContent = 'Opened in incognito';
    } catch (error) {
      continueAiChat.textContent = error.message || 'Could not open chat';
    } finally {
      setTimeout(() => {
        continueAiChat.disabled = false;
        continueAiChat.textContent = 'Continue chat in incognito ↗';
      }, 1800);
    }
  });

  // Initial load
  loadWordDefinition(initialWord);
});
