const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function setup() {
  const context = vm.createContext({ crypto, console, window: { addEventListener() {} }, document: {}, localStorage: {}, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(fs.readFileSync('js/wallet.js', 'utf8') + '\nthis.wallet = BHWallet;', context);
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + '\nthis.App = BHApp;', context);
  vm.runInContext(fs.readFileSync('js/cards.js', 'utf8'), context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData(); app.saveData = () => {}; app.renderAll = () => {};
  return { wallet: context.wallet, app, context };
}
function card(wallet, data, overrides = {}) {
  return wallet.create(data, { name: 'فيزا المرتب', bank: 'بنك مصر', brand: 'visa', last4: '1234', logo: '', opening: '1000', accountId: '', ...overrides });
}

test('new card retains existing budget and adds its opening balance once', () => {
  const { wallet, app } = setup();
  app.data.balances.spendableBalance = 600;
  const next = card(wallet, app.data);
  assert.equal(wallet.total(next), 100000);
  assert.equal(next.balances.spendableBalance, 600);
  assert.equal(next.incomes.length, 0);
  assert.equal(app.data.walletAccounts.length, 0);
});

test('two cards for one account share the balance without duplicating total', () => {
  const { wallet, app } = setup();
  let data = card(wallet, app.data);
  const accountId = data.walletAccounts[0].id;
  data = card(wallet, data, { name: 'كارت إضافي', brand: 'mastercard', accountId, opening: '9999' });
  assert.equal(data.walletCards.length, 2);
  assert.equal(data.walletAccounts.length, 1);
  assert.equal(wallet.total(data), 100000);
});

test('transfer has exactly one immutable movement and preserves total', () => {
  const { wallet, app } = setup();
  let data = card(wallet, app.data);
  data = card(wallet, data, { name: 'الكاش', brand: 'cash', opening: '50' });
  const [from, to] = data.walletAccounts.map(a => a.id);
  const moved = wallet.move(data, { kind: 'transfer', from, to, amount: '120.25' });
  assert.equal(wallet.balance(moved, from), 87975);
  assert.equal(wallet.balance(moved, to), 17025);
  assert.equal(wallet.total(moved), 105000);
  assert.equal(moved.walletEntries.length, data.walletEntries.length + 1);
  assert.equal(wallet.balance(data, from), 100000);
});

test('deposit and withdrawal use exact piastres and do not alter global reports', () => {
  const { wallet, app } = setup();
  let data = card(wallet, app.data, { opening: '0.10' });
  const account = data.walletAccounts[0].id;
  data = wallet.move(data, { kind: 'deposit', to: account, amount: '0.20' });
  assert.equal(wallet.balance(data, account), 30);
  data = wallet.move(data, { kind: 'withdrawal', from: account, amount: '0.30' });
  assert.equal(wallet.balance(data, account), 0);
  assert.equal(data.incomes.length, 0); assert.equal(data.expenses.length, 0);
});

test('invalid amounts, self transfers and overdrafts cannot modify state', () => {
  const { wallet, app } = setup();
  const data = card(wallet, app.data), account = data.walletAccounts[0].id;
  for (const amount of ['-1','Infinity','NaN','1.001','','1e6','1000000001']) assert.throws(() => wallet.money(amount));
  assert.throws(() => wallet.move(data, { kind: 'transfer', from: account, to: account, amount: '10' }));
  assert.throws(() => wallet.move(data, { kind: 'withdrawal', from: account, amount: '1001' }));
  assert.throws(() => wallet.move(data, { kind: 'deposit', to: 'missing', amount: '1' }));
  assert.equal(wallet.total(data), 100000);
});

test('card numbers and unsafe logo sources are rejected', () => {
  const { wallet, app } = setup();
  for (const overrides of [{last4:'1234567812345678'}, {last4:'<img'}, {logo:'https://tracking.invalid/logo'}, {logo:'data:image/svg+xml;base64,abcd'}, {brand:'<script>'}]) {
    assert.throws(() => card(wallet, app.data, overrides));
  }
});

test('old backups gain empty wallet collections and new backups round trip', () => {
  const { wallet, app } = setup();
  const old = app.normalizeData({ incomes: [], balances: {} });
  assert.equal(old.walletAccounts.length, 0);
  const created = card(wallet, old);
  const restored = app.normalizeData(JSON.parse(JSON.stringify(created)));
  assert.equal(wallet.total(restored), 100000);
  assert.equal(restored.walletCards[0].last4, '1234');
});

test('cloud union retains independent movements from both devices exactly once', () => {
  const { wallet, app } = setup();
  const original = card(wallet, app.data), account = original.walletAccounts[0].id;
  const local = wallet.move(original, { kind: 'withdrawal', from: account, amount: '10' });
  const remote = wallet.move(original, { kind: 'withdrawal', from: account, amount: '20' });
  const merged = app.mergeCloudData(local, remote, 2, 1);
  assert.equal(wallet.total(merged), 97000);
  const repeated = app.mergeCloudData(merged, remote, 2, 1);
  assert.equal(wallet.total(repeated), 97000);
  assert.equal(repeated.walletEntries.length, 3);
});

test('wallet deletion tombstones prevent resurrection after reset', () => {
  const { wallet, app, context } = setup();
  const remote = card(wallet, app.data);
  app.data = remote;
  app._saveSnapshot = () => {};
  app.showToast = () => {};
  context.confirm = () => true;
  context.localStorage.removeItem = () => {};
  app.confirmResetData();
  const merged = app.mergeCloudData(app.data, remote, 2, 1);
  assert.equal(merged.walletCards.length, 0);
  assert.equal(wallet.total(merged), 0);
});

test('backup merge retains wallet data without doubling it on repeat import', () => {
  const { wallet, app } = setup();
  const backup = card(wallet, app.data);
  app.mergeImported(backup); app.mergeImported(backup);
  assert.equal(app.data.walletCards.length, 1);
  assert.equal(wallet.total(app.data), 100000);
});

test('storage failure leaves in-memory wallet unchanged', () => {
  const { wallet, app, context } = setup();
  context.localStorage.setItem = () => { throw Error('full'); };
  assert.throws(() => app.persistWallet(card(wallet, app.data)), /full/);
  assert.equal(app.data.walletCards.length, 0);
});

test('tampered imported ledger amounts and duplicate IDs are rejected', () => {
  const { wallet, app } = setup();
  const data = card(wallet, app.data);
  data.walletEntries[0].cents = 0.5;
  assert.throws(() => app.normalizeData(data));
  data.walletEntries[0].cents = 100;
  data.walletEntries.push({...data.walletEntries[0]});
  assert.throws(() => app.normalizeData(data));
});

test('wallet render escapes card names and exposes shared account total once', () => {
  const { wallet, app, context } = setup();
  const elements = {};
  context.document.getElementById = id => elements[id] ||= { value: '', innerHTML: '', textContent: '' };
  app.data = card(wallet, app.data, { name: '<img onerror=alert(1)>', bank: '<b>bank</b>' });
  app.data = card(wallet, app.data, { accountId: app.data.walletAccounts[0].id });
  app.renderWallet();
  assert.ok(!elements.walletCards.innerHTML.includes('<img onerror'));
  assert.ok(elements.walletCards.innerHTML.includes('&lt;img'));
  assert.ok(elements.walletCards.innerHTML.includes('رصيد الحساب المشترك'));
  assert.equal(elements.walletTotal.textContent, app.walletMoney(100000));
});

test('all wallet form IDs exist uniquely and field handlers compile', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const code = fs.readFileSync('js/cards.js', 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const referenced = [...code.matchAll(/(?:getElementById|value)\('(wallet\w+)'\)/g)].map(m => m[1]);
  for (const id of new Set(referenced)) assert.equal(ids.filter(x => x === id).length, 1, id);
  for (const match of html.matchAll(/on(?:submit|change|click)="(app\.(?:wallet\w+|renderWalletHistory)[^"]*)"/g)) assert.doesNotThrow(() => new Function('event', match[1]));
});
