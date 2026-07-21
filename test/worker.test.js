import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramSession, handleRequest } from '../src/index.js';

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));

  return {
    async get(key) {
      return data.has(key) ? data.get(key) : undefined;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function getCall(calls, suffix) {
  return calls.find((call) => String(call.input).endsWith(suffix));
}

test('responds with a JSON health payload', async () => {
  const response = await handleRequest(new Request('https://example.com/'), {}, {}, async () => {
    throw new Error('fetch should not be called');
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), {
    name: 'claw',
    status: 'ok',
  });
});

test('returns an OpenAI-compatible chat completion response', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        messages: [
          { role: 'system', content: 'ignore' },
          { role: 'user', content: 'hello' },
        ],
      }),
    }),
    {},
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'demo-model');
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].message.content, 'claw: hello');
});

test('returns a streaming OpenAI-compatible chat completion response', async () => {
  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
    {},
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const text = await response.text();
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"content":"claw: "/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});

test('returns upstream OpenAI-compatible chat completions with web context injected', async () => {
  const upstreamBodies = [];

  const response = await handleRequest(
    new Request('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'demo-model',
        stream: true,
        messages: [
          { role: 'user', content: '搜索 Cloudflare Workers 文档 https://example.com/docs' },
        ],
      }),
    }),
    {
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    {},
    async (input, init) => {
      const url = String(input);

      if (url.includes('html.duckduckgo.com/html/')) {
        return new Response(
          '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fworkers%2F">Cloudflare Workers Docs</a></div>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url === 'https://example.com/docs') {
        return new Response(
          '<html><head><title>Example Docs</title></head><body><h1>Example Docs</h1><p>抓取内容</p></body></html>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"claw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"search"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /网络搜索结果/);
  assert.match(upstreamBodies[0].messages[0].content, /Cloudflare Workers Docs/);
  assert.match(upstreamBodies[0].messages[0].content, /网页抓取内容/);
  assert.match(upstreamBodies[0].messages[0].content, /Example Docs/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.match(upstreamBodies[0].messages.at(-1).content, /搜索 Cloudflare Workers 文档/);
});

test('returns a local OpenAI-compatible model list', async () => {
  const response = await handleRequest(new Request('https://example.com/v1/models'), {}, {}, async () => {
    throw new Error('fetch should not be called');
  });

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.object, 'list');
  assert.equal(payload.data[0].id, 'claw-mini');
});

test('rejects telegram webhook requests with the wrong secret token', async () => {
  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 1 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'invalid secret token',
  });
});

test('sends a telegram reply through the Bot API', async () => {
  const calls = [];

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    },
    {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');
  assert.equal(calls[0].init.method, 'POST');

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    chat_id: 42,
    text: 'claw: ping',
  });
});

test('queues telegram updates to a Durable Object when configured', async () => {
  const calls = [];
  let waited = null;

  const response = await handleRequest(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_SESSION: {
        idFromName(value) {
          return `session:${value}`;
        },
        get() {
          return {
            async fetch(input, init) {
              calls.push({ input, init });
              return new Response(JSON.stringify({ ok: true }), {
                headers: {
                  'content-type': 'application/json',
                },
              });
            },
          };
        },
      },
    },
    {
      waitUntil(promise) {
        waited = promise;
      },
    },
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://telegram-session.local/update');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: {
      chat: { id: 42 },
      text: 'ping',
    },
  });

  await waited;
});

test('TelegramSession sends a help panel for /start', async () => {
  const calls = [];
  const session = new TelegramSession(
    { storage: createStorage() },
    { TELEGRAM_BOT_TOKEN: 'bot-token' },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/start',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /发送消息/);
  assert.doesNotMatch(body.text, /长期记忆/);
  assert.doesNotMatch(body.text, /\/remember/);
  assert.doesNotMatch(body.text, /\/memories/);
  assert.doesNotMatch(body.text, /\/forget/);
  assert.match(body.text, /\/reset - 清空当前会话/);
  assert.deepEqual(
    body.reply_markup.inline_keyboard.flat().map((button) => button.text),
    ['重试', '重置', '帮助'],
  );
  assert.deepEqual(body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
    'retry',
    'reset',
  ]);
});

test('TelegramSession shows the current model for /model', async () => {
  const calls = [];
  const session = new TelegramSession(
    { storage: createStorage() },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      CLAW_MODEL: 'claw-pro',
    },
    async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/model',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.telegram.org/botbot-token/sendMessage');

  const body = JSON.parse(calls[0].init.body);
  assert.match(body.text, /当前模型：claw-pro/);
  assert.match(body.text, /回复模式：本地/);
  assert.match(body.text, /流式输出：已开启/);
});

test('TelegramSession captures hidden memories and keeps them across /reset', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  let response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '以后请用简体中文回复',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  let body = JSON.parse(getCall(calls, '/sendMessage').init.body);
  assert.equal(body.text, '思考中...');

  let stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 2);
  assert.equal(stored.memories.length, 1);
  assert.equal(stored.memories[0].source, 'auto');
  assert.equal(stored.memories[0].text, '用户语言偏好：简体中文');
  assert.equal(stored.storage, undefined);

  response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '/reset',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  body = JSON.parse(calls.at(-1).init.body);
  assert.match(body.text, /会话已清空/);

  stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 0);
  assert.equal(stored.memories.length, 1);
  assert.equal(stored.memories[0].source, 'auto');
  assert.equal(stored.memories[0].text, '用户语言偏好：简体中文');
});

test('TelegramSession ignores ordinary chatter for hidden memories', async () => {
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    { TELEGRAM_BOT_TOKEN: 'bot-token' },
    async (input, init) => {
      const url = String(input);

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '今天先这样，晚点再说',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const stored = await storage.get('telegram-session');
  assert.equal(stored.memories.length, 0);
});

test('TelegramSession automatically compacts older memories', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      history: [],
      memories: [
        { id: 'm-1', text: '记忆 1', source: 'manual', createdAt: 1 },
        { id: 'm-2', text: '记忆 2', source: 'manual', createdAt: 2 },
        { id: 'm-3', text: '记忆 3', source: 'manual', createdAt: 3 },
        { id: 'm-4', text: '记忆 4', source: 'manual', createdAt: 4 },
        { id: 'm-5', text: '记忆 5', source: 'manual', createdAt: 5 },
        { id: 'm-6', text: '记忆 6', source: 'manual', createdAt: 6 },
        { id: 'm-7', text: '记忆 7', source: 'manual', createdAt: 7 },
        { id: 'm-8', text: '记忆 8', source: 'manual', createdAt: 8 },
        { id: 'm-9', text: '记忆 9', source: 'manual', createdAt: 9 },
      ],
      lastPrompt: '',
      lastReply: '',
    },
  });
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const stored = await storage.get('telegram-session');
  assert.equal(stored.memories.length, 7);
  assert.equal(stored.memories[0].source, 'summary');
  assert.match(stored.memories[0].text, /历史摘要：/);
  assert.match(stored.memories[0].text, /记忆 1/);
  assert.deepEqual(
    stored.memories.slice(1).map((memory) => memory.text),
    ['记忆 4', '记忆 5', '记忆 6', '记忆 7', '记忆 8', '记忆 9'],
  );
});

test('TelegramSession injects long-term memories into upstream requests', async () => {
  const calls = [];
  const upstreamBodies = [];
  const storage = createStorage({
    'telegram-session': {
      history: [],
      memories: [
        { id: 'm-1', text: '回复时先用简体中文', source: 'manual', createdAt: 1 },
      ],
      lastPrompt: '',
      lastReply: '',
    },
  });
  const session = new TelegramSession(
    {
      storage,
    },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"claw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"ping"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].stream, true);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /长期记忆/);
  assert.match(upstreamBodies[0].messages[0].content, /回复时先用简体中文/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.equal(upstreamBodies[0].messages.at(-1).content, 'ping');

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert.equal(JSON.parse(edits.at(-1).init.body).text, 'claw: ping');
});

test('TelegramSession injects web search and scrape context into upstream requests', async () => {
  const calls = [];
  const upstreamBodies = [];
  const storage = createStorage();

  const session = new TelegramSession(
    {
      storage,
    },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.includes('html.duckduckgo.com/html/')) {
        return new Response(
          '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fworkers%2F">Cloudflare Workers Docs</a></div>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url === 'https://example.com/docs') {
        return new Response(
          '<html><head><title>Example Docs</title></head><body><h1>Example Docs</h1><p>抓取内容</p></body></html>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          },
        );
      }

      if (url.startsWith('https://upstream.example/')) {
        upstreamBodies.push(JSON.parse(init.body));
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"claw: "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"search"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: '搜索 Cloudflare Workers 文档 https://example.com/docs',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0].messages[0].role, 'system');
  assert.match(upstreamBodies[0].messages[0].content, /网络搜索结果/);
  assert.match(upstreamBodies[0].messages[0].content, /Cloudflare Workers Docs/);
  assert.match(upstreamBodies[0].messages[0].content, /网页抓取内容/);
  assert.match(upstreamBodies[0].messages[0].content, /Example Docs/);
  assert.equal(upstreamBodies[0].messages.at(-1).role, 'user');
  assert.match(upstreamBodies[0].messages.at(-1).content, /搜索 Cloudflare Workers 文档/);

  assert.equal(calls.some((call) => String(call.input).includes('html.duckduckgo.com/html/')), true);
  assert.equal(calls.some((call) => String(call.input) === 'https://example.com/docs'), true);
});

test('TelegramSession streams a reply and stores the turn', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    const url = String(input);

    if (url.endsWith('/sendChatAction')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.endsWith('/editMessageText')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const methods = calls.map((call) => String(call.input).split('/').at(-1));
  assert.deepEqual(methods.slice(0, 2), ['sendChatAction', 'sendMessage']);
  assert(methods.includes('editMessageText'));

  const sendMessage = calls.find((call) => String(call.input).endsWith('/sendMessage'));
  assert.equal(JSON.parse(sendMessage.init.body).text, '思考中...');

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert.equal(JSON.parse(edits.at(-1).init.body).text, 'claw: ping');

  const stored = await storage.get('telegram-session');
  assert.equal(stored.lastPrompt, 'ping');
  assert.equal(stored.lastReply, 'claw: ping');
  assert.deepEqual(
    stored.history.map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('TelegramSession streams upstream deltas into message edits', async () => {
  const calls = [];
  const storage = createStorage();
  const session = new TelegramSession(
    { storage },
    {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      OPENAI_BASE_URL: 'https://upstream.example/v1',
    },
    async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.startsWith('https://upstream.example/')) {
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
          },
        );
      }

      if (url.endsWith('/sendChatAction')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (url.endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chat: { id: 42 },
          text: 'ping',
        },
      }),
    }),
  );

  assert.equal(response.status, 200);

  const edits = calls.filter((call) => String(call.input).endsWith('/editMessageText'));
  assert(edits.length >= 3);
  assert.equal(JSON.parse(edits[0].init.body).text, 'Hel');
  assert.equal(JSON.parse(edits[1].init.body).text, 'Hello');
  assert.equal(JSON.parse(edits.at(-1).init.body).text, 'Hello world');

  const stored = await storage.get('telegram-session');
  assert.equal(stored.lastReply, 'Hello world');
  assert.deepEqual(
    stored.history.map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('TelegramSession handles callback query resets', async () => {
  const calls = [];
  const storage = createStorage({
    'telegram-session': {
      history: [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content: 'claw: ping' },
      ],
      lastPrompt: 'ping',
      lastReply: 'claw: ping',
    },
  });

  const session = new TelegramSession({ storage }, { TELEGRAM_BOT_TOKEN: 'bot-token' }, async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  const response = await session.fetch(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-1',
          data: 'reset',
          from: { id: 7 },
          message: {
            chat: { id: 42 },
            message_id: 9,
            text: '思考中...',
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(String(calls[0].input).endsWith('/answerCallbackQuery'), true);
  assert.equal(String(calls[1].input).endsWith('/editMessageText'), true);

  const body = JSON.parse(calls[1].init.body);
  assert.match(body.text, /会话已清空/);
  const stored = await storage.get('telegram-session');
  assert.equal(stored.history.length, 0);
  assert.equal(stored.lastPrompt, '');
  assert.equal(stored.lastReply, '');
  assert.deepEqual(stored.memories, []);
});
