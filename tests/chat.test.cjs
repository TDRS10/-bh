const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('js/chat.js', 'utf8'), context);
const { member, message } = context.BHChatData;
test('chat excludes signed-out and anonymous users', () => {
  for (const user of [null, {}, { uid:'guest', isAnonymous:true }]) {
    assert.equal(member(user), false);
    assert.throws(() => message(user, 'hello', 1));
  }
  assert.equal(member({ uid:'a', isAnonymous:false }), true);
});
test('chat validates text and publishes no private account information', () => {
  const user = { uid:'a', isAnonymous:false, displayName:'A'.repeat(90), email:'private@example.com' };
  for (const text of ['', '   ', 'x'.repeat(1001)]) assert.throws(() => message(user, text, 1));
  const output = message(user, '  <img onerror=alert(1)>  ', 1);
  assert.deepEqual(Object.keys(output).sort(), ['createdAt', 'name', 'text', 'uid']);
  assert.equal(output.name.length, 60);
  assert.equal(output.text, '<img onerror=alert(1)>');
  assert.equal(message(user, 'x'.repeat(1000), 1).text.length, 1000);
});

function ui() {
  class Element {
    constructor(tag = '') { this.tag = tag; this.childNodes = []; this.dataset = {}; this.events = {}; this.value = ''; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 500; }
    append(...nodes) { this.childNodes.push(...nodes.flatMap(n => n.tag === 'fragment' ? n.childNodes : [n])); }
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return []; }
  }
  const nodes = {}, subscriptions = [], writes = [];
  let ready, statusListener;
  const state = { user:null, db:{ ref(path) {
    return {
      path, orderByChild() { return this; }, limitToLast() { return this; },
      on(event, callback, error) { subscriptions.push({ path, callback, error, active:true }); },
      off(event, callback) { subscriptions.filter(s => s.path === path && s.callback === callback).forEach(s => s.active = false); },
      push() { return this; }, set(payload) { writes.push({ path, payload }); return Promise.resolve(); }
    };
  } } };
  const document = {
    getElementById:id => nodes[id] ||= new Element(),
    createElement:tag => new Element(tag),
    createDocumentFragment:() => new Element('fragment'),
    addEventListener:(name, fn) => { ready = fn; }
  };
  const window = { BHFirebase:{ getState:() => state, onStatusChange:fn => { statusListener = fn; fn(); } }, firebase:{ database:{ ServerValue:{ TIMESTAMP:{ '.sv':'timestamp' } } } } };
  vm.runInNewContext(fs.readFileSync('js/chat.js', 'utf8'), { window, document, console, Event:class {} });
  ready();
  const login = uid => { state.user = uid ? { uid, isAnonymous:false, getIdTokenResult:async () => ({ claims:{} }) } : null; statusListener(); };
  return { window, nodes, subscriptions, writes, login };
}

test('chat detaches listeners on exit/sign-out and ignores callbacks from previous accounts', () => {
  const app = ui();
  app.window.BHChat.setVisible(true);
  assert.equal(app.subscriptions.length, 0);
  app.login('alice');
  const old = app.subscriptions.find(s => s.path === 'publicChat/messages');
  assert.ok(old.active);
  app.login('bob');
  assert.equal(old.active, false);
  old.callback({ forEach() { throw new Error('stale callback was used'); } });
  app.login(null);
  assert.equal(app.subscriptions.some(s => s.active), false);
  assert.equal(app.nodes.chatMessages.childNodes.length, 0);
  assert.equal(app.nodes.chatForm.hidden, true);
  app.login('bob');
  app.window.BHChat.setVisible(false);
  assert.equal(app.subscriptions.some(s => s.active), false);
});

test('chat renders untrusted names and messages as text and disables offline sends', async () => {
  const app = ui();
  app.login('alice');
  app.window.BHChat.setVisible(true);
  const room = app.subscriptions.find(s => s.path === 'publicChat/messages');
  room.callback({ forEach(fn) { fn({ key:'one', val:() => ({ uid:'bob', name:'<script>bad()</script>', text:'<img onerror=bad()>', createdAt:1000 }) }); } });
  const article = app.nodes.chatMessages.childNodes[0];
  assert.equal(article.childNodes[1].textContent, '<img onerror=bad()>');
  assert.equal(article.childNodes[0].childNodes[1].textContent, '<script>bad()</script>');
  assert.equal(app.nodes.chatSend.disabled, true);
  await app.nodes.chatForm.events.submit({ preventDefault() {} });
  assert.equal(app.writes.length, 0);
  room.error({ code:'PERMISSION_DENIED' });
  assert.equal(app.nodes.chatMessages.childNodes.length, 0);
  assert.equal(app.nodes.chatSend.disabled, true);
});
