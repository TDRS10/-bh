const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);

function setup(opts = {}) {
  const els = {};
  const calls = [];
  const store = {};
  const context = vm.createContext({
    crypto, TextEncoder, TextDecoder,
    window: {
      addEventListener() {},
      location: { href: 'http://x/' },
      BHFirebase: opts.firebase
    },
    location: { href: 'http://x/' },
    document: {
      getElementById: (id) => (els[id] = els[id] || { textContent: '', style: {}, className: '', value: '' }),
      activeElement: null,
      createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {}, appendChild() {} }),
      body: { appendChild() {}, removeChild() {} }
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    navigator: opts.navigator || { canShare: () => false },
    Blob: class { constructor(p) { this.parts = p; } },
    File: class { constructor(p, name) { this.name = name; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + NL + 'this.App = BHApp;', context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData();
  app.saveData = () => {};
  app.renderAll = () => {};
  app.showToast = (m) => calls.push('toast:' + m);
  app.downloadBackup = () => { calls.push('download'); return true; };
  return { app, calls, els };
}

test('countEntries counts incomes expenses goals and debts only', () => {
  const { app } = setup();
  app.data.incomes = [{ id: 1 }, { id: 2 }];
  app.data.expenses = [{ id: 3 }];
  app.data.goals = [{ id: 4 }];
  app.data.debts = [];
  app.data.workDays = { '2026-11-01': true, '2026-11-02': true };
  assert.equal(app.countEntries(), 4);
});

test('shareBackup falls back to download when file sharing is unsupported', async () => {
  const { app, calls } = setup();
  const ok = await app.shareBackup();
  assert.equal(ok, true);
  assert.ok(calls.includes('download'), 'should download when share unsupported');
});

test('shareBackup uses navigator.share when files are supported', async () => {
  const shared = [];
  const { app, calls } = setup({
    navigator: {
      canShare: () => true,
      share: async (payload) => { shared.push(payload); }
    }
  });
  const ok = await app.shareBackup();
  assert.equal(ok, true);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].files.length, 1);
  assert.ok(!calls.includes('download'), 'should not download when share works');
});

test('restoreFromCloud refuses without a signed-in user', async () => {
  const { app, calls } = setup({ firebase: { getUser: () => null } });
  const ok = await app.restoreFromCloud();
  assert.equal(ok, false);
  assert.ok(calls.some(c => /سجل دخول/.test(c)), 'should ask the user to sign in');
});

test('restoreFromCloud pulls when signed in and reports the count', async () => {
  const { app, calls } = setup({ firebase: { getUser: () => ({ uid: 'u1' }) } });
  app.pullFromCloud = async () => {
    app.data.incomes = [{ id: 1 }, { id: 2 }, { id: 3 }];
  };
  const ok = await app.restoreFromCloud();
  assert.equal(ok, true);
  assert.ok(calls.some(c => /اترجّع 3 عنصر/.test(c)), 'should report restored entries');
});
