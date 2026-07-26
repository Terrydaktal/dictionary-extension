/*
 * Install the copy fallback as early as possible in the standalone window.
 * A real selection always keeps native copy behavior. With nothing selected,
 * Ctrl+C copies the word that opened the definition.
 */

(() => {
  const params = new URLSearchParams(window.location.search);
  let currentWord = (params.get('word') || '').trim();
  if (!currentWord) return;

  window.addEventListener('dictai-popup-word-changed', (event) => {
    const nextWord = String(event.detail || '').trim();
    if (nextWord) currentWord = nextWord;
  });

  const handleCopyFallback = (event) => {
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

    event.clipboardData.setData('text/plain', currentWord);
    event.preventDefault();
  };

  document.addEventListener('copy', handleCopyFallback, true);
})();
