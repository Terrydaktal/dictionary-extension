#!/usr/bin/env node
'use strict';

/**
 * Loopback-only Google AI Mode definition bridge.
 *
 * Reuses ~/Dev/chatbot's installed Puppeteer packages while keeping all
 * extension-specific browser automation in this repository.
 */

process.env.BROWSER_AI_DEBUG = process.env.BROWSER_AI_DEBUG || '0';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const CHATBOT_ROOT = process.env.CHATBOT_ROOT || path.join(os.homedir(), 'Dev', 'chatbot');
const puppeteerCore = require(path.join(CHATBOT_ROOT, 'node_modules', 'puppeteer-core'));
const { addExtra } = require(path.join(CHATBOT_ROOT, 'node_modules', 'puppeteer-extra'));
const StealthPlugin = require(path.join(
  CHATBOT_ROOT,
  'node_modules',
  'puppeteer-extra-plugin-stealth'
));
const { AiModePage } = require('./lib/ai-mode-page');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const AI_MODE_URL =
  process.env.AI_MODE_URL ||
  'https://www.google.com/search?udm=50&aep=1&ntc=1&cs=1&hl=en-GB';
const DEFAULT_PROFILE = path.join(os.homedir(), '.config', 'chromium-dictai-fallback');
const MAX_CACHE_SIZE = 250;
const REQUEST_TIMEOUT_MS = 80000;
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.BROWSER_AI_DEBUG || '');

function parseArgs(argv) {
  const config = {
    host: '127.0.0.1',
    port: Number(process.env.DICTAI_AI_PORT || 9235),
    browserPort: Number(process.env.DICTAI_AI_BROWSER_PORT || 9234),
    profile: process.env.DICTAI_AI_PROFILE || DEFAULT_PROFILE,
    incognito: !/^(0|false|no|off)$/i.test(process.env.DICTAI_AI_INCOGNITO || '1'),
    headed: !/^(1|true|yes|on)$/i.test(process.env.DICTAI_AI_HEADLESS || ''),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') config.port = Number(argv[++index]);
    else if (arg === '--browser-port') config.browserPort = Number(argv[++index]);
    else if (arg === '--profile') config.profile = path.resolve(argv[++index]);
    else if (arg === '--incognito') config.incognito = true;
    else if (arg === '--persistent-profile') config.incognito = false;
    else if (arg === '--headed') config.headed = true;
    else if (arg === '--headless') config.headed = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: ai-fallback-server.js [--port PORT] [--browser-port PORT] [--profile PATH] [--incognito] [--persistent-profile] [--headed] [--headless]',
          '',
          'Runs a loopback-only Google AI Mode bridge for the DictAI extension.',
          'The default is a signed-out ephemeral incognito browser context.',
          '--persistent-profile opts into ~/.config/chromium-dictai-fallback.',
          '',
        ].join('\n')
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  if (
    !Number.isInteger(config.browserPort) ||
    config.browserPort < 1024 ||
    config.browserPort > 65535 ||
    config.browserPort === config.port
  ) {
    throw new Error(`Invalid browser port: ${config.browserPort}`);
  }
  return config;
}

function resolveChrome() {
  const configured = process.env.CHROMIUM_BIN;
  const candidates = [
    configured,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
  if (!found) throw new Error('Could not find a Chrome/Chromium executable');
  return found;
}

function cleanDefinition(text) {
  let cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  cleaned = cleaned
    // AI Mode's rendered text can append citation chips as two plain-text
    // lines, such as "Synametrics" followed by "+4". They are UI metadata,
    // not part of the generated answer.
    .replace(/(^|\n)[^\n]{1,120}\n\s*\+\d+\s*(?=\n|$)/g, '$1')
    .replace(
      /\n(?:To help (?:me|you)|Would you like|Let me know if|Do you want me to)[\s\S]*$/i,
      ''
    )
    .replace(
      /\nIf you(?:['’]d| would)?[^\n]*(?:let me know|want me to|would like)[\s\S]*$/i,
      ''
    )
    .replace(/\nAI responses may include mistakes(?:\.\s*Learn more)?\s*$/i, '')
    .trim();
  return cleaned;
}

function normalizeComparable(text) {
  return cleanDefinition(text).replace(/\s+/g, ' ').toLowerCase();
}

function definitionPrompt(word) {
  return [
    `What is "${word}"?`,
    'First identify what the term most likely refers to instead of assuming it is an ordinary word or verb.',
    'It may be a dictionary word or inflection, but it may instead be a proper name, product, software package, company, acronym, technical concept, place, title, or other named entity.',
    'For an ordinary word, answer in two to four sentences with its part of speech, concise meaning, genuine base form if inflected, and one natural example.',
    'For a named entity, product, or concept, answer in two to five sentences that identify it directly and explain its maker or users when relevant, main purpose, and key distinction. Omit part-of-speech, base-word, and invented example fields.',
    'If the term is genuinely ambiguous, give the most likely meaning first and list at most two other common meanings.',
    'Use concise plain text without headings, citations, source labels, or follow-up offers. Do not invent an inflection or grammatical meaning.',
  ].join(' ');
}

function isExtensionOrigin(origin) {
  return (
    typeof origin === 'string' &&
    (/^moz-extension:\/\/[a-z0-9-]+$/i.test(origin) ||
      /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin))
  );
}

function sendJson(response, status, payload, origin = '') {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (isExtensionOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

class AiModeBridge {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.chromeProcess = null;
    this.context = null;
    this.page = null;
    this.ai = new AiModePage();
    this.ready = false;
    this.cache = new Map();
    this.chatPages = new Map();
    this.chatOrder = [];
    this.queue = Promise.resolve();
    this.warmPromise = this.start();
  }

  async start() {
    fs.mkdirSync(this.config.profile, { recursive: true, mode: 0o700 });
    const chromeArgs = [
      `--user-data-dir=${this.config.profile}`,
      `--remote-debugging-port=${this.config.browserPort}`,
      '--remote-debugging-address=127.0.0.1',
      ...(this.config.incognito ? ['--incognito'] : []),
      ...(!this.config.headed ? ['--headless=new'] : ['--start-minimized']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-session-crashed-bubble',
      AI_MODE_URL,
    ];
    this.chromeProcess = spawn(resolveChrome(), chromeArgs, {
      stdio: ['ignore', 'ignore', DEBUG ? 'inherit' : 'ignore'],
    });
    this.chromeProcess.once('exit', () => {
      this.ready = false;
    });

    const browserUrl = `http://127.0.0.1:${this.config.browserPort}`;
    let lastError = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${browserUrl}/json/version`);
        if (response.ok) {
          lastError = null;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (lastError) throw new Error(`Chrome debugging endpoint did not start: ${lastError.message}`);

    this.browser = await puppeteer.connect({
      browserURL: browserUrl,
      defaultViewport: null,
    });
    const pages = await this.browser.pages();
    this.page = pages.find((page) => page.url().includes('google.com/search')) || pages[0];
    if (!this.page) this.page = await this.browser.newPage();
    this.context = this.page.browserContext();
    if (this.config.headed) await this.minimizeWindow();
    await this.warmAiMode();
    this.ready = true;
    process.stdout.write(
      `AI Mode bridge ready (${this.config.incognito ? 'incognito' : 'dedicated profile'}).\n`
    );
  }

  async warmAiMode() {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await this.navigateToFreshAiMode();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }
    throw lastError;
  }

  async navigateToFreshAiMode(query = '') {
    const target = new URL(AI_MODE_URL);
    if (query) target.searchParams.set('q', query);
    else target.searchParams.delete('q');
    await this.page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (this.page.url().includes('/sorry/')) {
      throw new Error('Google blocked the automated browser with an unusual-traffic challenge');
    }
    if (!query) {
      const selectors = this.ai.getModelConfig('aimode').inputSelectors.join(', ');
      await this.page.waitForSelector(selectors, { visible: true, timeout: 120000 });
    }
  }

  async minimizeWindow(page = this.page) {
    try {
      const session = await page.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await session.detach();
    } catch (_) {
      // --start-minimized remains the fallback on platforms without this CDP API.
    }
  }

  async activateNativeWindow() {
    if (!this.config.headed || !this.chromeProcess || !this.chromeProcess.pid) {
      return false;
    }

    return new Promise((resolve) => {
      const activation = spawn(
        'kdotool',
        [
          '--quiet',
          'search',
          '--pid',
          String(this.chromeProcess.pid),
          'windowactivate',
        ],
        { stdio: 'ignore' }
      );
      let finished = false;
      const finish = (success) => {
        if (finished) return;
        finished = true;
        resolve(success);
      };
      activation.once('error', () => finish(false));
      activation.once('exit', (code) => finish(code === 0));
    });
  }

  async openConversationTab() {
    const sourcePage =
      [...this.chatPages.values()].find((page) => !page.isClosed()) || this.page;
    if (this.config.headed) await this.minimizeWindow(sourcePage);

    const existingTargets = new Set(this.browser.targets());
    const targetPromise = this.browser.waitForTarget(
      (target) => target.type() === 'page' && !existingTargets.has(target),
      { timeout: 10000 }
    );

    // Creating a tab with page-side window.open() restores and focuses a
    // minimized Chrome window on Wayland. CDP can create the same page as a
    // background target without mapping the native window.
    const browserSession = await this.browser.target().createCDPSession();
    try {
      await browserSession.send('Target.createTarget', {
        url: 'about:blank',
        background: true,
      });
    } finally {
      await browserSession.detach().catch(() => {});
    }

    const target = await targetPromise;
    const page = await target.page();
    if (!page) throw new Error('Chrome did not create the AI Mode conversation tab');
    if (this.config.headed) await this.minimizeWindow(page);
    return page;
  }

  async dismissGoogleConsent() {
    await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const reject = buttons.find((button) => {
        const label = String(button.innerText || button.textContent || '').trim().toLowerCase();
        return label === 'reject all';
      });
      if (reject) reject.click();
    }).catch(() => {});
  }

  async waitForDirectResponse(prompt) {
    const promptNorm = normalizeComparable(prompt);
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let previous = '';
    let stableTicks = 0;
    let responseTicks = 0;

    while (Date.now() < deadline) {
      const snapshot = await this.ai.getChatSnapshot(this.page, 'aimode');
      const candidate = cleanDefinition(snapshot && snapshot.lastText);
      const candidateNorm = normalizeComparable(candidate);
      const isResponse =
        candidate.length >= 20 &&
        candidateNorm !== promptNorm &&
        !candidateNorm.startsWith(promptNorm);

      if (isResponse) {
        responseTicks += 1;
        stableTicks = candidate === previous ? stableTicks + 1 : 0;
        previous = candidate;
        const copyButtons = await this.ai.getVisibleAiModeCopyButtonCount(this.page);
        if ((copyButtons > 0 && stableTicks >= 1) || stableTicks >= 5) {
          const scoped = await this.ai.extractLatestAiModeTurnText(this.page, promptNorm);
          return cleanDefinition(scoped || candidate);
        }
      } else {
        responseTicks = 0;
        stableTicks = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, responseTicks ? 300 : 400));
    }
    throw new Error('Google AI Mode response timed out');
  }

  remember(word, result) {
    if (this.cache.has(word)) this.cache.delete(word);
    this.cache.set(word, result);
    if (this.cache.size > MAX_CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  define(word) {
    if (this.cache.has(word)) {
      const cached = this.cache.get(word);
      return Promise.resolve({
        ...cached,
        chatId: this.chatPages.has(cached.chatId) ? cached.chatId : '',
      });
    }
    const task = this.queue.then(() => this.runDefinition(word));
    this.queue = task.catch(() => {});
    return task;
  }

  async runDefinition(word) {
    await this.warmPromise;
    if (!this.page || this.page.isClosed() || this.chatPages.size > 0) {
      this.page = await this.openConversationTab();
    }
    if (this.config.headed) await this.minimizeWindow(this.page);

    try {
      const prompt = definitionPrompt(word);
      // Loading a q= AI Mode URL directly is both faster and more reliable for
      // signed-out sessions than typing into the empty surface and clicking Send.
      await this.navigateToFreshAiMode(prompt);
      await this.dismissGoogleConsent();
      if (DEBUG) {
        const diagnostic = await this.page.evaluate(() => ({
          title: document.title,
          url: location.href,
          body: String(document.body && document.body.innerText || '').slice(0, 2000),
        }));
        process.stdout.write(`Direct AI Mode diagnostic: ${JSON.stringify(diagnostic)}\n`);
      }
      const definition = await this.waitForDirectResponse(prompt);
      if (!definition) throw new Error('Google AI Mode returned an empty definition');
      const chatId = randomUUID();
      const result = { definition, chatId };
      this.rememberChat(chatId, this.page);
      this.remember(word, result);
      return result;
    } finally {
      if (this.config.headed) await this.minimizeWindow(this.page);
    }
  }

  rememberChat(chatId, page) {
    this.chatPages.set(chatId, page);
    this.chatOrder.push(chatId);
    page.once('close', () => {
      this.chatPages.delete(chatId);
      this.chatOrder = this.chatOrder.filter((id) => id !== chatId);
    });

    while (this.chatOrder.length > 8) {
      const oldestId = this.chatOrder.shift();
      const oldestPage = this.chatPages.get(oldestId);
      this.chatPages.delete(oldestId);
      if (oldestPage && !oldestPage.isClosed()) oldestPage.close().catch(() => {});
    }
  }

  async showChat(chatId) {
    await this.warmPromise;
    const page = this.chatPages.get(chatId);
    if (!page || page.isClosed()) {
      throw new Error('This AI Mode conversation is no longer available');
    }

    const session = await page.createCDPSession();
    try {
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
      if (bounds && bounds.windowState === 'minimized') {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
      }
    } finally {
      await session.detach().catch(() => {});
    }
    await page.bringToFront();
    // KWin maps a restored Wayland surface asynchronously. The first
    // activation selects the tab, but can arrive before the OS window is
    // ready to be raised; activate it again once that restore has settled.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.bringToFront();
    // Chromium cannot reliably raise its own native window through Wayland.
    // Ask KWin to activate only the window owned by this isolated Chrome PID.
    await this.activateNativeWindow();
    return true;
  }

  async closeChat(chatId) {
    await this.warmPromise;
    const page = this.chatPages.get(chatId);

    this.chatPages.delete(chatId);
    this.chatOrder = this.chatOrder.filter((id) => id !== chatId);
    for (const [word, result] of this.cache) {
      if (result && result.chatId === chatId) {
        this.cache.delete(word);
      }
    }

    if (!page || page.isClosed()) return false;
    if (this.page === page) {
      const remainingPages = (await this.browser.pages()).filter(
        (candidate) => candidate !== page && !candidate.isClosed()
      );
      this.page =
        remainingPages[0] ||
        await this.openConversationTab();
    }
    await page.close().catch(() => {});
    return true;
  }

  async close() {
    this.ready = false;
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.chromeProcess && this.chromeProcess.exitCode === null) {
      this.chromeProcess.kill('SIGTERM');
    }
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const bridge = new AiModeBridge(config);

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    const url = new URL(request.url || '/', `http://${config.host}:${config.port}`);

    if (request.method === 'OPTIONS') {
      if (!isExtensionOrigin(origin)) {
        sendJson(response, 403, { success: false, error: 'Extension origin required' });
        return;
      }
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DictAI-Extension');
      response.setHeader('Access-Control-Max-Age', '600');
      response.setHeader('Vary', 'Origin');
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, bridge.ready ? 200 : 503, {
        success: bridge.ready,
        state: bridge.ready ? 'ready' : 'warming',
        mode: config.incognito ? 'incognito' : 'dedicated-profile',
      }, origin);
      return;
    }

    const isDefineRequest = request.method === 'POST' && url.pathname === '/v1/define';
    const isShowChatRequest = request.method === 'POST' && url.pathname === '/v1/show-chat';
    const isCloseChatRequest = request.method === 'POST' && url.pathname === '/v1/close-chat';
    if (!isDefineRequest && !isShowChatRequest && !isCloseChatRequest) {
      sendJson(response, 404, { success: false, error: 'Not found' }, origin);
      return;
    }
    if (
      !isExtensionOrigin(origin) ||
      request.headers['x-dictai-extension'] !== '1' ||
      !String(request.headers['content-type'] || '').startsWith('application/json')
    ) {
      sendJson(response, 403, { success: false, error: 'Extension request required' }, origin);
      return;
    }

    try {
      const payload = await readJsonBody(request);
      if (isShowChatRequest || isCloseChatRequest) {
        const chatId = String(payload.chatId || '').trim();
        if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
          sendJson(response, 400, { success: false, error: 'Invalid chat identifier' }, origin);
          return;
        }
        if (isCloseChatRequest) {
          await bridge.closeChat(chatId);
        } else {
          await bridge.showChat(chatId);
        }
        sendJson(response, 200, { success: true, chatId }, origin);
        return;
      }

      const word = String(payload.word || '').trim().toLowerCase();
      if (
        !word ||
        word.length > 100 ||
        !/^[\p{L}\p{M}][\p{L}\p{M}'’.\-\s]*$/u.test(word)
      ) {
        sendJson(response, 400, { success: false, error: 'Invalid word' }, origin);
        return;
      }
      const result = await bridge.define(word);
      sendJson(response, 200, {
        success: true,
        word,
        definition: result.definition,
        chatId: result.chatId || '',
      }, origin);
    } catch (error) {
      sendJson(response, 502, {
        success: false,
        error: error && error.message ? error.message : 'AI Mode request failed',
      }, origin);
    }
  });

  server.listen(config.port, config.host, () => {
    process.stdout.write(`DictAI AI fallback listening on http://${config.host}:${config.port}\n`);
  });

  const shutdown = async () => {
    server.close();
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bridge.warmPromise.catch((error) => {
    process.stderr.write(`AI Mode warm-up failed: ${error.message}\n`);
    server.close(async () => {
      await bridge.close();
      process.exit(1);
    });
  });
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error.message}\n`);
  process.exit(1);
});
