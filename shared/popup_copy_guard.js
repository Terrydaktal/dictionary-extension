/*
 * Install the copy handler as early as possible in the standalone window.
 * KWin may briefly direct a key event to a newly mapped Wayland surface before
 * its no-focus rule restores the source window. If Ctrl+C lands here while
 * nothing in the definition is selected, copy the word that opened the window.
 */

(() => {
  const SETTLEMENT_PERIOD_MS = 400;
  const params = new URLSearchParams(window.location.search);
  const selectedWord = (params.get('word') || '').trim();
  if (!selectedWord) return;

  const handleInitialCopy = (event) => {
    const activeElement = document.activeElement;
    // Definition documents render inside this iframe. Never replace a copy
    // originating from an actual definition selection.
    if (activeElement instanceof HTMLIFrameElement) {
      return;
    }
    if (
      activeElement &&
      (activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement) &&
      Number.isInteger(activeElement.selectionStart) &&
      Number.isInteger(activeElement.selectionEnd) &&
      activeElement.selectionEnd > activeElement.selectionStart
    ) {
      return;
    }

    const documentSelection = window.getSelection();
    if (documentSelection && !documentSelection.isCollapsed) {
      return;
    }
    if (!event.clipboardData) {
      return;
    }

    event.clipboardData.setData('text/plain', selectedWord);
    event.preventDefault();
  };

  document.addEventListener('copy', handleInitialCopy, true);
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      document.removeEventListener('copy', handleInitialCopy, true);
    }, SETTLEMENT_PERIOD_MS);
  }, { once: true });
})();
