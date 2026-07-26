'use strict';

const AI_INPUT_SELECTORS = [
  '.ITIRGe',
  'textarea[aria-label="Ask anything"]',
  'textarea',
  '[contenteditable="true"]',
];
const AI_RESPONSE_SELECTOR = '[data-xid="VpUvz"], [data-xid="aim-mars-turn-root"]';
const AI_RESPONSE_CONTAINER_SELECTOR = '[data-xid="aim-mars-turn-root"]';
const AI_COPY_BUTTON_SELECTOR = 'button[aria-label="Copy text"]';

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeResponseTextPreservingBreaks(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class AiModePage {
  getModelConfig() {
    return {
      inputSelectors: AI_INPUT_SELECTORS,
      responseSelector: AI_RESPONSE_SELECTOR,
      responseContainerSelector: AI_RESPONSE_CONTAINER_SELECTOR,
    };
  }

  async getChatSnapshot(page) {
    const config = this.getModelConfig();
    return page.evaluate((containerSelector, textSelector) => {
      const isVisible = (element) =>
        Boolean(element && element.offsetWidth > 0 && element.offsetHeight > 0);
      const turns = Array.from(document.querySelectorAll(containerSelector)).filter(isVisible);
      if (!turns.length) return { turnCount: 0, lastText: '' };

      const messageBlocks = Array.from(document.querySelectorAll('[data-xid="VpUvz"]'))
        .filter(isVisible)
        .sort((left, right) =>
          left.getBoundingClientRect().bottom - right.getBoundingClientRect().bottom
        );
      let text = '';
      if (messageBlocks.length) {
        const latestLeaf = messageBlocks[messageBlocks.length - 1];
        text = latestLeaf.innerText || latestLeaf.textContent || '';
      } else {
        turns.sort((left, right) =>
          left.getBoundingClientRect().bottom - right.getBoundingClientRect().bottom
        );
        const latestTurn = turns[turns.length - 1];
        const scopedBlocks = Array.from(latestTurn.querySelectorAll(textSelector))
          .filter(isVisible)
          .sort((left, right) =>
            left.getBoundingClientRect().bottom - right.getBoundingClientRect().bottom
          );
        const latestBlock = scopedBlocks[scopedBlocks.length - 1] || latestTurn;
        text = latestBlock.innerText || latestBlock.textContent || '';
      }

      text = text.replace(/(Generating\.\.\.|\d{1,2}:\d{2})\s*$/ig, '').trim();
      return {
        turnCount: messageBlocks.length || turns.length,
        lastText: text,
      };
    }, config.responseContainerSelector, config.responseSelector);
  }

  async getVisibleAiModeCopyButtonCount(page) {
    return page.evaluate((selector) => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return Boolean(
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.offsetWidth > 0 &&
          element.offsetHeight > 0
        );
      };
      return Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
    }, AI_COPY_BUTTON_SELECTOR).catch(() => 0);
  }

  async extractLatestAiModeTurnText(page, promptNorm = '') {
    const text = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return Boolean(
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.offsetWidth > 0 &&
          element.offsetHeight > 0
        );
      };
      const leafBlocks = Array.from(document.querySelectorAll('[data-xid="VpUvz"]'))
        .filter(isVisible)
        .sort((left, right) =>
          left.getBoundingClientRect().bottom - right.getBoundingClientRect().bottom
        );

      let latest = leafBlocks[leafBlocks.length - 1];
      if (!latest) {
        const turns = Array.from(
          document.querySelectorAll('[data-xid="aim-mars-turn-root"]')
        )
          .filter(isVisible)
          .sort((left, right) =>
            left.getBoundingClientRect().bottom - right.getBoundingClientRect().bottom
          );
        latest = turns[turns.length - 1];
      }
      if (!latest) return '';

      return String(latest.innerText || latest.textContent || '')
        .replace(/(Generating\.\.\.|\d{1,2}:\d{2})\s*$/ig, '')
        .trim();
    }).catch(() => '');

    const normalized = normalizeResponseTextPreservingBreaks(text);
    if (!normalized || normalizeText(normalized) === promptNorm) return '';
    return normalized;
  }
}

module.exports = { AiModePage };
