/**
 * DictAI Extension - Popup Script
 * Handles settings persistence, status indicators, and direct word search.
 */

document.addEventListener('DOMContentLoaded', () => {
  const extAPI = typeof browser !== 'undefined' ? browser : chrome;

  // DOM Elements
  const searchForm = document.getElementById('search-form');
  const wordInput = document.getElementById('word-input');
  const toggleEnabled = document.getElementById('toggle-enabled');
  const selectDisplayMode = document.getElementById('select-display-mode');
  const selectProvider = document.getElementById('select-provider');
  const selectTrigger = document.getElementById('select-trigger');
  const selectTheme = document.getElementById('select-theme');
  const toggleInputs = document.getElementById('toggle-inputs');
  const inputWidth = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');

  // Load existing settings
  extAPI.runtime.sendMessage({ action: 'GET_SETTINGS' }, (response) => {
    if (response && response.settings) {
      const s = response.settings;
      toggleEnabled.checked = s.enabled !== false;
      selectDisplayMode.value = s.displayMode || 'in_page';
      selectProvider.value = s.dictionaryProvider || 'dictai';
      selectTrigger.value = s.triggerMode || 'dblclick';
      selectTheme.value = s.theme || 'system';
      toggleInputs.checked = s.allowInInputs === true;
      inputWidth.value = s.popupWidth || 480;
      inputHeight.value = s.popupHeight || 520;

      updateStatusUI(s.enabled !== false);
    }
  });

  // Handle direct word search from popup
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (word) {
      extAPI.runtime.sendMessage({ action: 'OPEN_DICT_TAB', word });
      wordInput.value = '';
    }
  });

  // Save settings on input changes
  function saveCurrentSettings() {
    const newSettings = {
      enabled: toggleEnabled.checked,
      displayMode: selectDisplayMode.value,
      dictionaryProvider: selectProvider.value,
      triggerMode: selectTrigger.value,
      theme: selectTheme.value,
      allowInInputs: toggleInputs.checked,
      popupWidth: parseInt(inputWidth.value, 10) || 480,
      popupHeight: parseInt(inputHeight.value, 10) || 520
    };

    updateStatusUI(newSettings.enabled);

    extAPI.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: newSettings });
  }

  function updateStatusUI(isEnabled) {
    if (isEnabled) {
      statusBadge.classList.remove('disabled');
      statusText.textContent = 'Active';
    } else {
      statusBadge.classList.add('disabled');
      statusText.textContent = 'Disabled';
    }
  }

  toggleEnabled.addEventListener('change', saveCurrentSettings);
  selectDisplayMode.addEventListener('change', saveCurrentSettings);
  selectProvider.addEventListener('change', saveCurrentSettings);
  selectTrigger.addEventListener('change', saveCurrentSettings);
  selectTheme.addEventListener('change', saveCurrentSettings);
  toggleInputs.addEventListener('change', saveCurrentSettings);
  inputWidth.addEventListener('change', saveCurrentSettings);
  inputHeight.addEventListener('change', saveCurrentSettings);
});
