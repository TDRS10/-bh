const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);

function setup(replies) {
  const els = {};
  const calls = [];
  const store = { BH_AI_KEY: 'sk-or-v1-test' };
  let i = 0;
  const context = vm.createContext({
    crypto, TextEncoder, TextDecoder,
    window: { addEventListener() {}, location: { href: 'http://localhost:8900/index.html' } },
    location: { href: 'http://localhost:8900/index.html' },
    document: {
      getElementById: (id) => (els[id] = els[id] || { textContent: '', style: {}, className: '', value: '' }),
      activeElement: null
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      const rep = replies[Math.min(i++, replies.length - 1)];
      const payload = typeof rep.body === 'function' ? rep.body() : rep.body;
      return {
        ok: rep.status >= 200 && rep.status < 300,
        status: rep.status,
        text: async () => payload,
        arrayBuffer: async () => new TextEncoder().encode(payload).buffer
      };
    },
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + NL + 'this.App = BHApp;', context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData();
  app.saveData = () => {};
  app.renderAll = () => {};
  app.showToast = () => {};
  return { app, calls, els };
}

const OK = (content, extra = {}) => ({
  status: 200,
  body: JSON.stringify(Object.assign({ choices: [{ message: { content } }] }, extra))
});

test('aiChat falls back to reasoning when content is empty', async () => {
  const { app } = setup([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '', reasoning: 'الخلاصة: زود التحويش' } }] }) }]);
  const out = await app.aiChat('sys', 'user');
  assert.equal(out, 'الخلاصة: زود التحويش');
});

test('aiChat retries once and succeeds after a 404 model error', async () => {
  const { app, calls } = setup([
    { status: 404, body: JSON.stringify({ error: { message: 'This model is unavailable' } }) },
    OK('الرد النهائي')
  ]);
  const out = await app.aiChat('sys', 'user');
  assert.equal(out, 'الرد النهائي');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.max_tokens > calls[0].body.max_tokens, 'retry should use more tokens');
});

test('aiChat always asks for at least 1200 tokens (reasoning models need it)', async () => {
  const { app, calls } = setup([OK('تمام')]);
  await app.aiChat('sys', 'user', 220);
  assert.ok(calls[0].body.max_tokens >= 1200);
});

test('aiChat surfaces the provider error message', async () => {
  const { app } = setup([{ status: 401, body: JSON.stringify({ error: { message: 'No auth credentials found' } }) }]);
  await assert.rejects(() => app.aiChat('sys', 'user'), /No auth credentials/);
});

test('isChatModel drops audio and omni models', () => {
  const { app } = setup([OK('x')]);
  assert.equal(app.isChatModel('google/gemma-4-31b-it:free'), true);
  assert.equal(app.isChatModel('google/lyria-3-pro-preview'), false);
  assert.equal(app.isChatModel('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'), false);
  assert.equal(app.isChatModel('openrouter/free'), true);
});
