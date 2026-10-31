const test = require('node:test');
const assert = require('node:assert/strict');
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const namespace = 'demo-bony-chat';
function token(uid, provider = 'google.com', admin = false) {
  const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  return encode({ alg:'none', typ:'JWT' }) + '.' + encode({
    iss:'https://securetoken.google.com/' + namespace, aud:namespace,
    sub:uid, user_id:uid, iat:Math.floor(Date.now()/1000), exp:Math.floor(Date.now()/1000)+3600,
    auth_time:Math.floor(Date.now()/1000), firebase:{ sign_in_provider:provider, identities:{} }, chatAdmin:admin
  }) + '.';
}
test('Realtime Database enforces chat membership, ownership, validation and moderation', { skip:!host }, async () => {
  async function request(path, auth, method = 'GET', body, query = {}) {
    const url = new URL('http://' + host + '/' + path + '.json');
    url.searchParams.set('ns', namespace);
    if (auth) url.searchParams.set('auth', auth);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, JSON.stringify(value));
    return fetch(url, { method, headers:{ 'Content-Type':'application/json' }, body:body === undefined ? undefined : JSON.stringify(body) });
  }
  const alice = token('alice'), bob = token('bob'), guest = token('guest','anonymous'), admin = token('mod','google.com',true);
  const payload = { uid:'alice', name:'Alice', text:'Hello', createdAt:{ '.sv':'timestamp' } };
  const room = 'publicChat/messages', limit = { orderBy:'createdAt', limitToLast:100 };
  const allowed = async p => assert.equal((await p).status, 200);
  const denied = async p => assert.ok([401,403].includes((await p).status));
  await denied(request(room, null, 'GET', undefined, limit));
  await denied(request(room, guest, 'GET', undefined, limit));
  await denied(request(room + '/guest', guest, 'PUT', { ...payload, uid:'guest' }));
  await allowed(request(room + '/one', alice, 'PUT', payload));
  await allowed(request(room, bob, 'GET', undefined, limit));
  await denied(request(room, bob));
  await denied(request(room, bob, 'GET', undefined, { orderBy:'createdAt', limitToLast:101 }));
  await denied(request(room + '/forged', bob, 'PUT', payload));
  await denied(request(room + '/long', alice, 'PUT', { ...payload, text:'x'.repeat(1001) }));
  await denied(request(room + '/extra', alice, 'PUT', { ...payload, extra:'no' }));
  await denied(request(room + '/fakeTime', alice, 'PUT', { ...payload, createdAt:1 }));
  await denied(request(room + '/one/text', bob, 'PUT', 'edited'));
  await denied(request(room + '/one/text', alice, 'PUT', 'edited'));
  await denied(request(room + '/one', bob, 'DELETE'));
  await allowed(request(room + '/one/reactions/bob', bob, 'PUT', true));
  await denied(request(room + '/one/reactions/alice', bob, 'PUT', true));
  await denied(request(room + '/one/reactions/bob', bob, 'PUT', 'bad'));
  await allowed(request(room + '/one/reactions/bob', bob, 'DELETE'));
  await allowed(request('publicChat/reports/one/bob', bob, 'PUT', { createdAt:{ '.sv':'timestamp' } }));
  await denied(request('publicChat/reports', bob));
  await allowed(request('publicChat/reports', admin));
  await denied(request('chatBans/alice', bob, 'PUT', true));
  await allowed(request('chatBans/bob', admin, 'PUT', true));
  await denied(request(room, bob, 'GET', undefined, limit));
  await denied(request(room + '/blocked', bob, 'PUT', { ...payload, uid:'bob' }));
  await allowed(request(room + '/one', admin, 'DELETE'));
  await denied(request(room + '/missing/reactions/alice', alice, 'PUT', true));
  await allowed(request(room + '/own', alice, 'PUT', payload));
  await allowed(request(room + '/own', alice, 'DELETE'));
  await allowed(request('users/alice/app', alice, 'PUT', { private:true }));
  await denied(request('users/alice/app', bob));
});
