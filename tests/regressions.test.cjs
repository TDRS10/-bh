const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const nodes = {};
  const storage = new Map();
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: { getElementById: id => nodes[id] ||= { innerHTML: '', textContent: '' } },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    setTimeout() {}, clearTimeout() {}, prompt: () => '101',
  });
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + '\nthis.App = BHApp; this.localDay = localDateKey; this.encodeArg = jsArg;', context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData();
  app.showToast = () => {};
  app.saveData = () => {};
  app.renderAll = () => {};
  return { app, context, nodes };
}

test('history renders HTML notes as text and quotes imported IDs safely', () => {
  const { app, nodes, context } = setup();
  const id = "');globalThis.executed=true;//";
  app.data.incomes = [{ id, amount: 10, date: '2026-10-30', notes: '<img src=x onerror=alert(1)>', source: 'test', savingsAmt: 5, essentialsAmt: 3, outingsAmt: 2 }];
  app.renderIncomeHistory();
  assert.ok(!nodes.incomeHistoryList.innerHTML.includes('<img'));
  assert.match(nodes.incomeHistoryList.innerHTML, /&lt;img/);
  const decoded = context.encodeArg(id).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(JSON.parse(decoded), id);
});

test('invalid imported data fails validation before use', () => {
  const { app } = setup();
  for (const bad of [null, [], { incomes: {} }, { expenses: [null] }, { incomes: [{ amount: '100' }] }, { balances: { spendableBalance: Infinity } }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => app.normalizeData(bad));
  }
  const normalized = app.normalizeData({ balances: {}, incomes: [] });
  assert.equal(normalized.balances.spendableBalance, 0);
  assert.equal(normalized.expenses.length, 0);
  assert.equal(normalized.settings.strict.lockDays, 7);
});

test('corrupt snapshot collection cannot break recovery', () => {
  const { app, context } = setup();
  context.localStorage.setItem('BH_APP_SNAPSHOTS', '{}');
  assert.equal(app.recoverFromSnapshot(), null);
});

test('cloud merge keeps deletions from both devices and latest work-day value', () => {
  const { app } = setup();
  const local = app.getDefaultData(), remote = app.getDefaultData();
  local._tombstones = { incomes: { a: 20 } };
  remote._tombstones = { incomes: { b: 30, a: 10 } };
  remote.incomes = [{ id: 'a', amount: 10 }, { id: 'b', amount: 20 }];
  local.workDays = { '2026-10-30': true }; local.workDaysAt = { '2026-10-30': 10 };
  remote.workDays = { '2026-10-30': false }; remote.workDaysAt = { '2026-10-30': 20 };
  const merged = app.mergeCloudData(local, remote, 20, 10);
  assert.equal(merged.incomes.length, 0);
  assert.equal(merged._tombstones.incomes.a, 20);
  assert.equal(merged._tombstones.incomes.b, 30);
  assert.equal(merged.workDays['2026-10-30'], false);
  assert.equal(local._tombstones.incomes.b, undefined);
});

test('failed cloud reads never upload local state', async () => {
  const { app, context } = setup();
  let pushes = 0;
  context.window.BHFirebase = { getUser: () => ({ uid: 'test' }), pull: () => Promise.reject(new Error('offline')), push: () => { pushes++; return Promise.resolve(true); } };
  await app.pullFromCloud();
  assert.equal(pushes, 0);
});

test('a read completed after an account switch is discarded', async () => {
  const { app, context } = setup();
  let uid = 'first', resolve, pushes = 0;
  context.window.BHFirebase = { getUser: () => ({ uid }), pull: () => new Promise(r => resolve = r), push: () => { pushes++; return Promise.resolve(true); } };
  const pending = app.pullFromCloud(); uid = 'second'; resolve(null); await pending;
  assert.equal(pushes, 0);
});

test('backup merge neither restores spent money nor duplicates input IDs', () => {
  const { app } = setup();
  app.data.balances.spendableBalance = 20;
  const backup = app.getDefaultData(); backup.balances.spendableBalance = 500;
  backup.incomes = [{ id: 'a', amount: 10 }, { id: 'a', amount: 10 }];
  app.mergeImported(backup);
  assert.equal(app.data.balances.spendableBalance, 20);
  assert.equal(app.data.incomes.length, 1);
});

test('debt overpayment leaves the balance and debt untouched', () => {
  const { app } = setup();
  app.data.debts = [{ id: 'debt', totalAmount: 100, paidAmount: 0 }];
  app.data.balances.spendableBalance = 1000;
  app.payDebt('debt');
  assert.equal(app.data.debts[0].paidAmount, 0);
  assert.equal(app.data.balances.spendableBalance, 1000);
});

test('calendar key uses local calendar components', () => {
  const { context } = setup();
  assert.equal(context.localDay({ getFullYear: () => 2026, getMonth: () => 9, getDate: () => 31, toISOString() { throw Error('UTC must not be used'); } }), '2026-10-31');
});

test('worker activation removes only older BH caches', async () => {
  const handlers = {}, removed = [];
  const context = vm.createContext({ console, self: { addEventListener: (name, fn) => handlers[name] = fn, clients: { claim() {} } }, caches: { keys: async () => ['other-app', 'bh-finance-v43', 'bh-finance-v45'], delete: async key => removed.push(key) } });
  vm.runInContext(fs.readFileSync('service-worker.js', 'utf8'), context);
  let done; handlers.activate({ waitUntil: p => done = p }); await done;
  assert.deepEqual(removed, ['bh-finance-v43']);
});

test('service layer distinguishes failed reads from an empty database', async () => {
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(fs.readFileSync('js/firebase-service.js', 'utf8'), context);
  const service = context.window.BHFirebase;
  service.getState().user = { uid: 'test' };
  service.getState().db = { ref: () => ({ once: () => Promise.reject(new Error('denied')) }) };
  await assert.rejects(service.pull(), /denied/);
  service.getState().db = { ref: () => ({ once: () => Promise.resolve({ val: () => null }) }) };
  assert.equal(await service.pull(), null);
});
