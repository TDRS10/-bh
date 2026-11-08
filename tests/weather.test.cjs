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
  return app;
}

test('weatherInfo gives clear sky ok and rain warnings', () => {
  const app = setup();
  const clear = app.weatherInfo(0, 25, 0, 5);
  assert.equal(clear.label, 'صافي');
  assert.equal(clear.level, 'ok');

  const storm = app.weatherInfo(96, 22, 90, 10);
  assert.equal(storm.level, 'danger');

  const hot = app.weatherInfo(1, 39, 0, 3);
  assert.equal(hot.level, 'warn');

  const fog = app.weatherInfo(48, 18, 0, 2);
  assert.equal(fog.level, 'warn');
});
