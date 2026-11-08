const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function setup() {
  const context = vm.createContext({ crypto, console, window: { addEventListener() {} }, document: {}, localStorage: {}, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + '\nthis.App = BHApp;', context);
  const app = Object.create(context.App.prototype);
  app.data = app.getDefaultData();
  app.saveData = () => {};
  app.renderAll = () => {};
  return app;
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

test('all-healthy data gives a single fallback nudge', () => {
  const app = setup();
  app.data.balances.spendableBalance = 1000;
  app.data.balances.reservedSavings = 0;
  app.data.incomes = [{ id: 'x', amount: 1000, savingsAmt: 500, date: todayISO() }];
  app.data.workDays = { [todayISO()]: true };
  const list = app.getBrainAdvice();
  assert.equal(list.length, 1);
  assert.equal(list[0].icon, '💡');
  assert.ok(list[0].target);
});

test('fresh data still yields actionable suggestions', () => {
  const app = setup();
  const list = app.getBrainAdvice();
  assert.ok(list.length >= 1);
  list.forEach(a => {
    assert.ok(a.icon && a.title && a.body && a.target, 'suggestion missing fields');
  });
});

test('overdue debt is the first suggestion', () => {
  const app = setup();
  app.data.debts = [{ id: 1, creditor: 'شركة التمويل', totalAmount: 3000, paidAmount: 1000, dueDate: daysAgoISO(2) }];
  const list = app.getBrainAdvice();
  assert.equal(list[0].icon, '📌');
  assert.match(list[0].title, /شركة التمويل/);
  assert.match(list[0].body, /2,000/);
});

test('empty balance outranks other suggestions', () => {
  const app = setup();
  app.data.balances.spendableBalance = 0;
  const list = app.getBrainAdvice();
  const crisis = list.find(a => a.icon === '🆘');
  assert.ok(crisis, 'should include empty-balance crisis');
});

test('goal at 80% suggests topping it up', () => {
  const app = setup();
  app.data.balances.spendableBalance = 5000;
  app.data.goals = [{ id: 1, title: 'موبايل', targetAmount: 10000, currentAmount: 8200 }];
  app.data.incomes = [{ id: 'x', amount: 1000, savingsAmt: 500, date: todayISO() }];
  app.data.workDays = { [todayISO()]: true };
  const list = app.getBrainAdvice();
  const goal = list.find(a => a.icon === '🎯');
  assert.ok(goal, 'should suggest near-complete goal');
  assert.match(goal.body, /1,800/);
});
