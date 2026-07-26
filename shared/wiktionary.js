(function (global) {
  'use strict';

  const POS_ORDER = [
    'Noun',
    'Proper noun',
    'Verb',
    'Adjective',
    'Adverb',
    'Pronoun',
    'Determiner',
    'Article',
    'Preposition',
    'Conjunction',
    'Interjection',
    'Numeral',
    'Particle',
    'Participle',
    'Phrase',
    'Proverb',
    'Abbreviation',
    'Acronym',
    'Initialism',
    'Contraction',
    'Prefix',
    'Suffix',
    'Affix',
    'Symbol'
  ];
  const POS_NAMES = new Set(POS_ORDER);

  function cleanText(value) {
    return String(value || '')
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  function headingLevel(element) {
    const match = /^H([2-6])$/.exec(element && element.tagName);
    return match ? Number(match[1]) : 0;
  }

  function directDefinitionList(heading) {
    const level = headingLevel(heading);
    const wrapper =
      heading.parentElement && heading.parentElement.classList.contains('mw-heading')
        ? heading.parentElement
        : heading;
    for (let node = wrapper.nextElementSibling; node; node = node.nextElementSibling) {
      const nextHeading = node.matches('.mw-heading')
        ? node.querySelector('h2, h3, h4, h5, h6')
        : (node.matches('h2, h3, h4, h5, h6') ? node : null);
      if (nextHeading && headingLevel(nextHeading) <= level) return null;
      if (node.tagName === 'OL') return node;
    }
    return null;
  }

  function extractSense(listItem) {
    const examples = [];
    const exampleNodes = listItem.querySelectorAll(
      '.h-usage-example .e-example'
    );
    for (const exampleNode of exampleNodes) {
      const example = cleanText(exampleNode.textContent);
      if (example && !examples.includes(example)) examples.push(example);
      if (examples.length === 1) break;
    }

    const definitionNode = listItem.cloneNode(true);
    definitionNode
      .querySelectorAll(
        'ol, ul, dl, table, figure, style, script, audio, sup.reference, .citation-whole, .nyms'
      )
      .forEach((node) => node.remove());
    const definition = cleanText(definitionNode.textContent);
    return definition ? { definition, examples } : null;
  }

  function extractDefinitions(rawHtml) {
    const documentNode = new DOMParser().parseFromString(String(rawHtml || ''), 'text/html');
    const englishHeading =
      documentNode.querySelector('h2#English') ||
      Array.from(documentNode.querySelectorAll('h2')).find(
        (heading) => cleanText(heading.textContent) === 'English'
      );
    if (!englishHeading) return [];

    const englishWrapper =
      englishHeading.parentElement &&
      englishHeading.parentElement.classList.contains('mw-heading')
        ? englishHeading.parentElement
        : englishHeading;
    const sectionNodes = [];
    for (
      let node = englishWrapper.nextElementSibling;
      node;
      node = node.nextElementSibling
    ) {
      const nextH2 = node.matches('.mw-heading')
        ? node.querySelector('h2')
        : (node.matches('h2') ? node : null);
      if (nextH2) break;
      sectionNodes.push(node);
    }

    const grouped = new Map();
    for (const sectionNode of sectionNodes) {
      const headings = [];
      if (sectionNode.matches('h3, h4, h5, h6')) headings.push(sectionNode);
      headings.push(...sectionNode.querySelectorAll('h3, h4, h5, h6'));

      for (const heading of headings) {
        const partOfSpeech = cleanText(heading.textContent);
        if (!POS_NAMES.has(partOfSpeech)) continue;
        const definitionList = directDefinitionList(heading);
        if (!definitionList) continue;
        const senses = Array.from(definitionList.children)
          .filter((item) => item.tagName === 'LI')
          .map(extractSense)
          .filter(Boolean);
        if (!senses.length) continue;
        if (!grouped.has(partOfSpeech)) grouped.set(partOfSpeech, []);
        grouped.get(partOfSpeech).push(...senses);
      }
    }

    return POS_ORDER
      .filter((partOfSpeech) => grouped.has(partOfSpeech))
      .map((partOfSpeech) => ({
        partOfSpeech,
        senses: grouped.get(partOfSpeech)
      }));
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildDocument(rawHtml, word) {
    const groups = extractDefinitions(rawHtml);
    if (!groups.length) {
      throw new Error('Wiktionary has no English definitions for this word');
    }

    const sections = groups.map((group) => {
      const senses = group.senses.map((sense) => {
        const examples = sense.examples
          .map((example) => `<blockquote>${escapeHtml(example)}</blockquote>`)
          .join('');
        return `<li><div class="sense">${escapeHtml(sense.definition)}</div>${examples}</li>`;
      }).join('');
      return (
        `<section class="pos-section">` +
          `<h2>${escapeHtml(group.partOfSpeech)}</h2>` +
          `<ol>${senses}</ol>` +
        `</section>`
      );
    }).join('');

    const sourceUrl =
      `https://en.wiktionary.org/wiki/${encodeURIComponent(String(word || ''))}#English`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 22px 26px 30px;
      background:
        radial-gradient(circle at top right, rgba(255, 255, 255, 0.05), transparent 36%),
        #18181b;
      color: #e2e8f0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 16px;
      line-height: 1.55;
    }
    .pos-section + .pos-section { margin-top: 26px; }
    h2 {
      margin: 0 0 10px;
      padding-bottom: 7px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 18px;
      line-height: 1.25;
    }
    ol { margin: 0; padding-left: 28px; }
    li { padding-left: 4px; margin: 0 0 13px; }
    li::marker {
      color: #818cf8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 700;
    }
    .sense { white-space: normal; }
    blockquote {
      margin: 6px 0 0 12px;
      padding-left: 12px;
      border-left: 2px solid rgba(129, 140, 248, 0.65);
      color: #aebbd0;
      font-style: italic;
    }
    .source {
      margin-top: 28px;
      color: #94a3b8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
    }
    .source a { color: #67e8f9; text-decoration: none; }
  </style>
</head>
<body>
  ${sections}
  <p class="source">Definitions from <a href="${sourceUrl}" target="_blank" rel="noopener">Wiktionary</a>.</p>
</body>
</html>`;
  }

  global.WiktionaryView = Object.freeze({
    extractDefinitions,
    buildDocument
  });
})(globalThis);
