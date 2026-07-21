const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};
const OPENAI_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const DEFAULT_MODEL = 'claw-mini';
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MEMORY_RECENT_LIMIT = 6;
const TELEGRAM_MEMORY_COMPACT_THRESHOLD = 8;
const TELEGRAM_MEMORY_SUMMARY_LIMIT = 240;
const WEB_SEARCH_RESULT_LIMIT = 3;
const WEB_SCRAPE_LIMIT = 2;
const WEB_CONTEXT_LIMIT = 1800;
const WEB_REQUEST_TIMEOUT_MS = 8000;

function json(data, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', JSON_HEADERS['content-type']);
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function methodNotAllowed(allow) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allow },
  });
}

function notFound() {
  return new Response('Not Found', { status: 404 });
}

function getPath(request) {
  return new URL(request.url).pathname.replace(/\/+$/, '') || '/';
}

function getConfiguredModel(env) {
  return env?.CLAW_MODEL || env?.OPENAI_MODEL || DEFAULT_MODEL;
}

function getOpenAIBaseUrl(env) {
  return env?.OPENAI_BASE_URL ? String(env.OPENAI_BASE_URL) : '';
}

function resolveUpstreamUrl(baseUrl, requestUrl) {
  const upstream = new URL(baseUrl);
  const basePath = upstream.pathname.replace(/\/$/, '');
  const suffix = basePath.endsWith('/v1')
    ? requestUrl.pathname.replace(/^\/v1/, '')
    : requestUrl.pathname;

  upstream.pathname = `${basePath === '/' ? '' : basePath}${suffix}`;
  upstream.search = requestUrl.search;
  return upstream;
}

function getMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('')
      .trim();
  }
  return '';
}

function getTelegramText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return '';
}

// 上游模型通常输出 CommonMark；Telegram 未设置 parse_mode 时会把 ** / * 原样显示。
// 统一在 Bot API 出站层转为稳健的纯文本，避免不完整 Markdown 让 Telegram 拒绝消息。
function normalizeTelegramOutput(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n`]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
}

function getTelegramChatId(update) {
  return (
    update?.message?.chat?.id ??
    update?.edited_message?.chat?.id ??
    update?.channel_post?.chat?.id ??
    update?.callback_query?.message?.chat?.id ??
    null
  );
}

function getTelegramCallbackQueryId(update) {
  return update?.callback_query?.id ?? '';
}

function getTelegramCallbackData(update) {
  return typeof update?.callback_query?.data === 'string' ? update.callback_query.data : '';
}

function parseTelegramCommand(text) {
  const firstToken = String(text || '').trim().split(/\s+/, 1)[0];
  if (!firstToken.startsWith('/')) return '';
  return firstToken.slice(1).split('@')[0].toLowerCase();
}

// Telegram 的按钮交互只走 callback_query，不会额外发一条普通文本消息。
// 下面这组按钮统一复用：Retry 重新生成上一轮，Reset 清空会话，Help 打开帮助面板。
// 对应的 Telegram Bot API 细节：
// https://core.telegram.org/bots/api#callbackquery
// https://core.telegram.org/bots/api#answercallbackquery
// https://core.telegram.org/bots/api#editmessagetext
function buildTelegramReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '重试', callback_data: 'retry' },
        { text: '重置', callback_data: 'reset' },
      ],
      [{ text: '帮助', callback_data: 'help' }],
    ],
  };
}

function buildTelegramHelpText() {
  // /start 和 /help 返回同一份说明，目的不是“讲故事”，而是让用户
  // 一眼知道有哪些命令、按钮各自负责什么，以及下一步该点哪里。
  return [
    '发送消息，我会在当前对话里回复。',
    '',
    '命令：',
    '/start - 显示此帮助',
    '/help - 显示此帮助',
    '/model - 查看当前模型',
    '/reset - 清空当前会话',
    '',
    '按钮：',
    '重试 - 重新生成上一条回复',
    '重置 - 清空当前会话',
  ].join('\n');
}

function buildTelegramModelText(env) {
  // /model 只是只读查询：把当前模型、回复模式和是否开启流式返回给用户，
  // 不写入历史，不改变会话状态，也不触发新的推理。
  const model = getConfiguredModel(env);
  const mode = getOpenAIBaseUrl(env) ? '上游 OpenAI 兼容接口' : '本地';

  return [
    `当前模型：${model}`,
    `回复模式：${mode}`,
    '流式输出：已开启',
  ].join('\n');
}

function buildTelegramResetText() {
  // 重置后的确认文案要短，避免让用户误以为还有旧上下文残留。
  return '会话已清空。发送新消息即可重新开始。';
}

function buildTelegramThinkingText() {
  // 先发“思考中”，再把模型输出逐段编辑进同一条消息。
  return '思考中...';
}

function buildTelegramMemorySavedText(memory) {
  return `已记住：${memory.text}`;
}

function buildTelegramMemoryMissingText() {
  return '请在命令后面补充要记住的内容。';
}

function buildTelegramMemoryForgotText(memory) {
  return `已删除记忆：${memory.text}`;
}

function buildTelegramForgetMissingText() {
  return '请在命令后面补充要删除的记忆编号或关键词。';
}

function buildTelegramMemoryNotFoundText() {
  return '没有找到要删除的记忆。';
}

function buildTelegramMemoryListText(memories = []) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return '当前没有长期记忆。';
  }

  return [
    '当前长期记忆：',
    ...memories.map((memory, index) => `${index + 1}. ${memory.text}`),
  ].join('\n');
}

function buildTelegramMemoryContextText(memories = []) {
  const recentMemories = compactTelegramMemories(Array.isArray(memories) ? memories : []);
  if (recentMemories.length === 0) return '';

  return [
    '长期记忆（仅供参考，优先级低于用户当前消息）：',
    ...recentMemories.map((memory) => `- ${memory.text}`),
  ].join('\n');
}

function buildTelegramConversationMessages(messages, memories = [], webContext = '') {
  const conversationMessages = Array.isArray(messages) ? messages : [];
  const contextMessages = [];
  const memoryContext = buildTelegramMemoryContextText(memories);
  if (memoryContext) {
    contextMessages.push({ role: 'system', content: memoryContext });
  }

  const webContextText = typeof webContext === 'string' ? webContext.trim() : '';
  if (webContextText) {
    contextMessages.push({ role: 'system', content: webContextText });
  }

  if (contextMessages.length === 0) {
    return conversationMessages;
  }

  return [...contextMessages, ...conversationMessages];
}

function getTelegramCommandArgs(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return '';

  const firstSpace = trimmed.indexOf(' ');
  return firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
}

function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncateContextText(text, limit) {
  const value = String(text || '').trim();
  if (!limit || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function extractUrlsFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  const urls = [];
  const seen = new Set();

  for (const rawUrl of matches) {
    const cleaned = rawUrl.replace(/[)\].,，。！？!?]+$/u, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }

  return urls;
}

function shouldSearchWeb(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return false;
  return /(?:搜索|查找|查询|查一下|搜一下|搜索一下|最新|新闻|官网|资料|价格|行情|版本|更新|release|文档|网页|互联网)/iu.test(text);
}

function buildSearchQueryFromPrompt(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return '';

  const withoutUrls = text.replace(/https?:\/\/[^\s<>"'`]+/giu, ' ');
  const withoutIntent = withoutUrls
    .replace(/^(?:请|帮我|麻烦)?(?:搜索一下|搜索|查找一下|查找|查询|查一下|搜一下|找一下|了解一下|看看)\s*/iu, '')
    .replace(/^(?:请|帮我|麻烦)\s*/iu, '')
    .trim();

  return withoutIntent || text;
}

function resolveDuckDuckGoResultUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function parseDuckDuckGoSearchResults(html, limit = WEB_SEARCH_RESULT_LIMIT) {
  const results = [];
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(String(html || ''))) && results.length < limit) {
    const title = truncateContextText(stripHtmlToText(match[2]), 160);
    const url = truncateContextText(resolveDuckDuckGoResultUrl(decodeHtmlEntities(match[1])), 300);
    if (!title || !url) continue;
    results.push({ title, url });
  }

  return results;
}

async function fetchTextWithTimeout(fetchImpl, input, init = {}, timeoutMs = WEB_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithLimit(response, maxChars = 50000) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    return String(await response.text().catch(() => '')).slice(0, maxChars);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (text.length < maxChars) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from partially-consumed streams.
    }
  }

  return text.slice(0, maxChars);
}

async function searchWeb(fetchImpl, query) {
  const searchQuery = buildSearchQueryFromPrompt(query);
  if (!searchQuery) return [];

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  let response;
  try {
    response = await fetchTextWithTimeout(fetchImpl, searchUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; claw/1.0)',
      },
    });
  } catch {
    return [];
  }

  if (!response?.ok) return [];
  const html = await readResponseTextWithLimit(response, 25000).catch(() => '');
  return parseDuckDuckGoSearchResults(html, WEB_SEARCH_RESULT_LIMIT);
}

async function scrapeWebPage(fetchImpl, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return null;
  }

  let response;
  try {
    response = await fetchTextWithTimeout(fetchImpl, url.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; claw/1.0)',
      },
    });
  } catch {
    return null;
  }

  if (!response?.ok) return null;
  const rawText = await readResponseTextWithLimit(response, 50000).catch(() => '');
  if (!rawText) return null;

  const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = truncateContextText(
    stripHtmlToText(titleMatch?.[1] ?? '') || url.hostname,
    160,
  );
  const text = truncateContextText(stripHtmlToText(rawText), 900);

  return {
    title,
    url: url.toString(),
    text,
  };
}

function buildWebContextText({ searchQuery = '', searchResults = [], scrapedPages = [] } = {}) {
  const sections = [];

  if (searchQuery) {
    sections.push(`搜索关键词：${truncateContextText(searchQuery, 160)}`);
  }

  if (Array.isArray(searchResults) && searchResults.length > 0) {
    sections.push('网络搜索结果（仅供参考）：');
    searchResults.forEach((result, index) => {
      sections.push(`${index + 1}. ${truncateContextText(result.title, 120)}`);
      sections.push(`   ${truncateContextText(result.url, 240)}`);
    });
  }

  if (Array.isArray(scrapedPages) && scrapedPages.length > 0) {
    sections.push('网页抓取内容（仅供参考）：');
    scrapedPages.forEach((page, index) => {
      sections.push(`${index + 1}. ${truncateContextText(page.title, 120)}`);
      sections.push(`   ${truncateContextText(page.url, 240)}`);
      sections.push(`   ${truncateContextText(page.text, 600)}`);
    });
  }

  return truncateContextText(sections.join('\n').trim(), WEB_CONTEXT_LIMIT);
}

async function prepareWebContext(prompt, fetchImpl) {
  const text = normalizeTelegramMemoryText(prompt);
  if (!text) return '';

  const urls = extractUrlsFromText(text).slice(0, WEB_SCRAPE_LIMIT);
  const searchQuery = shouldSearchWeb(text) ? buildSearchQueryFromPrompt(text) : '';

  if (!searchQuery && urls.length === 0) {
    return '';
  }

  const [searchResults, scrapedPages] = await Promise.all([
    searchQuery ? searchWeb(fetchImpl, searchQuery) : Promise.resolve([]),
    urls.length > 0
      ? Promise.all(urls.map((url) => scrapeWebPage(fetchImpl, url))).then((pages) => pages.filter(Boolean))
      : Promise.resolve([]),
  ]);

  return buildWebContextText({
    searchQuery,
    searchResults,
    scrapedPages,
  });
}

function normalizeTelegramMemoryText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function trimTelegramMemories(memories, maxItems = 20) {
  if (!Array.isArray(memories) || memories.length <= maxItems) {
    return Array.isArray(memories) ? memories : [];
  }

  return memories.slice(memories.length - maxItems);
}

function createTelegramMemory(text, source = 'manual') {
  return {
    id: crypto.randomUUID(),
    text: normalizeTelegramMemoryText(text),
    source,
    createdAt: Date.now(),
  };
}

function normalizeTelegramMemorySnippet(text) {
  return normalizeTelegramMemoryText(text)
    .replace(/^[:：\s-]+/, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
}

function buildTelegramMemorySummaryText(memories = []) {
  const seen = new Set();
  const items = [];

  for (const memory of Array.isArray(memories) ? memories : []) {
    const text = normalizeTelegramMemorySnippet(memory?.text);
    if (!text) continue;

    const summaryText = memory?.source === 'summary'
      ? text.replace(/^历史摘要[：:]\s*/u, '')
      : text;
    const key = summaryText.toLowerCase();
    if (!summaryText || seen.has(key)) continue;

    seen.add(key);
    items.push(summaryText);
  }

  const joined = items.join('；');
  if (!joined) {
    return '历史摘要：暂无可压缩内容';
  }

  const limit = Math.max(0, TELEGRAM_MEMORY_SUMMARY_LIMIT - '历史摘要：'.length);
  const body = joined.length > limit ? `${joined.slice(0, Math.max(0, limit - 1))}…` : joined;
  return `历史摘要：${body}`;
}

function compactTelegramMemories(memories = []) {
  const items = Array.isArray(memories)
    ? memories
        .filter((memory) => memory && typeof memory.text === 'string' && normalizeTelegramMemoryText(memory.text))
        .map((memory) => ({
          ...memory,
          text: normalizeTelegramMemoryText(memory.text),
          source: typeof memory.source === 'string' && memory.source ? memory.source : 'auto',
        }))
    : [];

  if (items.length <= TELEGRAM_MEMORY_COMPACT_THRESHOLD) {
    return items;
  }

  const recent = items.slice(-TELEGRAM_MEMORY_RECENT_LIMIT);
  const older = items.slice(0, items.length - recent.length);
  const summaryText = buildTelegramMemorySummaryText(older);
  const summaryMemory = createTelegramMemory(summaryText, 'summary');
  summaryMemory.createdAt = older[0]?.createdAt ?? summaryMemory.createdAt;
  summaryMemory.id = older.find((memory) => memory.source === 'summary')?.id ?? summaryMemory.id;

  return [summaryMemory, ...recent];
}

function extractTelegramMemoryCandidates(prompt) {
  const text = normalizeTelegramMemoryText(prompt);
  if (text.length < 4) return [];

  const candidates = [];
  const seen = new Set();
  let sawLanguagePreference = false;
  const languageKeywordPattern = /(?:简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)/iu;
  const addCandidate = (label, value, source = 'auto') => {
    const candidate = normalizeTelegramMemorySnippet(value);
    if (candidate.length < 2 || candidate.length > 120) return;
    if (label === '用户要求' && sawLanguagePreference && languageKeywordPattern.test(candidate)) return;

    const textValue = `${label}：${candidate}`;
    const key = textValue.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    candidates.push({ text: textValue, source });
  };

  const rules = [
    { label: '用户名字', patterns: [/^(?:我叫|我的名字是|叫我)\s*(.+)$/iu] },
    { label: '用户偏好', patterns: [/^(?:我喜欢|我偏好|我更喜欢|我常用|我习惯)\s*(.+)$/iu] },
    { label: '用户不喜欢', patterns: [/^(?:我不喜欢|我讨厌|我不想|我不要|别用)\s*(.+)$/iu] },
    { label: '用户所在地', patterns: [/^(?:我住在|我来自)\s*(.+)$/iu] },
    { label: '用户工作内容', patterns: [/^(?:我正在|我在做|我做|我开发|我负责|我从事)\s*(.+)$/iu] },
    { label: '用户联系方式', patterns: [/^(?:我的)?(?:邮箱|邮件|电话|手机号|微信|地址|时区|生日)\s*(?:是|为|：|:)?\s*(.+)$/iu] },
    {
      label: '用户语言偏好',
      patterns: [
        /^(?:以后|今后|默认|请以后|以后请|从现在开始).*?(?:用|使用|回复|写|输出|说)\s*(简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)(?:\s*(?:回复|输出|写|回答|答复|说))?$/iu,
        /^(?:我的)?(?:首选|默认)?语言(?:是|为|：|:)?\s*(简体中文|繁體中文|繁体中文|中文|英文|英语|日文|日语|韩文|韩语|Japanese|English|Chinese|Mandarin)$/iu,
      ],
      transform: (match) => match[1],
    },
    { label: '用户要求', patterns: [/^(?:以后|今后|默认|请以后|以后请|从现在开始)(?:都)?(?:用|使用|回复|写|输出|说)?\s*(.+)$/iu] },
    { label: '用户要求', patterns: [/^(?:请|帮我|麻烦)?(?:记住|长期记住|长期记忆)\s*[:：]?\s*(.+)$/iu] },
  ];

  for (const rule of rules) {
    for (const regex of rule.patterns) {
      const match = text.match(regex);
      if (!match) continue;

      const value = typeof rule.transform === 'function' ? rule.transform(match) : match[1];
      addCandidate(rule.label, value);
      if (rule.label === '用户语言偏好') {
        sawLanguagePreference = true;
      }
    }
  }

  return candidates;
}

function captureAutomaticTelegramMemories(session, prompt) {
  const memoryCandidates = extractTelegramMemoryCandidates(prompt);
  if (memoryCandidates.length === 0) return [];

  const existing = Array.isArray(session.memories) ? session.memories.slice() : [];
  const seen = new Set(existing.map((memory) => normalizeTelegramMemoryText(memory?.text).toLowerCase()));
  const created = [];

  for (const candidate of memoryCandidates) {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const memory = createTelegramMemory(candidate.text, candidate.source);
    existing.push(memory);
    created.push(memory);
  }

  session.memories = compactTelegramMemories(existing);
  return created;
}

function addTelegramMemory(session, text, source = 'manual') {
  const memoryText = normalizeTelegramMemoryText(text);
  if (!memoryText) return null;

  const memory = createTelegramMemory(memoryText, source);
  session.memories = compactTelegramMemories([...(Array.isArray(session.memories) ? session.memories : []), memory]);
  return memory;
}

function resolveTelegramMemoryIndex(memories, rawTarget) {
  if (!Array.isArray(memories) || memories.length === 0) return -1;

  const target = normalizeTelegramMemoryText(rawTarget);
  if (!target) return -1;

  const numeric = Number.parseInt(target, 10);
  if (Number.isInteger(numeric) && String(numeric) === target) {
    const index = numeric - 1;
    return index >= 0 && index < memories.length ? index : -1;
  }

  const lowerTarget = target.toLowerCase();
  return memories.findIndex((memory) => memory.text.toLowerCase().includes(lowerTarget));
}

function trimTelegramHistory(history, maxItems = 12) {
  if (!Array.isArray(history) || history.length <= maxItems) return Array.isArray(history) ? history : [];
  return history.slice(history.length - maxItems);
}

function createTelegramSessionState() {
  return {
    history: [],
    memories: [],
    lastPrompt: '',
    lastReply: '',
  };
}

async function loadTelegramSession(storage) {
  if (!storage) return createTelegramSessionState();
  const session = await storage.get('telegram-session');
  if (!session || typeof session !== 'object') return createTelegramSessionState();
  return {
    history: Array.isArray(session.history) ? session.history : [],
    memories: compactTelegramMemories(Array.isArray(session.memories) ? session.memories : []),
    lastPrompt: typeof session.lastPrompt === 'string' ? session.lastPrompt : '',
    lastReply: typeof session.lastReply === 'string' ? session.lastReply : '',
  };
}

async function saveTelegramSession(storage, session) {
  if (!storage) return;
  const payload = {
    history: trimTelegramHistory(Array.isArray(session?.history) ? session.history : []),
    memories: compactTelegramMemories(Array.isArray(session?.memories) ? session.memories : []),
    lastPrompt: typeof session?.lastPrompt === 'string' ? session.lastPrompt : '',
    lastReply: typeof session?.lastReply === 'string' ? session.lastReply : '',
  };

  if (session && typeof session === 'object') {
    session.history = payload.history;
    session.memories = payload.memories;
    session.lastPrompt = payload.lastPrompt;
    session.lastReply = payload.lastReply;
  }

  await storage.put('telegram-session', payload);
}

async function resetTelegramConversation(session) {
  session.history = [];
  session.lastPrompt = '';
  session.lastReply = '';
  await saveTelegramSession(session.storage, session);
}

async function callTelegramBotApi(env, fetchImpl, method, payload) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with ${response.status}`);
  }

  return body;
}

async function sendTelegramMessage(env, fetchImpl, chatId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'sendMessage', {
    chat_id: chatId,
    text: normalizeTelegramOutput(text),
    ...extra,
  });
}

async function editTelegramMessage(env, fetchImpl, chatId, messageId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: normalizeTelegramOutput(text),
    ...extra,
  });
}

async function answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, text, extra = {}) {
  return callTelegramBotApi(env, fetchImpl, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    ...extra,
  });
}

async function sendTelegramChatAction(env, fetchImpl, chatId, action = 'typing') {
  return callTelegramBotApi(env, fetchImpl, 'sendChatAction', {
    chat_id: chatId,
    action,
  });
}

function getLatestUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      const text = getMessageText(message);
      if (text) return text;
    }
  }
  return '';
}

function splitTextForStreaming(text) {
  const chunks = String(text || '').match(/\S+\s*/g);
  return chunks && chunks.length > 0 ? chunks : text ? [String(text)] : [''];
}

function buildLocalReply(prompt) {
  // ponytail: local echo fallback; replace with a real provider when OPENAI_BASE_URL is not set.
  return prompt ? `claw: ${prompt}` : 'claw is ready.';
}

function buildChatCompletionsResponse({ model, content }) {
  return json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

function buildChatCompletionChunk({ id, model, created, delta, finishReason }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    ],
  };
}

function buildChatCompletionsStreamResponse({ model, content }) {
  // Source: https://developers.openai.com/api/docs/guides/streaming-responses
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const chunks = splitTextForStreaming(content);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
          id,
          model,
          created,
          delta: { role: 'assistant' },
        }))}\n\n`),
      );

      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
            id,
            model,
            created,
            delta: { content: chunk },
          }))}\n\n`),
        );
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(buildChatCompletionChunk({
          id,
          model,
          created,
          delta: {},
          finishReason: 'stop',
        }))}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: OPENAI_STREAM_HEADERS,
  });
}

function buildModelsResponse(model) {
  return json({
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'claw',
      },
    ],
  });
}

async function proxyOpenAIRequest(request, env, fetchImpl) {
  const upstream = resolveUpstreamUrl(getOpenAIBaseUrl(env), new URL(request.url));
  const headers = new Headers(request.headers);

  if (env?.OPENAI_API_KEY && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${env.OPENAI_API_KEY}`);
  }

  const init = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return fetchImpl(new Request(upstream, init));
}

async function generateConversationReply(messages, env, fetchImpl) {
  const baseUrl = getOpenAIBaseUrl(env);
  const prompt = getLatestUserMessage(messages);
  if (!baseUrl) return buildLocalReply(prompt);

  const upstream = resolveUpstreamUrl(baseUrl, new URL('/v1/chat/completions', baseUrl));
  const model = getConfiguredModel(env);
  const response = await fetchImpl(upstream, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env?.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI upstream failed with ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? '';
  return typeof content === 'string' && content.trim() ? content : buildLocalReply(prompt);
}

async function generateReply(prompt, env, fetchImpl) {
  return generateConversationReply([{ role: 'user', content: prompt }], env, fetchImpl);
}

async function streamConversationReply(messages, env, fetchImpl, onText) {
  const baseUrl = getOpenAIBaseUrl(env);
  const prompt = getLatestUserMessage(messages);

  if (!baseUrl) {
    const content = buildLocalReply(prompt);
    let rendered = '';
    for (const chunk of splitTextForStreaming(content)) {
      rendered += chunk;
      await onText(rendered, chunk);
    }
    return content;
  }

  const upstream = resolveUpstreamUrl(baseUrl, new URL('/v1/chat/completions', baseUrl));
  const model = getConfiguredModel(env);
  const response = await fetchImpl(upstream, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env?.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    return generateConversationReply(messages, env, fetchImpl);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rendered = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let frameIndex = buffer.indexOf('\n\n');

    while (frameIndex !== -1) {
      const frame = buffer.slice(0, frameIndex).trim();
      buffer = buffer.slice(frameIndex + 2);
      frameIndex = buffer.indexOf('\n\n');

      if (!frame) continue;

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') return rendered || buildLocalReply(prompt);

        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          rendered += delta;
          await onText(rendered, delta);
        }
      }
    }
  }

  return rendered || generateConversationReply(messages, env, fetchImpl);
}

function getTelegramMessage(update) {
  const message =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.callback_query?.message;

  return {
    chatId: message?.chat?.id,
    text: getTelegramText(message),
  };
}

async function streamTelegramReply(env, fetchImpl, chatId, messageId, messages, fallbackPrompt, extra = {}, memories = [], webContext = '') {
  // 这一层把 OpenAI 风格的 SSE 增量翻译成 Telegram 的消息编辑。
  // 有 messageId 就原地更新同一条消息；没有 messageId 就退回成一次性 sendMessage。
  let lastRendered = '';

  const conversationMessages = buildTelegramConversationMessages(messages, memories, webContext);
  const finalText = await streamConversationReply(conversationMessages, env, fetchImpl, async (rendered) => {
    lastRendered = rendered;
    if (messageId) {
      await editTelegramMessage(env, fetchImpl, chatId, messageId, rendered, extra);
    }
  });

  const replyText = finalText || lastRendered || buildLocalReply(fallbackPrompt);
  if (!messageId) {
    await sendTelegramMessage(env, fetchImpl, chatId, replyText, extra);
  } else if (replyText !== lastRendered) {
    await editTelegramMessage(env, fetchImpl, chatId, messageId, replyText, extra);
  }

  return replyText;
}

async function generateAndStreamTelegramReply({ update, session, env, fetchImpl }) {
  // Telegram 交互总入口：
  // 1. 先处理显式命令 /start /help /model /reset；
  // 2. 再处理按钮回调 callback_query；
  // 3. 最后把普通文本当成用户提问，进入流式回复。
  const chatId = getTelegramChatId(update);
  if (chatId === null) {
    return json({ ok: true, ignored: true });
  }

  const commandText = getTelegramText(update?.message || update?.edited_message || update?.channel_post);
  const command = parseTelegramCommand(commandText);
  const replyMarkup = { reply_markup: buildTelegramReplyMarkup() };

  if (command === 'start' || command === 'help') {
    // 帮助面板只负责引导用户，不改变会话内容。
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramHelpText(), {
      reply_markup: buildTelegramReplyMarkup(),
    });
    return json({ ok: true, sent: true, command });
  }

  if (command === 'model') {
    // /model 只读展示当前配置，方便用户确认现在走的是本地还是上游模型。
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramModelText(env), {
      reply_markup: buildTelegramReplyMarkup(),
    });
    return json({ ok: true, sent: true, command });
  }

  if (command === 'reset') {
    // /reset 只清短期会话历史和最后一轮状态，不碰长期记忆。
    // 这样用户可以把“会话重置”和“长期记忆清理”分开控制。
    await resetTelegramConversation(session);
    await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramResetText(), {
      reply_markup: buildTelegramReplyMarkup(),
    });
    return json({ ok: true, sent: true, command });
  }

  if (update?.callback_query) {
    // 按钮回调是第二条交互通道：用户点按钮时，Telegram 传的是 callback_data，
    // 不是新的聊天文本，所以这里要把“按钮意图”单独分支处理。
    const callbackQueryId = getTelegramCallbackQueryId(update);
    const callbackData = getTelegramCallbackData(update);
    const callbackMessage = update.callback_query.message;
    const callbackMessageId = callbackMessage?.message_id;

    if (callbackData === 'help') {
      // Help 按钮优先编辑原消息，减少刷屏；没有原消息时再退回新发一条。
      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '已打开帮助');
      }
      if (callbackMessageId) {
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramHelpText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      } else {
        await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramHelpText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }
      return json({ ok: true, sent: true, callback: callbackData });
    }

    if (callbackData === 'reset') {
      // Reset 按钮和 /reset 做同一件事：只清短期对话，不删除长期记忆。
      await resetTelegramConversation(session);
      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '会话已清空');
      }
      if (callbackMessageId) {
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramResetText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      } else {
        await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramResetText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }
      return json({ ok: true, sent: true, callback: callbackData });
    }

    if (callbackData === 'retry') {
      // Retry 的语义是“重新用上一轮用户输入跑一次”，不是单纯重发旧文本。
      if (!session.lastPrompt) {
        // 没有上一轮问题时，不能凭空重试，只能告诉用户先发一条消息。
        if (callbackQueryId) {
          await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '还没有可重试的上一条消息');
        }
        await sendTelegramMessage(env, fetchImpl, chatId, '还没有可重试的上一条消息。', {
          reply_markup: buildTelegramReplyMarkup(),
        });
        return json({ ok: true, sent: true, callback: callbackData, empty: true });
      }

      if (callbackQueryId) {
        await answerTelegramCallbackQuery(env, fetchImpl, callbackQueryId, '正在重新生成...');
      }
      if (callbackMessageId) {
        // 先把旧消息改成“思考中”，让用户知道按钮已经生效。
        await editTelegramMessage(env, fetchImpl, chatId, callbackMessageId, buildTelegramThinkingText(), {
          reply_markup: buildTelegramReplyMarkup(),
        });
      }

      // 去掉上一轮 assistant，保留用户问题，重新喂给模型。
      const history = trimTelegramHistory(session.history.slice());
      if (history[history.length - 1]?.role === 'assistant') {
        history.pop();
      }
      const webContext = await prepareWebContext(session.lastPrompt, fetchImpl);
      const replyText = await streamTelegramReply(
        env,
        fetchImpl,
        chatId,
        callbackMessageId,
        history,
        session.lastPrompt,
        {
          reply_markup: buildTelegramReplyMarkup(),
        },
        session.memories,
        webContext,
      );

      session.history = trimTelegramHistory([...history, { role: 'assistant', content: replyText }]);
      session.lastReply = replyText;
      await saveTelegramSession(session.storage, session);
      return json({ ok: true, sent: true, callback: callbackData, retried: true });
    }
  }

  const text = getTelegramText(update?.message || update?.edited_message || update?.channel_post || update?.callback_query?.message);
  const prompt = text.trim();
  if (!prompt) {
    return json({ ok: true, ignored: true });
  }

  // 普通文本默认视为用户提问：先进历史，再发 typing 和占位消息，最后流式编辑这条占位消息。
  session.history.push({ role: 'user', content: prompt });
  session.history = trimTelegramHistory(session.history);
  session.lastPrompt = prompt;
  // 隐式长期记忆不提供公开命令入口：只在消息像稳定事实或偏好时自动提取，再在保存时自动压缩。
  captureAutomaticTelegramMemories(session, prompt);
  await saveTelegramSession(session.storage, session);

  const webContextPromise = prepareWebContext(prompt, fetchImpl);
  await sendTelegramChatAction(env, fetchImpl, chatId, 'typing');
  // 占位消息是流式输出的锚点，后续每个增量都编辑这条消息。
  const placeholder = await sendTelegramMessage(env, fetchImpl, chatId, buildTelegramThinkingText(), {
    reply_markup: buildTelegramReplyMarkup(),
  });
  const placeholderMessageId = placeholder?.result?.message_id;
  const webContext = await webContextPromise;

  const replyText = await streamTelegramReply(
    env,
    fetchImpl,
    chatId,
    placeholderMessageId,
    session.history,
    prompt,
    {
      reply_markup: buildTelegramReplyMarkup(),
    },
    session.memories,
    webContext,
  );

  session.history.push({ role: 'assistant', content: replyText });
  session.history = trimTelegramHistory(session.history);
  session.lastReply = replyText;
  await saveTelegramSession(session.storage, session);

  return json({ ok: true, sent: true });
}

async function handleTelegramWebhook(request, env, ctx, fetchImpl) {
  if (request.method !== 'POST') return methodNotAllowed('POST');

  const secret = env?.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return json({ ok: false, error: 'invalid secret token' }, { status: 401 });
  }

  const update = await request.json().catch(() => null);
  if (!update) {
    return json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const chatId = getTelegramChatId(update);
  if (chatId === undefined || chatId === null) {
    return json({ ok: true, ignored: true });
  }

  if (!env?.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is required' }, { status: 500 });
  }

  const sessionBinding = env?.TELEGRAM_SESSION;
  if (sessionBinding?.idFromName && sessionBinding?.get) {
    // 有 Durable Object 就按 chatId 串行化：同一个会话只走同一个对象，
    // 这样按钮回调、重试和普通消息不会互相抢状态。
    const sessionStub = sessionBinding.get(sessionBinding.idFromName(String(chatId)));
    // waitUntil 让 webhook 先快速返回，后台继续处理 Telegram 更新。
    // 参考：https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
    const task = sessionStub
      .fetch('https://telegram-session.local/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(update),
      })
      .catch((error) => {
        console.error('TelegramSession failed', error);
      });

    if (typeof ctx?.waitUntil === 'function') {
      ctx.waitUntil(task);
    }

    return json({ ok: true, queued: true });
  }

  const { text } = getTelegramMessage(update);
  if (!text) {
    return json({ ok: true, ignored: true });
  }

  // 没有绑定 DO 时，保留一个同步回退，方便本地跑通和最小部署。
  const reply = await generateReply(text, env, fetchImpl);
  await sendTelegramMessage(env, fetchImpl, chatId, reply);

  return json({ ok: true, sent: true });
}

export class TelegramSession {
  constructor(state, env, fetchImpl = fetch) {
    this.state = state;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async fetch(request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');

    const update = await request.json().catch(() => null);
    if (!update) {
      return json({ ok: false, error: 'invalid json' }, { status: 400 });
    }

    // 一个 DO 代表一个 chat 的会话状态，避免同一对话并发写入时互相覆盖。
    const session = await loadTelegramSession(this.state.storage);
    session.storage = this.state.storage;
    const response = await generateAndStreamTelegramReply({
      update,
      session,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
    delete session.storage;
    return response;
  }
}

async function handleChatCompletions(request, env, fetchImpl) {
  if (request.method !== 'POST') return methodNotAllowed('POST');

  const payload = await request.json().catch(() => null);
  if (!payload) {
    return json({ error: { message: 'invalid json' } }, { status: 400 });
  }

  const model = typeof payload.model === 'string' && payload.model ? payload.model : getConfiguredModel(env);

  if (getOpenAIBaseUrl(env)) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const prompt = getLatestUserMessage(messages);
    const webContext = await prepareWebContext(prompt, fetchImpl);
    const augmentedMessages = buildTelegramConversationMessages(messages, [], webContext);
    const upstream = resolveUpstreamUrl(getOpenAIBaseUrl(env), new URL('/v1/chat/completions', getOpenAIBaseUrl(env)));
    const headers = new Headers(request.headers);

    if (env?.OPENAI_API_KEY && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${env.OPENAI_API_KEY}`);
    }

    headers.set('content-type', 'application/json');
    const response = await fetchImpl(upstream, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...payload,
        model,
        messages: augmentedMessages,
      }),
    });

    return response;
  }

  const prompt = getLatestUserMessage(Array.isArray(payload.messages) ? payload.messages : []);
  const content = buildLocalReply(prompt);

  if (payload.stream) {
    return buildChatCompletionsStreamResponse({
      model,
      content,
    });
  }

  return buildChatCompletionsResponse({
    model,
    content,
  });
}

async function handleModels(request, env, fetchImpl) {
  if (request.method !== 'GET') return methodNotAllowed('GET');

  if (getOpenAIBaseUrl(env)) {
    return proxyOpenAIRequest(request, env, fetchImpl);
  }

  return buildModelsResponse(getConfiguredModel(env));
}

async function handleRequest(request, env = {}, ctx = {}, fetchImpl = fetch) {
  const path = getPath(request);

  if (path === '/' || path === '/health') {
    return json({
      name: 'claw',
      status: 'ok',
    });
  }

  if (path === '/telegram/webhook') {
    return handleTelegramWebhook(request, env, ctx, fetchImpl);
  }

  if (path === '/v1/chat/completions') {
    return handleChatCompletions(request, env, fetchImpl);
  }

  if (path === '/v1/models' || path.startsWith('/v1/models/')) {
    return handleModels(request, env, fetchImpl);
  }

  return notFound();
}

export { handleRequest };

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
