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

test('month summary counts only the requested month and ranks top expenses', () => {
  const app = setup();
  app.data.incomes = [
    { id: 'a', amount: 1000, savingsAmt: 200, date: '2026-11-02' },
    { id: 'b', amount: 500, savingsAmt: 100, date: '2026-11-20' },
    { id: 'c', amount: 9000, savingsAmt: 1800, date: '2026-10-31' }
  ];
  app.data.expenses = [
    { id: 'e1', amount: 100, category: 'أكل', date: '2026-11-03' },
    { id: 'e2', amount: 300, category: 'بنزين', date: '2026-11-04' },
    { id: 'e3', amount: 50, category: 'أكل', date: '2026-11-05' },
    { id: 'e4', amount: 7000, category: 'إيجار', date: '2026-09-01' }
  ];
  app.data.workDays = { '2026-11-01': true, '2026-11-02': true, '2026-11-03': false, '2026-10-05': true };

  const s = app.getMonthSummary(new Date(2026, 10, 15));

  assert.equal(s.monthKey, '2026-11');
  assert.equal(s.income, 1500);
  assert.equal(s.spent, 450);
  assert.equal(s.saved, 300);
  assert.deepEqual(Array.from(s.top, t => t.category), ['بنزين', 'أكل']);
  assert.equal(s.top[0].pct, 67);
  assert.equal(s.days, 2);
});

test('empty month yields zeros and no category rows', () => {
  const app = setup();
  const s = app.getMonthSummary(new Date(2026, 4, 10));
  assert.equal(s.income, 0);
  assert.equal(s.spent, 0);
  assert.equal(s.saved, 0);
  assert.equal(s.top.length, 0);
  assert.equal(s.days, 0);
});
