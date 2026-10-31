/* The public room is separate from private budgets and their backup/sync flow. */
(function (root) {
  'use strict';
  const PATH = 'publicChat/messages';
  function member(user) { return !!(user && user.uid && user.isAnonymous === false); }
  function message(user, text, timestamp) {
    if (!member(user)) throw new Error('سجّل بحساب Google الأول.');
    text = String(text || '').trim();
    if (!text || text.length > 1000) throw new Error('اكتب رسالة من 1 إلى 1000 حرف.');
    return { uid: user.uid, name: String(user.displayName || 'عضو بوني').slice(0, 60), text, createdAt: timestamp };
  }
  // Exposed pure validation is also used by the regression suite.
  root.BHChatData = { member, message };
  if (typeof document === 'undefined') return;
  document.addEventListener('DOMContentLoaded', function () {
    const $ = id => document.getElementById(id);
    const list = $('chatMessages'), form = $('chatForm'), input = $('chatText'), send = $('chatSend');
    let visible = false, uid = null, generation = 0, query = null, callback = null;
    let connectedRef = null, connectedCallback = null, connected = false, loaded = false, sending = false;
    let admin = false, rows = [], lastSent = 0, failed = false;
    const state = () => root.BHFirebase.getState();
    function status(text) { $('chatStatus').textContent = text; }
    function controls() { send.disabled = !loaded || !connected || sending || failed; }
    function error(err) {
      const denied = /permission|denied/i.test(String(err && (err.code || err.message)));
      status(denied ? 'الشات غير متاح لحسابك حاليًا. قد تحتاج قواعد الشات للتفعيل من إدارة الموقع.' : 'تعذّر الاتصال بالشات. راجع الإنترنت وحاول تاني.');
    }
    function stop() {
      generation++;
      if (query && callback) query.off('value', callback);
      if (connectedRef && connectedCallback) connectedRef.off('value', connectedCallback);
      query = callback = connectedRef = connectedCallback = null;
      uid = null; rows = []; connected = loaded = sending = admin = failed = false;
      list.replaceChildren(); input.value = ''; $('chatCount').textContent = '0 / 1000';
      $('chatLatest').hidden = true; controls();
    }
    function node(tag, cls, text) {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function bottom() { list.scrollTop = list.scrollHeight; $('chatLatest').hidden = true; }
    function render() {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
      const scroll = list.scrollTop;
      const focused = document.activeElement;
      const focusKey = focused && focused.dataset.chatKey;
      const frag = document.createDocumentFragment();
      rows.forEach(({ key, value: m }) => {
        if (!m || typeof m.text !== 'string' || typeof m.uid !== 'string') return;
        const own = m.uid === uid;
        const article = node('article', 'chat-message' + (own ? ' is-own' : ''));
        const header = node('header');
        header.append(node('span', 'chat-avatar', String(m.name || 'ب').slice(0, 1)), node('strong', '', String(m.name || 'عضو بوني') + (own ? ' · أنت' : '')));
        const time = node('time');
        if (typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)) {
          const date = new Date(m.createdAt);
          time.dateTime = date.toISOString();
          time.textContent = date.toLocaleString('ar-EG', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        }
        header.append(time); article.append(header, node('p', '', m.text));
        const footer = node('footer');
        function action(label, kind, fn) {
          const button = node('button', '', label); button.type = 'button';
          button.dataset.chatKey = key + ':' + kind;
          button.addEventListener('click', async () => {
            if (!connected || !loaded || failed || !member(state().user)) return status('اتصل بالإنترنت وسجّل دخولك الأول.');
            const version = generation;
            button.disabled = true;
            try { await fn(); } catch (err) { if (version === generation) error(err); }
            finally { if (version === generation) button.disabled = false; }
          });
          footer.append(button); return button;
        }
        const reactions = m.reactions || {};
        const liked = reactions[uid] === true;
        const like = action('❤️ ' + Object.values(reactions).filter(v => v === true).length, 'like', () => state().db.ref(PATH + '/' + key + '/reactions/' + uid).set(liked ? null : true));
        like.setAttribute('aria-pressed', String(liked)); like.setAttribute('aria-label', 'إعجاب برسالة ' + String(m.name || 'عضو'));
        if (own || admin) action('حذف', 'delete', () => {
          if (root.confirm('تمسح الرسالة من الشات للجميع؟')) return state().db.ref(PATH + '/' + key).remove();
        });
        else action('إبلاغ', 'report', async () => {
          if (!root.confirm('إرسال بلاغ عن الرسالة للمراجعة؟')) return;
          const version = generation;
          await state().db.ref('publicChat/reports/' + key + '/' + uid).set({ createdAt: root.firebase.database.ServerValue.TIMESTAMP });
          if (version === generation) status('وصل البلاغ للمراجعة.');
        });
        article.append(footer); frag.append(article);
      });
      if (!frag.childNodes.length) frag.append(node('p', 'chat-empty', 'لسه مفيش رسائل. ابدأ اللمة بأول رسالة 👋'));
      list.replaceChildren(frag);
      if (focusKey) Array.from(list.querySelectorAll('button')).find(b => b.dataset.chatKey === focusKey)?.focus({ preventScroll:true });
      if (nearBottom || !loaded) bottom();
      else { list.scrollTop = scroll; $('chatLatest').hidden = false; }
    }
    function sync() {
      const s = state(), allowed = member(s.user);
      $('chatGate').hidden = allowed;
      list.hidden = form.hidden = !allowed;
      if (!visible || !allowed || !s.db) {
        if (uid || query) stop();
        if (visible) status(allowed ? 'جاري تجهيز الاتصال…' : 'الشات للمسجّلين فقط؛ حساب الضيف لا يتيح الدخول.');
        return;
      }
      if (uid === s.user.uid) return;
      stop(); uid = s.user.uid; const version = generation;
      status('جاري تحميل الرسائل…');
      s.user.getIdTokenResult().then(result => {
        if (version !== generation) return;
        admin = result.claims.chatAdmin === true;
        if (loaded) render();
      }).catch(() => {});
      connectedRef = s.db.ref('.info/connected');
      connectedCallback = snap => {
        if (version !== generation) return;
        connected = snap.val() === true; controls();
        if (!failed) status(connected ? (loaded ? 'متصل · الرسائل بتتحدث تلقائيًا' : 'جاري تحميل الرسائل…') : 'الاتصال مقطوع؛ الإرسال متوقف لحد ما ترجع أونلاين.');
      };
      connectedRef.on('value', connectedCallback);
      query = s.db.ref(PATH).orderByChild('createdAt').limitToLast(100);
      callback = snap => {
        if (version !== generation) return;
        rows = []; snap.forEach(child => { rows.push({ key:child.key, value:child.val() }); });
        render(); loaded = true; failed = false; controls();
        status(connected ? 'متصل · الرسائل بتتحدث تلقائيًا' : 'الاتصال مقطوع؛ الإرسال متوقف.');
      };
      query.on('value', callback, err => {
        if (version !== generation) return;
        failed = true; loaded = false; list.replaceChildren(); rows = []; controls(); error(err);
      });
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (sending || !loaded || !connected || failed) return;
      const version = generation;
      const original = input.value;
      try {
        if (Date.now() - lastSent < 3000) return status('استنى 3 ثواني بين كل رسالة والتانية.');
        const payload = message(state().user, original, root.firebase.database.ServerValue.TIMESTAMP);
        sending = true; controls(); status('جاري الإرسال…');
        await state().db.ref(PATH).push().set(payload);
        if (version !== generation) return;
        lastSent = Date.now();
        if (input.value === original) input.value = '';
        input.dispatchEvent(new Event('input')); bottom(); status('تم إرسال رسالتك.');
      } catch (err) {
        if (version === generation) {
          if (!err.code) status(err.message); else error(err);
        }
      } finally { if (version === generation) { sending = false; controls(); } }
    });
    input.addEventListener('input', () => { $('chatCount').textContent = input.value.length + ' / 1000 · Enter للإرسال، Shift + Enter لسطر جديد'; });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    $('chatLatest').addEventListener('click', bottom);
    list.addEventListener('scroll', () => { if (list.scrollHeight - list.scrollTop - list.clientHeight < 100) $('chatLatest').hidden = true; });
    $('chatLogin').addEventListener('click', async () => {
      $('chatLogin').disabled = true;
      try { await root.BHFirebase.signInWithGoogle(); }
      catch (_) { status('تعذّر تسجيل الدخول. حاول تاني واسمح لنافذة Google.'); }
      finally { $('chatLogin').disabled = false; }
    });
    root.BHChat = { setVisible(value) { visible = value; if (!value) stop(); else sync(); } };
    root.BHFirebase.onStatusChange(sync);
  });
})(typeof window === 'undefined' ? globalThis : window);
