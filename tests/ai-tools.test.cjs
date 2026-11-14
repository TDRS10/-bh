const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);

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
      const body = opts.reply || 'رد الذكاء';
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
  app.data.balances.spendableBalance = 900;
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const prev = new Date(d); prev.setDate(d.getDate() - 7);
  const prevISO = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0') + '-' + String(prev.getDate()).padStart(2, '0');
  app.data.incomes = [
    { id: 'a', amount: 1500, savingsAmt: 500, date: today },
    { id: 'b', amount: 700, savingsAmt: 200, date: prevISO }
  ];
  app.data.expenses = [
    { id: 'e1', amount: 300, category: 'بنزين', date: today },
    { id: 'e2', amount: 100, category: 'أكل', date: prevISO }
  ];
  app.data.workDays = { [today]: true };
  app.saveData = () => {};
  app.renderAll = () => {};
  app.showToast = () => {};
  ['askBoniInput', 'askBoniOut', 'weeklyAIOut', 'smartSplitOut', 'smartSplitApply'].forEach(id => {
    els[id] = { textContent: '', style: {}, className: '', value: '' };
  });
  return { app, calls, store, els };
}

test('week summary separates this week from last week', () => {
  const { app } = setup();
  const w = app.buildWeekSummary();
  assert.equal(w.income, 1500);
  assert.equal(w.prevIncome, 700);
  assert.equal(w.spent, 300);
  assert.equal(w.prevSpent, 100);
  assert.equal(w.days, 1);
  assert.match(w.top[0], /بنزين/);
});

test('askAI without key never touches network', async () => {
  const { app, calls } = setup();
  const out = await app.askAI('sys', 'user');
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('askBoni sends question and renders reply', async () => {
  const { app, calls, els } = setup({ store: { BH_AI_KEY: 'sk-or-v1-test' }, reply: 'أيوه تقدر' + NL + 'معاك 900 كافي' });
  els.askBoniInput.value = 'أقدر أصرف 500؟';
  const out = await app.askBoni();
  assert.equal(calls.length, 1);
  assert.equal(els.askBoniOut.textContent, 'أيوه تقدر' + NL + 'معاك 900 كافي');
});

test('smartSplit parses JSON and apply writes ratios', async () => {
  const { app, els } = setup({ store: { BH_AI_KEY: 'sk-or-v1-test' }, reply: '{"savings":60,"essentials":35,"outings":5}' });
  const split = await app.smartSplit();
  assert.equal(split.savings, 60);
  assert.equal(split.essentials, 35);
  assert.equal(split.outings, 5);
  app.applySmartSplit();
  assert.equal(app.data.settings.savingsRatio, 60);
  assert.equal(app.data.settings.outingsRatio, 5);
});

test('smartSplit rejects malformed replies', async () => {
  const { app } = setup({ store: { BH_AI_KEY: 'sk-or-v1-test' }, reply: 'مش JSON خالص' });
  const split = await app.smartSplit();
  assert.equal(split, null);
});
