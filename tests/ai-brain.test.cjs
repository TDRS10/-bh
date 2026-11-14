const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);
const AI_REPLY = 'زد التحويش 5%' + NL + 'حاول تزود نسبة التحويش من القبض شوية كل شهر — هتحس بالفرق بسرعة.';

function setup(opts = {}) {
  const els = {};
  const calls = [];
  const store = Object.assign({}, opts.store || {});
  const context = vm.createContext({
    crypto, TextEncoder, TextDecoder,
    console,
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
    fetch: async (url) => {
      calls.push(url);
      const body = AI_REPLY;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: body } }] }),
        arrayBuffer: async () => {
          const enc = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: body } }] }));
          return enc.buffer;
        }
      };
    },
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + NL + 'this.App = BHApp;', context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData();
  app.data.balances.spendableBalance = 1200;
  app.data.incomes = [{ id: 'x', amount: 2000, savingsAmt: 800, date: '2026-11-02' }];
  app.saveData = () => {};
  app.renderAll = () => {};
  app.showToast = () => {};
  return { app, calls, store, els };
}

test('parseBrainAIReply handles two-line replies', () => {
  const { app } = setup();
  const out = app.parseBrainAIReply('عنوان جاهز' + NL + 'شرح عملي هنا');
  assert.equal(out.title, 'عنوان جاهز');
  assert.equal(out.body, 'شرح عملي هنا');
  assert.equal(app.parseBrainAIReply('   ' + NL + ' '), null);
});

test('summary mentions balances and month income', () => {
  const { app } = setup();
  const s = app.buildBrainSummary();
  assert.match(s, /1200/);
  assert.match(s, /2000/);
  assert.match(s, /التحويش/);
});

test('brainAskAI without key never calls network', async () => {
  const { app, calls } = setup();
  const out = await app.brainAskAI();
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('brainAskAI with key calls OpenRouter and renders the suggestion', async () => {
  const { app, calls, els } = setup({ store: { BH_AI_KEY: 'sk-or-v1-test' } });
  const out = await app.brainAskAI();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /openrouter\.ai/);
  assert.equal(out.title, 'زد التحويش 5%');
  assert.equal(els.brainTitle.textContent, 'زد التحويش 5%');
  assert.equal(els.brainCount.textContent, '🤖');
});
