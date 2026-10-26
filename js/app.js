/**
 * BH Personal Finance Application - Core Logic
 * Tailored for Delivery Riders with Variable Income
 */

const STORAGE_KEY = 'BH_APP_DATA_V1';
const SNAPSHOT_KEY = 'BH_APP_SNAPSHOTS';
const BACKUP_TIME_KEY = 'BH_LAST_BACKUP_TIME';
const SYNC_TIME_KEY = 'BH_LAST_SYNC_TIME';
const LOCAL_TIME_KEY = 'BH_LOCAL_UPDATED_AT';

// Escape user-entered text before injecting it into innerHTML
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class BHApp {
  constructor() {
    this.data = this.loadData();
    this.currentTab = 'dashboardView';
    this.pendingExpensiveExpense = null;
    this.initDateInputs();
    this.init();
  }

  // Initial State Factory
  getDefaultData() {
    const today = new Date().toISOString().split('T')[0];
    return {
      settings: {
        savingsRatio: 50,
        essentialsRatio: 30,
        outingsRatio: 20,
        weeklyOutingsBudget: 300,
        lastSavingsWithdrawalDate: today,
        savingsStreakDays: 0,
        dailyWorkTarget: 300,
        bigNumbersMode: false,
        challenges: {},
        badges: {},
        welcomeSeen: false
      },
      balances: {
        reservedSavings: 0,
        spendableBalance: 0
      },
      balancesAt: 0,
      workDaysAt: {},
      incomes: [],
      expenses: [],
      goals: [
        {
          id: 'goal_' + Date.now(),
          title: 'سداد ديون / تحويش صيانة سكوتر',
          targetAmount: 5000,
          currentAmount: 0,
          date: today
        }
      ],
      debts: [],
      workSessions: [],
      workDays: {},
      adjustments: [],
      pendingIncomes: [],
      _tombstones: {}
    };
  }

  // Load from LocalStorage with fallback
  loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.getDefaultData();
      const parsed = JSON.parse(raw);
      // Merge with defaults in case of missing keys
      const merged = { ...this.getDefaultData(), ...parsed, pendingIncomes: parsed.pendingIncomes || [] };
      merged.workSessions = parsed.workSessions || [];
      merged.workDays = Object.assign({}, parsed.workDays || {});
      merged.adjustments = parsed.adjustments || [];
      merged.settings = { ...this.getDefaultData().settings, ...(parsed.settings || {}) };
      merged.settings.challenges = merged.settings.challenges || {};
      merged.settings.badges = merged.settings.badges || {};
      return merged;
    } catch (e) {
      console.error('Error loading LocalStorage data', e);
      // 🔄 Auto-recover from the newest valid snapshot
      const recovered = this.recoverFromSnapshot();
      if (recovered) {
        setTimeout(() => this.showToast('🔄 اتعطل تحميل البيانات — استرجعنا آخر نسخة سليمة تلقائياً', 'success'), 1200);
        return recovered;
      }
      return this.getDefaultData();
    }
  }

  // Try to recover data from the rolling snapshots (corrupt / lost main data)
  recoverFromSnapshot() {
    const snaps = this.getSnapshots();
    for (const s of snaps) {
      try {
        const parsed = JSON.parse(s.payload);
        if (parsed && parsed.balances && Array.isArray(parsed.incomes)) {
          console.log('Recovered data from snapshot');
          return parsed;
        }
      } catch (e) { /* try the next one */ }
    }
    return null;
  }

  // Save State to LocalStorage (+ rolling auto-snapshots for safety)
  saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      // Track WHEN the local data actually changed (used for conflict resolution)
      localStorage.setItem(LOCAL_TIME_KEY, String(Date.now()));
      this._saveSnapshot();
      this._scheduleCloudPush();
    } catch (e) {
      console.error('Error saving data to LocalStorage', e);
      this.showToast('⚠️ تعذر حفظ البيانات في الذاكرة المحلية');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CLOUD SYNC  (المزامنة السحابية — Firebase)
  // ═══════════════════════════════════════════════════════════

  // Init Firebase (safe: does nothing when not configured)
  initCloudSync() {
    if (typeof window.BHFirebase === 'undefined') return;
    this.startReconcile();

    // The SDK may still be loading (it's loaded async with a CDN fallback)
    const tryInit = () => {
      try {
        window.BHFirebase.init();
      } catch (e) {
        console.warn('Cloud sync init failed (app keeps working locally):', e);
      }

      try {
        window.BHFirebase.onStatusChange((st) => {
          this._cloudState = st;
          this.updateUserAvatar();
          this.handleCloudSession(st);
        });
      } catch (e) { /* ignore */ }

      try {
        if (window.BHFirebase.getUser()) {
          this.pullFromCloud();
        }
      } catch (e) { /* ignore */ }
    };

    if (window.BHFirebase.isConfigured()) {
      // Wait for the SDK to be fully present (max ~8s), then init.
      // firebase.auth / firebase.database are added by their own scripts —
      // they may not be ready yet when the page scripts first run.
      let waited = 0;
      const sdkReady = () =>
        typeof window.firebase !== 'undefined' &&
        window.firebase &&
        typeof window.firebase.initializeApp === 'function' &&
        typeof window.firebase.database === 'function' &&
        typeof window.firebase.auth === 'function';

      const waitForSdk = () => {
        if (sdkReady()) {
          tryInit();
          // A sign-in redirect may have landed — finish it now that Firebase is ready
          if (this._pendingAuthRedirect) {
            this._pendingAuthRedirect = false;
            this.handleAuthRedirect();
          }
        } else if (waited < 80) {
          waited++;
          setTimeout(waitForSdk, 100);
        } else {
          window.BHFirebase.onStatusChange((st) => {
            this._cloudState = st;
            this.updateUserAvatar();
            this.handleCloudSession(st);
          });
          window.BHFirebase.getState().status = 'sdk-missing';
        }
      };
      waitForSdk();
    } else {
      tryInit();
    }
  }

  // ── session حية ──────────────────────────────────────────
  // لما المستخدم يكون مسجّل (حتى بعد إعادة فتح التطبيق من غير ما يسجل تاني)
  // نفعّل الرفع التلقائي + الاستماع المباشر للسحابة — دي كانت المشكلة:
  // الجلسة المحفوظة ما كانتش بتفعّل _cloudReady فالتعديلات مكانش بيرفعها.
  handleCloudSession(st) {
    if (!st || typeof window.BHFirebase === 'undefined') return;
    try {
      if (st.user && (st.status === 'synced' || st.status === 'offline')) {
        this._cloudReady = true;

        const uid = st.user.uid;
        if (this._cloudSubUid !== uid) {
          this._cloudSubUid = uid;
          this.startCloudListener();
          this.pullFromCloud();   // اسحب مرة واحدة بعد التأكد من الجلسة
        }
      } else if (!st.user && this._cloudSubUid) {
        // خرج من الحساب → افصل الاستماع
        this._cloudSubUid = null;
        try { window.BHFirebase.unsubscribeRealtime(); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  // اشتراك مباشر: أي تعديل من جهاز تاني بييجي هنا فورًا
  startCloudListener() {
    if (typeof window.BHFirebase === 'undefined') return;
    try {
      window.BHFirebase.subscribe((envelope) => {
        this.applyRemoteEnvelope(envelope);
      });
    } catch (e) { /* ignore */ }
  }

  // دمج البيانات الجاية حيًا من السحابة (من غير دونات لا نهائي)
  applyRemoteEnvelope(envelope) {
    if (!envelope || !envelope.data || typeof envelope.data !== 'object') return;

    // تجاهل صدى رفّعنا الايح احنا نفسنا — التوقيض بيبقى مطابقة
    // (أي تحديث من جهاز تاني بيبقى بتوقيض مختلف فبيعدّي عادي)
    if (this._lastPushAt && Math.abs(envelope.updatedAt - this._lastPushAt) <= 100) return;

    const localUpdatedAt = parseInt(localStorage.getItem(LOCAL_TIME_KEY) || '0', 10);
    const merged = this.mergeCloudData(this.data, envelope.data, envelope.updatedAt, localUpdatedAt);
    const changed = merged.__changed;

    this.data = merged;
    delete this.data.__changed;

    if (changed) {
      this._suppressCloudPush = true;
      this.saveData();
      this.renderAll();
      try { this.showToast('☁️ اتحدّثت من جهاز تاني', 'info'); } catch (e) { /* ignore */ }
      // ارفع الدمج نفسه عشان باقي الأجهزة تتقارب على نفس البيانات
      this._lastPushAt = Date.now();
      window.BHFirebase.push(this.data).then((ok) => {
        if (ok) localStorage.setItem(SYNC_TIME_KEY, String(Date.now()));
      });
    }
  }

  // Push local data to the cloud (debounced so typing doesn't spam it)
  _scheduleCloudPush() {
    if (!this._cloudReady) return;
    if (this._suppressCloudPush) { this._suppressCloudPush = false; return; }
    clearTimeout(this._cloudPushTimer);
    this._cloudPushTimer = setTimeout(() => {
      this._lastPushAt = Date.now();
      window.BHFirebase.push(this.data).then((ok) => {
        if (ok) localStorage.setItem(SYNC_TIME_KEY, String(Date.now()));
      });
    }, 2500);
  }

  // ♻️ مزامنة خفية مستمرة: كل دقيقة ونص فحص سريع + أول ما التطبيق يرجع من
  // الخلفية (الموبايل بيقطع سوكيت السحابة وهو ماسك تطبيق تاني — من غير كده
  // يفضل شايل بيانات قديمة لحد ما تقفل التطبيق وتفتحه تاني)
  startReconcile() {
    if (this._reconcileTimer) return;
    const wantSync = () => {
      try {
        if (!window.BHFirebase || !window.BHFirebase.getUser()) return;
        if (document.visibilityState !== 'visible') return;
        this.pullFromCloud();
      } catch (e) { /* ignore */ }
    };
    this._reconcileTimer = setInterval(wantSync, 90000);
    // 🚦 نغمة الذروة بتحدث نفسها كل دقيقة
    this._peakTimer = setInterval(() => { try { this.renderPeakStrip(); } catch (e) { /* ignore */ } }, 60000);
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.visibilityState !== 'visible') return;
        clearTimeout(this._reconcileVisTimer);
        this._reconcileVisTimer = setTimeout(wantSync, 1200);   // مهلة صغيرة بعد الرجوع
      } catch (e) { /* ignore */ }
    });
  }

  // Pull remote data — merge it with ours (never delete anything)
  pullFromCloud() {
    if (typeof window.BHFirebase === 'undefined') return;
    // The REAL age of our local data (not the sign-in time!)
    const localUpdatedAt = parseInt(localStorage.getItem(LOCAL_TIME_KEY) || '0', 10);

    window.BHFirebase.pull().then((envelope) => {
      if (!envelope) {
        // Nothing in the cloud yet → upload ours
        this._lastPushAt = Date.now();   // عشان صدى رفعتنا إحنا مايتبلعش غلط
        window.BHFirebase.push(this.data).then((ok) => {
          if (ok) localStorage.setItem(SYNC_TIME_KEY, String(Date.now()));
        });
        return;
      }

      const remote = envelope.data;
      // سواء الملف السحابي كامل أو ناقص — ندمجه على طول
      // (الدمج بيتعامل مع الملفات الناقصة بأمان ومش هيصفرر حاجة)
      if (!remote || typeof remote !== 'object') return;

      // 🔐 SAFETY: merge instead of replace — no entry is ever lost
      const merged = this.mergeCloudData(this.data, remote, envelope.updatedAt, localUpdatedAt);
      const changed = merged.__changed;

      this.data = merged;
      delete this.data.__changed;
      this.saveData();

      if (changed) {
        this.showToast('☁️ اتحدّثت البيانات من السحابة', 'info');
      } else if (envelope.updatedAt > localUpdatedAt) {
        this.showToast('☁️ اتحدّثت البيانات من جهاز تاني', 'info');
      }

      // Push the merged result back so every device converges
      this._lastPushAt = Date.now();
      window.BHFirebase.push(this.data).then((ok) => {
        if (ok) localStorage.setItem(SYNC_TIME_KEY, String(Date.now()));
      });
      this.renderAll();
    });
  }

  // Merge cloud data with local data — union of all entries,
  // إلا الحاجة اللي اتمسحت (متسجلة في _tombstones) — دي عمرها ما بترجع.
  mergeCloudData(local, remote, remoteUpdatedAt, localUpdatedAt) {
    const out = JSON.parse(JSON.stringify(local || {}));
    let changed = false;

    // 🔐 Tombstones (شنط الجثث): كل آي دي اتمسح من أي جهاز — ما يرجّعوش مرة تانية
    const tom = Object.assign({}, (local && local._tombstones) || {}, (remote && remote._tombstones) || {});
    if (JSON.stringify((local && local._tombstones) || {}) !== JSON.stringify(tom)) changed = true;
    out._tombstones = tom;
    const isDead = (coll, id) => !!(id && tom[coll] && tom[coll][id]);

    // إدخال من غير آي دي — نديله آي دي فوري عشان مايتكررش مع كل عملية دمج
    const fixId = (x) => {
      if (!x.id) x.id = 'x_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    };

    const union = (a, b, collName) => {
      const res = [...(a || [])];
      let pruned = 0;
      for (let i = res.length - 1; i >= 0; i--) {
        fixId(res[i]);
        if (isDead(collName, res[i].id)) { res.splice(i, 1); pruned++; }
      }
      const seen = new Set(res.map(x => x.id));
      let added = 0;
      (b || []).forEach(x => {
        if (!x || typeof x !== 'object') return;
        fixId(x);
        if (seen.has(x.id) || isDead(collName, x.id)) return;
        res.push(x);
        seen.add(x.id);
        added++;
      });
      // Newest entries first
      res.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
      if (added > 0 || pruned > 0) changed = true;
      return res;
    };

    out.incomes = union(local.incomes, remote.incomes, 'incomes');
    out.expenses = union(local.expenses, remote.expenses, 'expenses');
    out.goals = union(local.goals, remote.goals, 'goals');
    out.debts = union(local.debts, remote.debts, 'debts');
    out.pendingIncomes = union(local.pendingIncomes, remote.pendingIncomes, 'pendingIncomes');
    out.workSessions = union(local.workSessions, remote.workSessions, 'workSessions');
    out.adjustments = union(local.adjustments, remote.adjustments, 'adjustments');

    // أيام الشغل: آخر حركة تكسب لكل يوم. التسجيل موثّق بوقته (workDaysAt) —
    // القبر بيتشال لو الجهاز سجّل اليوم تاني بعد الunset (بدل ما يفضّل يمحيه للأبد)
    const localWd = (local && local.workDays) || {}, remoteWd = (remote && remote.workDays) || {};
    const localWdAt = (local && local.workDaysAt) || {}, remoteWdAt = (remote && remote.workDaysAt) || {};
    const wdBefore = JSON.stringify(out.workDays || {});
    out.workDays = Object.assign({}, remoteWd, localWd);
    out.workDaysAt = Object.assign({}, remoteWdAt, localWdAt);
    let tombKilled = false;
    Object.keys(tom.workDays || {}).forEach(k => {
      const tTs = tom.workDays[k] || 0;
      const markTs = Math.max(localWdAt[k] || 0, remoteWdAt[k] || 0);
      const haveLocal = localWd[k] !== undefined;
      // تسجيل أحدث من القبر؟ أو بيانات قديمة مش موثّقة بس اليوم موجود محليًا (المستخدم ضغطه هنا)؟
      if (markTs > tTs || (!markTs && haveLocal)) {
        delete tom.workDays[k];
        tombKilled = true;
        if (!haveLocal && remoteWd[k] !== undefined) out.workDays[k] = remoteWd[k];
        out.workDaysAt[k] = markTs || Date.now();
      } else {
        // القبر أحدث — اليوم محسوب مسح قبل تسجيل جديد
        delete out.workDays[k];
        delete out.workDaysAt[k];
      }
    });
    if (!Object.keys(tom.workDays || {}).length) delete tom.workDays;
    if (tombKilled) changed = true;
    if (JSON.stringify(out.workDays || {}) !== wdBefore) changed = true;

    // Balances: عندهم ساعة خاصة (balancesAt) بتتحرك بس بالتغييرات الحقيقية —
    // ساعة الحفظ العامة كانت تخلّي أي حفظ إعدادات يتغلب على رصيد جديد من جهاز تاني
    const remoteIsNewer = remoteUpdatedAt > (localUpdatedAt || 0);
    const localBalAt = (local && local.balancesAt) || 0, remoteBalAt = (remote && remote.balancesAt) || 0;
    const hasRemoteBal = !!(remote && remote.balances && Object.keys(remote.balances).length);
    let balFromRemote;
    if (!hasRemoteBal) balFromRemote = false;
    else if (remoteBalAt !== localBalAt) balFromRemote = remoteBalAt > localBalAt;
    else balFromRemote = remoteIsNewer;   // بيانات قديمة مالهاش ساعة — ساعة الحفظ تبقى الفيصل
    const balSrc = (balFromRemote && remote.balances) ? remote : local;
    const localBal = (local.balances || {});
    out.balances = {
      reservedSavings: (balSrc.balances && balSrc.balances.reservedSavings) || 0,
      spendableBalance: (balSrc.balances && balSrc.balances.spendableBalance) || 0
    };
    out.balancesAt = Math.max(localBalAt, remoteBalAt);
    if (out.balances.reservedSavings !== localBal.reservedSavings ||
        out.balances.spendableBalance !== localBal.spendableBalance) changed = true;

    // Settings: الجهاز الأحدث يكسب في الإعدادات العامة (زي هدف اليوم) —
    // التحديات والشارات union دايمًا من الاتنين
    out.settings = remoteIsNewer
      ? Object.assign({}, local.settings || {}, remote.settings || {})
      : Object.assign({}, remote.settings || {}, local.settings || {});
    out.settings.challenges = Object.assign({}, (local.settings || {}).challenges, (remote.settings || {}).challenges);
    out.settings.badges = Object.assign({}, (local.settings || {}).badges, (remote.settings || {}).badges);
    if (out.settings.dailyWorkTarget !== (local.settings || {}).dailyWorkTarget) changed = true;

    out.__changed = changed;
    return out;
  }

  // Manual sync button
  manualSync() {
    if (typeof window.BHFirebase === 'undefined') return;
    const user = window.BHFirebase.getUser();
    if (!user) {
      this.showToast('⚠️ سجل دخول الأول', 'error');
      return;
    }
    this.showToast('☁️ جاري المزامنة...', 'info');
    this.pullFromCloud();
  }

  // Sign in (anonymous — fastest, this device only)
  async cloudSignInAnon() {
    try {
      await window.BHFirebase.signInAnonymously();
      this._cloudReady = true;
      this.showToast('☁️ تم تسجيل الدخول — المزامنة شغالة!', 'success');
      this.pullFromCloud();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.showToast(this.cloudErrorText(msg), 'error');
    }
  }

  // Sign in with Google (sync across all your devices)
  async cloudSignInGoogle() {
    try {
      await window.BHFirebase.signInWithGoogle();
      this._cloudReady = true;
      this.showToast('☁️ تم تسجيل الدخول بـ Google — مزامنة كل أجهزتك!', 'success');
      this.pullFromCloud();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg.indexOf('popup') >= 0 || msg.indexOf('Popup') >= 0) {
        this.showToast('⚠️ المتصفح منع النافذة — جرّب من الموبايل', 'error');
      } else {
        this.showToast(this.cloudErrorText(msg), 'error');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CLOUD SETUP MODAL  (إعداد المزامنة السحابية)
  // ═══════════════════════════════════════════════════════════

  // Open the cloud setup / sign-in modal
  openCloudSetup() {
    const existing = document.getElementById('cloudSetupModal');
    if (existing) existing.remove();

    const svc = window.BHFirebase;
    const st = svc ? svc.getState() : { status: 'not-configured' };
    const user = svc ? svc.getUser() : null;
    const configured = svc ? svc.isConfigured() : false;

    const statusLine = configured
      ? (user ? '☁️ متزامن مع السحابة' : '🔓 سجّل دخول عشان تبدأ المزامنة')
      : '⚙️ المزامنة السحابية مش مفعّلة — البيانات محفوظة على الجهاز بس';

    const el = document.createElement('div');
    el.id = 'cloudSetupModal';
    el.className = 'modal-overlay active';
    el.innerHTML = `
      <div class="modal-container">
        <div class="modal-header">
          <span class="modal-title">☁️ المزامنة السحابية</span>
          <button class="close-btn" onclick="app.destroyModal('cloudSetupModal')">✕</button>
        </div>

        <div class="cloud-status ${user ? 'ok' : 'idle'}" style="margin-bottom:12px;">
          <span class="cloud-status-icon">${user ? '☁️' : '⚙️'}</span>
          <div style="min-width:0;">
            <div class="cloud-status-text">${statusLine}</div>
            <div class="cloud-status-sub">${user && user.email ? user.email : 'بياناتك تنحفظ على السحابة وتتظبط من أي جهاز'}</div>
          </div>
        </div>

        ${configured ? `
          <div class="cloud-actions" style="margin-bottom:10px;">
            <button class="btn btn-primary btn-sm" onclick="app.cloudSignInGoogle()">🔵 دخول بـ Google</button>
            <button class="btn btn-secondary btn-sm" onclick="app.cloudSignInAnon()">🔓 دخول سريع</button>
          </div>
          <button class="btn btn-secondary btn-full btn-sm" onclick="app.runCloudDiagnostics()" style="margin-bottom:10px;">
            🔍 شخّص الاتصال
          </button>
          <div id="diagBox" class="diag-box"></div>
        ` : ''}

        ${this.renderConsoleLinks()}

        <div class="cloud-note" style="margin-top:10px;">
          💡 البيانات محفوظة على جهازك دايماً — المزامنة بس اللي إضافية.<br>
          ☁️ للمزامنة بين الأجهزة: لازم <b>نفس حساب Google</b> على كل الأجهزة —
          «الدخول السريع» بيفتح حساب مختلف من غير مزامنة بينه وبين Google.
        </div>
      </div>
    `;
    document.body.appendChild(el);
  }

  // Direct links to the exact Firebase console pages for THIS project
  renderConsoleLinks() {
    const cfg = window.BH_FIREBASE_CONFIG;
    if (!cfg || !cfg.projectId) return '';

    const pid = cfg.projectId;
    const dbId = (cfg.databaseURL || '').split('//')[1] ? cfg.databaseURL.split('//')[1].split('.')[0] : pid + '-default-rtdb';

    return `
      <div class="cloud-links">
        <div class="cloud-links-title">🔧 المشكلة: الـ Rules مقفولة. افتح الرابط ده واضغط Publish:</div>
        <a class="cloud-link cloud-link-primary" href="https://console.firebase.google.com/project/${pid}/database/${dbId}/rules" target="_blank" rel="noopener">
          <span class="cloud-link-num">✎</span>
          <span>
            <strong>افتح صفحة Rules</strong>
            <small>Realtime Database → Rules → Publish</small>
          </span>
        </a>
        <div class="cloud-rules-box">
          <div class="cloud-rules-title">📋 انسخ ده والصقه في صفحة Rules:</div>
          <pre class="cloud-rules-code">{
  "rules": {
    "users": {
      "$uid": {
        ".read":  "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    }
  }
}</pre>
          <button class="btn btn-secondary btn-full btn-sm" onclick="app.copyRules()">📋 انسخ القواعد</button>
        </div>        <a class="cloud-link" href="https://console.firebase.google.com/project/${pid}/auth/providers" target="_blank" rel="noopener">
          <span class="cloud-link-num">1</span>
          <span>
            <strong>فعّل Anonymous</strong>
            <small>Authentication → Sign-in method → Anonymous → Enable</small>
          </span>
        </a>
        <a class="cloud-link" href="https://console.firebase.google.com/project/${pid}/authentication/settings" target="_blank" rel="noopener">
          <span class="cloud-link-num">2</span>
          <span>
            <strong>ضيف الدومين</strong>
            <small>Authorized domains → tdrs10.github.io</small>
          </span>
        </a>
        <div class="cloud-links-foot">بعد Publish → ارجع للتطبيق واضغط "شخّص المشكلة" ثم "دخول سريع".</div>
      </div>
    `;
  }

  // Copy the rules JSON to the clipboard
  copyRules() {
    const rules = `{
  "rules": {
    "users": {
      "$uid": {
        ".read":  "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    }
  }
}`;
    const done = () => this.showToast('📋 تم نسخ القواعد — الصقها في صفحة Rules', 'success');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(rules).then(done).catch(() => this.fallbackCopy(rules, done));
    } else {
      this.fallbackCopy(rules, done);
    }
  }

  fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); }
    catch (e) { this.showToast('⚠️ انسخ القواعد يدوياً', 'error'); }
    ta.remove();
  }

  // ═══ 🧪 فحص شامل — سلامة بيانات + حماية الموقع + تقرير ═══
  async runFullAudit() {
    const btn = document.getElementById('runAuditBtn');
    const box = document.getElementById('fullAuditReport');
    if (!box) return;
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ بيشتغل الفحص...'; }
    box.innerHTML = '<div class="audit-running">⏳ بيجهز الفحص... ثواني</div>';

    const checks = [];
    const add = (cat, name, level, detail) => checks.push({ cat, name, level, detail: detail || '' });
    const t0 = Date.now();

    try {
      // ── 1) الحماية الأساسية ─────────────────────────────
      const isHttps = location.protocol === 'https:';
      const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      add('الحماية', 'الاتصال المشفّر HTTPS', isHttps ? 'ok' : (isLocal ? 'warn' : 'fail'),
        isHttps ? 'مؤمّن ✓' : (isLocal ? 'تشرغولة محلية — مقبولة بس للتجربة' : '⚠️ الموقع شغال بدون تشفير!'));

      const cfg = window.BH_FIREBASE_CONFIG;
      add('الحماية', 'مفتاح Firebase', cfg && cfg.apiKey ? 'info' : 'fail',
        cfg && cfg.apiKey
          ? 'المفتاح ظاهر في المتصفح — ده طبيعي لتطبيقات الويب Twitter؛ الحماية الحقيقية في قواعد القاعدة (شغل تحدى كتابة)'
          : 'الإعدادات مش موجودة — المزامنة مقفولة');

      // حالة تسجيل الدخول
      const fb = (typeof window.BHFirebase !== 'undefined') ? window.BHFirebase : null;
      const user = fb ? fb.getUser() : null;
      add('الحماية', 'حساب المزامنة', user ? 'ok' : 'warn',
        user ? 'داخل (' + (user.isAnonymous ? 'مجهول' : 'جوجل') + ') — ' + user.uid.slice(0, 8)
             : 'مش مسجل — المزامنة والفحص السحابي هيتخطّوا (منقول للفحص: شخّص المشكلة)');

      if (user) {
        try {
          const token = await user.getIdToken();
          const dbUrl = cfg && cfg.databaseURL;
          if (dbUrl) {
            const rnd = 'probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            // ⛊️ اختبار 1: كتابة جوه مسار مستخدم تاني — لازم DENIED
            let crossDenied = false;
            try {
              const r = await fetch(dbUrl + '/users/AUDIT_FAKE_OTHER_UID/app.json?auth=' + token,
                { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"probe":1}' });
              crossDenied = r.status === 401 || r.status === 403;
            } catch (e) { crossDenied = false; }
            add('الحماية', 'عزل بيانات المستخدمين', crossDenied ? 'ok' : 'fail',
              crossDenied ? 'القواعد تمنع أي حد يلمس غير صاحبه ✓'
                : '⚠️ حد تاني ممكن يقرأ أو يعدّل بياناتك! لازم تحدّث Rules من صفحة Rules (زرار نسخ القواعد تحت)');

            // ⛊️ اختبار 2: كتابة في الجذر خارج users/ — برضه لازم DENIED
            let rootDenied = false;
            try {
              const r2 = await fetch(dbUrl + '/_audit_' + rnd + '.json?auth=' + token,
                { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"probe":1}' });
              rootDenied = r2.status === 401 || r2.status === 403;
            } catch (e) { rootDenied = false; }
            add('الحماية', 'قفل باقي الداتابيز', rootDenied ? 'ok' : 'warn',
              rootDenied ? 'مفيش كتابة خارج مسار المستخدمين ✓' : 'مسموح كتابة خارج users/ — يفضّل تقفلها في الـ Rules');

            // ⛊️ اختبار 3: كتابة في مسار المستخدم نفسه (آمن — في مسار مؤقت وبينضف)
            let selfWrite = false;
            try {
              const r3 = await fetch(dbUrl + '/users/' + user.uid + '/_audit_' + rnd + '.json?auth=' + token,
                { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"probe":1}' });
              selfWrite = r3.ok;
              if (selfWrite) fetch(dbUrl + '/users/' + user.uid + '/_audit_' + rnd + '.json?auth=' + token, { method: 'DELETE' }).catch(() => {});
            } catch (e) {}
            add('الحماية', 'مسارك المسموح بيشتغل', selfWrite ? 'ok' : 'warn',
              selfWrite ? 'كتابة/محي تتم بحرية في مسارك ✓' : 'الكتابة في مسارك اترفضت — الـ Rules شايطة أضيق من اللازم');
          } else {
            add('الحماية', 'رابط الداتابيز', 'warn', 'databaseURL مش موجود في الإعدادات');
          }
        } catch (e) {
          add('الحماية', 'اختبارات القاعدة', 'warn', 'تعذرت: ' + (e.message || e));
        }
      }

      // ── 2) سلامة البيانات المحلية ───────────────────────
      try {
        localStorage.setItem('_bh_audit_ping', '1');
        const pingOk = localStorage.getItem('_bh_audit_ping') === '1';
        localStorage.removeItem('_bh_audit_ping');
        add('البيانات', 'ذاكرة الجهاز (localStorage)', pingOk ? 'ok' : 'fail', pingOk ? 'قراءة/كتابة تتم ✓' : 'مرفوضة — الوضع الخاص/Private؟');
      } catch (e) {
        add('البيانات', 'ذاكرة الجهاز (localStorage)', 'fail', 'مقفولة تمامًا — ممكن الوضع الخاص');
      }

      const blob = JSON.stringify(this.data || {});
      const blobKB = Math.round(blob.length / 1024);
      add('البيانات', 'حجم بياناتك', blobKB < 1500 ? 'ok' : 'warn',
        blobKB + ' KB' + (blobKB < 1500 ? ' — خفيفة على الجهاز والحاجة ✓' : ' — كبيرة نسبيًا، بتفضل على السحابة وتدفع أبطأ'));

      // جودة السجلات: آي ديز ممكررة/تايهة
      let noId = 0, dupes = 0;
      ['incomes', 'expenses', 'goals', 'debts', 'pendingIncomes', 'workSessions', 'adjustments'].forEach(c0 => {
        if (!Array.isArray(this.data[c0])) return;
        const seen = new Set();
        this.data[c0].forEach(x => {
          if (!x.id) noId++;
          else if (seen.has(x.id)) dupes++;
          else seen.add(x.id);
        });
      });
      add('البيانات', 'سليمنة السجلات', (noId + dupes) === 0 ? 'ok' : 'warn',
        (noId + dupes) === 0 ? 'كل السجلات معرّفة ومافي تكرار ✓' : (noId + dupes) + ' سجل به مشكلة (بدون معرف أو مكرر) — هتظبت أوتوماتيك عند أول مزامنة');

      const tombs = this.data._tombstones || {};
      const tombCount = Object.keys(tombs).reduce((n, k) => n + Object.keys(tombs[k] || {}).length, 0);
      add('البيانات', 'قبر المسح (tombstones)', 'ok', tombCount + ' مسح محفور — بيمنع رجوع المحذوفات من أي جهاز ✓'); 

      // اختلاف الرصيد مع الحسبة من السجلات (معلومة — مش حكم، فيه تسويات يدوية بتعدل الرصيد)
      const reRes = Math.round((this.data.incomes || []).reduce((n, i) => n + (Number(i.savingsAmt) || 0), 0));
      const reSpend = Math.round((this.data.incomes || []).reduce((n, i) => n + ((Number(i.essentialsAmt) || 0) + (Number(i.outingsAmt) || 0)), 0)
        - (this.data.expenses || []).reduce((n, e) => n + (Number(e.amount) || 0), 0));
      const bal = (this.data.balances || {});
      const diff = Math.abs(((bal.reservedSavings || 0) + (bal.spendableBalance || 0)) - (reRes + reSpend));
      add('البيانات', 'تطابق الرصيد مع السجلات', diff <= 1 ? 'info' : 'warn',
        diff <= 1 ? 'مطابق تمامًا ✓' : 'فرق ' + diff.toLocaleString() + ' ج.م — طبيعي بعد تسويات يدوية، بس لو الرقم كتير شوف سجل التسويات');

      // ── 3) الصحة والميزات ──────────────────────────────
      const reg = await navigator.serviceWorker.getRegistration();
      add('الصحة', 'أوفلاين (Service Worker)', reg ? 'ok' : 'fail', reg ? 'مسجل ويعمل ✓' : 'مش مسجل — التطبيق مش هتشتغل أوفلاين');
      try {
        const swTxt = await (await fetch('./service-worker.js', { cache: 'no-store' })).text();
        const m = swTxt.match(/bh-finance-v(\d+)/);
        add('الصحة', 'نسخة الكاش', m ? 'ok' : 'warn',
          m ? ('v' + m[1] + ' — آخر نسخة مرفوعة ✓') : 'مش لاقي رقم النسخة');
      } catch (e) {
        add('الصحة', 'نسخة الكاش', 'warn', 'تعذر قراءة الـ SW: ' + (e.message || e));
      }

      const manifestEl = document.querySelector('link[rel="manifest"]');
      let manifestOk = false, manifestNote = 'مش موجود في الصفحة';
      if (manifestEl) {
        try {
          const mf = await (await fetch(manifestEl.href, { cache: 'no-store' })).json();
          manifestOk = !!(mf.name && mf.icons && mf.icons.length);
          manifestNote = manifestOk ? ('"' + mf.short_name + '" — ' + mf.icons.length + ' أيقونة ✓') : 'ناقص حقول';
        } catch (e) { manifestNote = 'مش لاقيها: ' + (e.message || e); }
      }
      add('الصحة', 'ملف الـ PWA (manifest)', manifestOk ? 'ok' : 'warn', manifestNote);

      add('الصحة', 'الاتصال بالنت', navigator.onLine ? 'ok' : 'warn',
        navigator.onLine ? 'متصل ✓' : 'أوفلاين — الفحوص السحابية اتخطت');

      // Firebase SDK
      const sdkOk = typeof window.firebase !== 'undefined' && !!window.firebase;
      add('الصحة', 'مكتبة Firebase SDK', sdkOk ? 'ok' : 'warn', sdkOk ? 'محمّلة ✓' : 'مش محمّلة (نت ضعيف؟) — التطبيق شغال أوفلاين عادي');
      add('الصحة', 'مستمع المزامنة الحي', fb && fb.isSubscribed && fb.isSubscribed() ? 'ok' : 'warn',
        fb && fb.isSubscribed && fb.isSubscribed() ? 'شغّال ✓' : 'مش شغّال حاليًا — هيشتغل أول ما تدخل');

      // الإشعارات
      if ('Notification' in window) {
        const perm = Notification.permission;
        add('الصحة', 'إذن الإشعارات', perm === 'granted' ? 'ok' : 'warn',
          perm === 'granted' ? 'مسموح — التنبيهات الذكية هتوصلك ✓'
            : perm === 'denied' ? 'مرفوض — تقدر تفعله من إعدادات المتصفح للموقع'
            : 'مش مطلوب بعد — زرار التفعيل في المزيد');
      }
    } catch (e) {
      add('الفحص', 'وقف الفحص', 'fail', e.message || String(e));
    }

    const sec = checks.filter(c => c.cat === 'الحماية');
    const sFail = checks.filter(c => c.level === 'fail').length;
    const sWarn = checks.filter(c => c.level === 'warn').length;
    const sOk = checks.filter(c => c.level === 'ok').length;
    const secs = ['الحماية', 'البيانات', 'الصحة'];
    const LBL = { fail: '❌', warn: '⚠️', ok: '✅', info: 'ℹ️' };
    const stamp = new Date().toLocaleString('ar-EG');
    let html = `
      <div class="audit-summary ${sFail ? 'has-fail' : (sWarn ? 'has-warn' : 'all-good')}">
        <b>${sFail ? '❌ في حاجة لازم تتصَلح' : (sWarn ? '⚠️ شغال، بس تحسينات' : '✅ كل حاجة تمام')}</b>
        <span>✅ ${sOk} • ⚠️ ${sWarn} • ❌ ${sFail} — خلال ${((Date.now() - t0) / 1000).toFixed(1)} ثانية</span>
      </div>`;
    secs.forEach(c0 => {
      const rows = checks.filter(c => c.cat === c0);
      if (!rows.length) return;
      html += `<div class="audit-cat">${c0}</div>`;
      html += rows.map(c => `
        <div class="audit-item ${c.level}">
          <span class="audit-badge">${LBL[c.level]}</span>
          <div class="audit-txt"><b>${esc(c.name)}</b><small>${esc(c.detail)}</small></div>
        </div>`).join('');
    });
    html += `
      <div class="audit-actions">
        <button class="btn audit-copy-btn" onclick="app.copyAuditReport()">📋 انسخ التقرير</button>
        <small class="audit-stamp">${esc(stamp)}</small>
      </div>`;
    box.innerHTML = html;

    this._lastAudit = { checks, stamp, sFail, sWarn, sOk, secs };
    if (btn) { btn.disabled = false; btn.innerHTML = '🔁 اعمل الفحص تاني'; }
    if (sFail) this.showToast('❌ الفحص لقى مشاكل — شوف التقرير', 'error');
    else if (sWarn) this.showToast('⚠️ في تحسينات — التقرير جاهز', 'info');
    else this.showToast('✅ الموقع سليم — التقرير جاهز', 'success');
  }

  copyAuditReport() {    const a = this._lastAudit;
    if (!a) return;
    const LBL = { fail: '❌', warn: '⚠️', ok: '✅', info: 'ℹ️' };
    let txt = '🧪 تقرير فحص شامل — BH\n' + a.stamp + '\n';
    txt += 'النتيجة: ✅ ' + a.sOk + ' • ⚠️ ' + a.sWarn + ' • ❌ ' + a.sFail + '\n\n';
    a.secs.forEach(cat => {
      const rows = (a.checks || []).filter(c => c.cat === cat);
      if (!rows.length) return;
      txt += '◆ ' + cat + '\n';
      rows.forEach(c => { txt += '  ' + LBL[c.level] + ' ' + c.name + (c.detail ? ' — ' + c.detail : '') + '\n'; });
      txt += '\n';
    });
    const done = () => this.showToast('📋 التقرير اتنسخ — الصقه في أي حتة', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => this.fallbackCopy(txt, done));
    } else {
      this.fallbackCopy(txt, done);
    }
  }

  // ── Diagnostics: find out exactly what's broken ──────────
  async runCloudDiagnostics() {    const results = [];
    const add = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

    const cfg = window.BH_FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey) {
      add('الإعدادات', false, 'ملف js/firebase-config.js فاضي');
      this.renderDiagnostics(results);
      return;
    }
    add('الإعدادات', true, 'apiKey: ' + cfg.apiKey.slice(0, 12) + '… / ' + cfg.projectId);

    // 1. SDK
    if (typeof window.firebase === 'undefined' || !window.firebase) {
      add('مكتبة Firebase', false, 'مش محمّلة — Internet ضعيف؟');
      this.renderDiagnostics(results);
      return;
    }
    const hasAuth = typeof window.firebase.auth === 'function';
    const hasDb = typeof window.firebase.database === 'function';
    add('مكتبة Firebase', hasAuth && hasDb,
      hasAuth && hasDb ? 'محمّلة بالكامل' : 'ناقصة (auth: ' + hasAuth + ', database: ' + hasDb + ')');
    if (!hasAuth || !hasDb) {
      this.renderDiagnostics(results);
      return;
    }

    // 2. Init
    try {
      if (!window.firebase.apps.length) window.firebase.initializeApp(cfg);
      add('تهيئة المشروع', true, 'projectId: ' + cfg.projectId);
    } catch (e) {
      add('تهيئة المشروع', false, e.message);
      this.renderDiagnostics(results);
      return;
    }

    // 3. Sign in
    let token = null;
    let uid = null;
    try {
      const user = window.BHFirebase.getUser();
      if (user) {
        uid = user.uid;
        token = await user.getIdToken();
        add('تسجيل الدخول', true, 'مستخدم مجهول / ' + uid.slice(0, 10));
      } else {
        const cred = await window.firebase.auth().signInAnonymously();
        uid = cred.user.uid;
        token = await cred.user.getIdToken();
        add('تسجيل الدخول', true, 'تم الدخول دلوقتي — ' + uid.slice(0, 10));
      }
    } catch (e) {
      const code = e && e.code ? e.code : '';
      add('تسجيل الدخول', false,
        code === 'auth/configuration-not-found' ? 'Anonymous مفعّلش — Authentication → Sign-in method → Enable'
        : code === 'auth/network-request-failed' ? 'مفيش نت — شوف الاتصال'
        : (e.message || String(e)));
      this.renderDiagnostics(results);
      return;
    }

    // 4. Read / Write test against the real database — ⛑️ في مسار سلامة مؤقت
    // (كان كان بيصفّر نسخة السحابة كلها لما بيتعمل وانت داخل بحسابك الحقيقي!)
    const dbUrl = cfg.databaseURL;
    const diagPath = 'users/' + uid + '/app/_diag_' + Date.now();
    const testUrl = dbUrl + '/' + diagPath + '.json?auth=' + token;
    const cleanupDiag = () => fetch(testUrl, { method: 'DELETE' }).catch(() => {});

    try {
      const res = await fetch(testUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updatedAt: Date.now(), data: { test: true } })
      });
      if (res.ok) {
        add('الكتابة في القاعدة', true, 'نجحت — مسار تجريبي آمن');
        cleanupDiag();
      } else {
        const err = await res.json().catch(() => ({}));
        add('الكتابة في القاعدة', false,
          res.status === 401 ? 'Permission denied — الـ Rules محتاجة تتحدّث (شوف firebase-rules.json)'
          : ('HTTP ' + res.status + ' ' + (err.error || '')));
        this.renderDiagnostics(results);
        return;
      }
    } catch (e) {
      add('الكتابة في القاعدة', false, 'الشبكة: ' + (e.message || e));
      this.renderDiagnostics(results);
      return;
    }

    try {
      const res = await fetch(testUrl);
      const data = await res.json();
      if (res.ok) {
        add('القراءة من القاعدة', true, 'نجحت');
        cleanupDiag();
      } else {
        add('القراءة من القاعدة', false, 'HTTP ' + res.status);
      }
    } catch (e) {
      add('القراءة من القاعدة', false, e.message || String(e));
    }

    this.renderDiagnostics(results);
  }

  renderDiagnostics(results) {
    let box = document.getElementById('diagBox');
    if (!box) {
      // Create the box if the card variant doesn't include one
      const cloudBox = document.getElementById('cloudBox');
      if (!cloudBox) return;
      box = document.createElement('div');
      box.id = 'diagBox';
      box.className = 'diag-box';
      cloudBox.appendChild(box);
    }
    box.innerHTML = results.map(r => `
      <div class="diag-row ${r.ok ? 'ok' : 'fail'}">
        <span class="diag-icon">${r.ok ? '✅' : '❌'}</span>
        <span class="diag-name">${r.name}</span>
        <span class="diag-detail">${r.detail}</span>
      </div>
    `).join('');
    box.style.display = 'block';
  }

  // Friendly Arabic message for common Firebase errors
  cloudErrorText(msg) {
    const m = (msg || '').toLowerCase();
    if (m.indexOf('configuration-not-found') >= 0) {
      return '⚙️ لازم تفعّل "Anonymous" من Firebase → Authentication → Sign-in method → Anonymous → Enable';
    }
    if (m.indexOf('network-request-failed') >= 0 || m.indexOf('network') >= 0) {
      return '📴 مفيش نت — اتأكد إن الإنترنت شغال وجرب تاني';
    }
    if (m.indexOf('operation-not-allowed') >= 0) {
      return '⚙️ لازم تفعّل "Anonymous" في Firebase → Authentication → Sign-in method';
    }
    if (m.indexOf('api-key-not-valid') >= 0 || m.indexOf('api key') >= 0) {
      return '⚙️ الـ API Key غلط — راجع js/firebase-config.js';
    }
    if (m.indexOf('permission-denied') >= 0) {
      return '🔒 권한 مرفوض — راجع الـ Rules في Realtime Database';
    }
    if (m.indexOf('unauthorized-domain') >= 0) {
      return '🌐 ضيف الدومين في Firebase → Authorized domains';
    }
    return '⚠️ ' + msg;
  }

  async cloudSignOut() {
    try {
      await window.BHFirebase.signOut();
      this._cloudReady = false;
      this.showToast('👋 تم تسجيل الخروج — البيانات لسه محفوظة على الجهاز', 'info');
      this.updateUserAvatar();
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════
  //  AUTO BACKUP + SNAPSHOTS  (حماية البيانات — تعمل في الخلفية)
  // ═══════════════════════════════════════════════════════════

  // Read the rolling snapshots
  getSnapshots() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  // Keep the last N snapshots so a corrupt/accidental state can be recovered
  _saveSnapshot() {
    try {
      const snaps = this.getSnapshots();
      const payload = JSON.stringify(this.data);
      if (snaps.length && snaps[0].payload === payload) return;

      snaps.unshift({ ts: Date.now(), payload });
      while (snaps.length > 6) snaps.pop();
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snaps));
    } catch (e) {
      console.warn('Snapshot failed:', e);
    }
  }

  // Download a backup file to the device (Downloads folder)
  downloadBackup(silent) {
    try {
      const jsonStr = JSON.stringify(this.data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `BH_Backup_${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);

      localStorage.setItem(BACKUP_TIME_KEY, String(Date.now()));
      if (!silent) this.showToast('📦 تم تحميل النسخة الاحتياطية — هتلاقيها في فولدر Downloads', 'success');
      return true;
    } catch (e) {
      console.error('Backup download failed:', e);
      if (!silent) this.showToast('⚠️ فشل تحميل النسخة الاحتياطية', 'error');
      return false;
    }
  }

  // Auto-backup: download a copy every 3 days
  autoBackupCheck() {
    const last = parseInt(localStorage.getItem(BACKUP_TIME_KEY) || '0', 10);
    const days = last ? Math.floor((Date.now() - last) / 86400000) : 999;
    if (days >= 3) this.downloadBackup(true);
  }

  installUnloadGuard() {
    window.addEventListener('beforeunload', (e) => {
      // Only warn while a form has unsaved input
      const form = document.querySelector('.modal-overlay.active form');
      if (!form) return;
      let dirty = false;
      form.querySelectorAll('input, textarea, select').forEach((el) => {
        if (el.type === 'checkbox' || el.type === 'radio') return;
        if (el.value && el.value.trim() !== '') dirty = true;
      });
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ═══ 3D Balance Card — it tilts with your finger/mouse ═══
  initCardTilt() {
    const card = document.querySelector('.balance-card');
    if (!card) return;

    const MAX_DEG = 7;
    let raf = null;

    const apply = (rx, ry, scale) => {
      raf = null;
      card.style.transform = `perspective(950px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale})`;
    };
    const reset = () => {
      if (raf) cancelAnimationFrame(raf);
      apply(0, 0, 1);
    };

    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => apply(-py * MAX_DEG * 2, px * MAX_DEG * 2, 1.02));
    });
    ['pointerleave', 'pointerup', 'pointercancel'].forEach(ev => card.addEventListener(ev, reset));
  }

  // App Initialization
  init() {
    this.applyBigNumbersMode();
    this.updateStreakCount();
    this.pruneWorkSessions();
    this.renderAll();
    this.calculateShiftNet();
    this.checkDebtDueNotifications();
    this.initSplash();
    this.handleLaunchIntent();
    this.autoBackupCheck();
    this.installUnloadGuard();
    this.initCloudSync();
    this.updateUserAvatar();
    this.initCardTilt();
    this.initNavMascot();
    this.maybeShowWelcome();
    this.scheduleSmartNotification();

    // Close the user menu when clicking outside
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('userMenu');
      const btn = document.getElementById('userAvatarBtn');
      if (menu && menu.classList.contains('open')) {
        if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
          this.closeUserMenu();
        }
      }
    });
  }

  // Handle ?action=income / ?action=expense shortcuts AND share target params
  handleLaunchIntent() {
    const params = new URLSearchParams(window.location.search);

    // 0. A Google sign-in redirect (native app) — finish it first
    if (this.handleAuthRedirect()) return;

    // 1. Share target (text/title/url from another app)
    const hasShare = params.get('text') || params.get('title');
    if (hasShare) {
      setTimeout(() => this.handleShareTarget(), 400);
      return;
    }

    // 2. App shortcuts
    const action = params.get('action');
    if (action) {
      window.history.replaceState({}, '', './index.html');
      setTimeout(() => {
        if (action === 'income') this.openModal('newIncomeModal');
        else if (action === 'expense') this.openModal('newExpenseModal');
      }, 500);
    }
  }

  // ── PWA Splash Screen ──────────────────────────────────────
  // Shows the animated intro on app start. Works in PWA and in a browser tab.
  initSplash() {
    const overlay = document.getElementById('pwaSplashOverlay');
    if (!overlay) return;

    // Make sure it's visible even if the head script didn't run
    overlay.classList.add('splash-force');
    document.documentElement.classList.add('splash-on');

    // Sync the toggle button state
    const btn = document.getElementById('splashToggleBtn');
    if (btn) btn.textContent = localStorage.getItem('BH_SPLASH_OFF') === '1' ? 'تفعيل' : 'إيقاف';

    this.fadeOutSplash(overlay);
  }

  // Fade out the splash overlay and remove it from the DOM
  fadeOutSplash(overlay) {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const holdTime = reduced ? 400 : 1500;

    // Let the browser paint the first frame before starting the exit animation
    requestAnimationFrame(() => {
      setTimeout(() => {
        overlay.classList.add('splash-hide');
        document.documentElement.classList.remove('splash-on');
        setTimeout(() => overlay.remove(), 520);
      }, holdTime);
    });
  }

  // Enable / disable the splash screen permanently
  toggleSplash() {
    const key = 'BH_SPLASH_OFF';
    const isOff = localStorage.getItem(key) === '1';
    if (isOff) {
      localStorage.removeItem(key);
      this.showToast('✨ تم تفعيل شاشة البداية');
    } else {
      localStorage.setItem(key, '1');
      this.showToast('⏹️ تم إيقاف شاشة البداية');
    }
    const btn = document.getElementById('splashToggleBtn');
    if (btn) btn.textContent = isOff ? 'إيقاف' : 'تفعيل';
  }

  // Replay the splash animation on demand (for preview / testing)
  previewSplash() {
    const existing = document.getElementById('pwaSplashOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pwaSplashOverlay';
    overlay.className = 'splash-force';
    overlay.innerHTML = `
      <div class="splash-ring">
        <div class="splash-logo"><span class="splash-B">B</span>H</div>
      </div>
      <div class="splash-subtitle">إدارة أموالك</div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.classList.add('splash-on');
    this.fadeOutSplash(overlay);
  }

  applyBigNumbersMode() {
    const isBig = !!this.data.settings.bigNumbersMode;
    document.body.classList.toggle('big-numbers-mode', isBig);
    const btn = document.getElementById('bigNumbersToggleBtn');
    if (btn) btn.textContent = isBig ? 'إلغاء التفعيل ✖️' : 'تفعيل 👁️';
  }

  toggleBigNumbers() {
    this.data.settings.bigNumbersMode = !this.data.settings.bigNumbersMode;
    this.applyBigNumbersMode();
    this.saveData();
    const isBig = this.data.settings.bigNumbersMode;
    this.showToast(isBig ? '👁️ تم تفعيل وضع الأرقام المكبرة' : '👁️ تم العودة لوضع الأرقام العادية');
  }

  // Set default dates to today
  initDateInputs() {
    const today = new Date().toISOString().split('T')[0];
    ['incomeDate', 'expenseDate', 'shiftDate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = today;
    });
  }

  // Tab Navigation
  switchTab(viewId, navEl = null) {
    document.querySelectorAll('.view-page').forEach(page => {
      page.classList.remove('active');
    });
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    // Update bottom nav active state
    if (navEl) {
      document.querySelectorAll('.bottom-nav .nav-item').forEach(item => item.classList.remove('active'));
      navEl.classList.add('active');
    } else {
      document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
        const onclickAttr = item.getAttribute('onclick') || '';
        if (onclickAttr.includes(viewId)) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }

    const navActive = navEl || document.querySelector('.bottom-nav .nav-item.active');
    if (navActive) this.moveNavMascot(navActive);
    // 💨 تنة أتربة أول ما يوصل
    clearTimeout(this._dustTimer);
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) { /* ignore */ } }
    this._dustTimer = setTimeout(() => { try { this.dustPuff(); } catch (e) { /* ignore */ } }, 520);

    this.currentTab = viewId;
    if (viewId === 'moreView') {
      this.renderReportChart();
    }
    if (viewId === 'workView') {
      this.renderWorkCalendar();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 🛵 السكوتر بيعدي على البار — بينتقل فوق التب النشط
  moveNavMascot(navEl) {
    const m = document.getElementById('navMascot');
    if (!m || !navEl || !m.parentElement) return;
    try {
      const navRect = m.parentElement.getBoundingClientRect();
      const r = navEl.getBoundingClientRect();
      const x = (r.left + r.width / 2) - navRect.left;
      m.style.transform = 'translateX(' + Math.max(6, x) + 'px)';
    } catch (e) { /* ignore */ }
  }

  initNavMascot() {
    const m = document.getElementById('navMascot');
    if (!m) return;
    try {
      const act = document.querySelector('.bottom-nav .nav-item.active') || document.querySelector('.bottom-nav .nav-item');
      if (act) this.moveNavMascot(act);
      window.addEventListener('resize', () => {
        try {
          this.moveNavMascot(document.querySelector('.bottom-nav .nav-item.active'));
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  // ═══ 🛵 حياة السكوتر على البار — أحداث كريتيف ═══

  // 🪙 عملة بتطير من نصف الشاشة للسكوتر (قبض = 🪙 نطة فرح، مصروف = 💸 نزل يبكت)
  flyToken(emoji, mood) {
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const m = document.getElementById('navMascot');
      if (!m) return;
      const r = m.getBoundingClientRect();
      const el = document.createElement('i');
      el.className = 'fly-token';
      el.textContent = emoji || '🪙';
      el.style.left = (r.left + r.width / 2 + (Math.random() * 140 - 70)) + 'px';
      el.style.top = Math.max(80, window.innerHeight * 0.22) + 'px';
      document.body.appendChild(el);
      // إجبار الريلوت قبل الحركة عشان الترانزيشن يشتغل
      void el.offsetWidth;
      el.style.left = (r.left + r.width / 2) + 'px';
      el.style.top = (r.top - 4) + 'px';
      el.style.transform = 'scale(.35)';
      el.style.opacity = '0.1';
      setTimeout(() => {
        el.remove();
        try { this.mascotMood(mood || 'up'); } catch (e) { /* ignore */ }
      }, 780);
    } catch (e) { /* ignore */ }
  }

  // نطة استجابة السكوتر للعملة
  mascotMood(type) {
    const m = document.getElementById('navMascot');
    if (!m) return;
    const icon = m.querySelector('span#navMascotIcon') || m.querySelector('span');
    if (!icon) return;
    const cls = type === 'down' ? 'mood-down' : 'mood-up';
    icon.classList.remove('mood-up', 'mood-down');
    void icon.offsetWidth;   // إعادة تشغيل الأنيميشن
    icon.classList.add(cls);
    setTimeout(() => icon.classList.remove(cls), 700);
  }

  // 💨 تنة أتربة — بيتعمل لما السكوتر يوصل للتاب الجديد
  dustPuff() {
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const m = document.getElementById('navMascot');
      if (!m) return;
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('i');
        d.className = 'dust';
        d.style.left = (25 + Math.random() * 50) + '%';
        d.style.setProperty('--dx', ((Math.random() * 14 - 7).toFixed(1)) + 'px');
        m.appendChild(d);
        setTimeout(() => d.remove(), 600);
      }
    } catch (e) { /* ignore */ }
  }

  // 🤸 ولفي — السكوتر يرفع الضفر والمود يقول لفل جديد!
  mascotWheelie() {
    try {
      const m = document.getElementById('navMascot');
      if (!m || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      m.classList.remove('wheelie');
      void m.offsetWidth;
      m.classList.add('wheelie');
      try { this.dustPuff(); } catch (e) { /* ignore */ }
      setTimeout(() => m.classList.remove('wheelie'), 1350);
    } catch (e) { /* ignore */ }
  }

  // Modal Controllers
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Close and fully remove a modal from the DOM (used by the balance adjust modal)
  destroyModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
      setTimeout(() => modal.remove(), 220);
    }
  }

  // Toast System
  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Streak Tracker Logic
  updateStreakCount() {
    const lastWithdraw = this.data.settings.lastSavingsWithdrawalDate;
    if (!lastWithdraw) {
      this.data.settings.savingsStreakDays = 0;
      // 🔥 مفيش سلسلة → بوني من غير لهوة
      try {
        const m0 = document.getElementById('navMascot');
        if (m0) m0.classList.remove('ride-fire');
      } catch (e) { /* ignore */ }
      return;
    }

    const start = new Date(lastWithdraw);
    const now = new Date();
    const diffTime = Math.abs(now - start);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    this.data.settings.savingsStreakDays = diffDays;
    
    let text = `🔥 ${diffDays} يوم بدون لمس التحويش!`;
    if (diffDays >= 30) {
      text = `🏆 ${diffDays} يوم (شهر كامل بدون كسر التحويش!)`;
    } else if (diffDays >= 14) {
      text = `🔥🔥 ${diffDays} يوم! (أنت بدأت تمسك فلوسك بجد!)`;
    }

    const badgeHeader = document.getElementById('headerStreakBadge');
    const badgeMotivation = document.getElementById('motivationStreakText');
    if (badgeHeader) badgeHeader.textContent = text;
    if (badgeMotivation) badgeMotivation.textContent = text;
    // 🔥 سلسلة التحويش 3+ أيام → بوني يلبس لهوة على ضهره
    try {
      const m = document.getElementById('navMascot');
      if (m) m.classList.toggle('ride-fire', diffDays >= 3);
    } catch (e) { /* ignore */ }
  }

  // Handle New Income Addition (+ قبض جديد أو قيد الانتظار)
  handleNewIncome(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('incomeAmount').value);
    const date = document.getElementById('incomeDate').value || new Date().toISOString().split('T')[0];
    const source = document.getElementById('incomeSource').value;
    const notes = document.getElementById('incomeNote').value || '';
    const status = (document.getElementById('incomeStatus') && document.getElementById('incomeStatus').value) || 'received';

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ قبض صحيح');
      return;
    }

    // ⏳ Handle Pending Income (لم يُستلم بعد)
    if (status === 'pending') {
      const pendingEntry = {
        id: 'pend_' + Date.now(),
        amount,
        source,
        notes,
        date
      };

      if (!this.data.pendingIncomes) this.data.pendingIncomes = [];
      this.data.pendingIncomes.unshift(pendingEntry);
      this.saveData();
      this.closeModal('newIncomeModal');
      this.renderAll();
      this.showToast('⏳ تم تسجيل القبض كـ "قيد الانتظار" بنجاح', 'info');
      document.getElementById('incomeAmount').value = '';
      document.getElementById('incomeNote').value = '';
      return;
    }

    // ✅ Handle Received Income (استلام فوري وتقسيم)
    const sRatio = this.data.settings.savingsRatio / 100;
    const eRatio = this.data.settings.essentialsRatio / 100;
    const oRatio = this.data.settings.outingsRatio / 100;

    const savingsAmt = Math.round(amount * sRatio);
    const essentialsAmt = Math.round(amount * eRatio);
    const outingsAmt = Math.round(amount * oRatio);

    // Update Balances
    this.data.balances.reservedSavings += savingsAmt;
    this.data.balances.spendableBalance += (essentialsAmt + outingsAmt);
    this.touchBalances();

    const incomeEntry = {
      id: 'inc_' + Date.now(),
      amount,
      savingsAmt,
      essentialsAmt,
      outingsAmt,
      date,
      source,
      notes
    };

    this.data.incomes.unshift(incomeEntry);
    this.saveData();
    this.closeModal('newIncomeModal');

    // Populate Celebration Screen
    document.getElementById('celebSavingsRatio').textContent = this.data.settings.savingsRatio;
    document.getElementById('celebEssentialsRatio').textContent = this.data.settings.essentialsRatio;
    document.getElementById('celebOutingsRatio').textContent = this.data.settings.outingsRatio;

    document.getElementById('celebSavingsAmt').textContent = savingsAmt + ' ج.م';
    document.getElementById('celebEssentialsAmt').textContent = essentialsAmt + ' ج.م';
    document.getElementById('celebOutingsAmt').textContent = outingsAmt + ' ج.م';

    this.openModal('incomeCelebrationModal');
    this.renderAll();
    this.flyToken('🪙', 'up');

    // Reset Form
    document.getElementById('incomeAmount').value = '';
    document.getElementById('incomeNote').value = '';
  }

  // Confirm Receipt of Pending Income (تحويل من "قيد الانتظار" إلى "قبض حقيقي")
  confirmPendingIncome(pendId) {
    const item = (this.data.pendingIncomes || []).find(p => p.id === pendId);
    if (!item) return;

    const amount = item.amount;
    const sRatio = this.data.settings.savingsRatio / 100;
    const eRatio = this.data.settings.essentialsRatio / 100;
    const oRatio = this.data.settings.outingsRatio / 100;

    const savingsAmt = Math.round(amount * sRatio);
    const essentialsAmt = Math.round(amount * eRatio);
    const outingsAmt = Math.round(amount * oRatio);

    this.data.balances.reservedSavings += savingsAmt;
    this.data.balances.spendableBalance += (essentialsAmt + outingsAmt);
    this.touchBalances();

    this.data.incomes.unshift({
      id: 'inc_' + Date.now(),
      amount,
      savingsAmt,
      essentialsAmt,
      outingsAmt,
      date: new Date().toISOString().split('T')[0],
      source: item.source,
      notes: item.notes ? `استلام قبض منتظر: ${item.notes}` : 'استلام قبض كان قيد الانتظار'
    });

    this.data.pendingIncomes = this.data.pendingIncomes.filter(p => p.id !== pendId);
    this.tombstone('pendingIncomes', pendId);   // ما يرجّعهوش كـ"قيد الانتظار" على جهاز تاني
    this.saveData();

    // Populate Celebration Screen
    document.getElementById('celebSavingsRatio').textContent = this.data.settings.savingsRatio;
    document.getElementById('celebEssentialsRatio').textContent = this.data.settings.essentialsRatio;
    document.getElementById('celebOutingsRatio').textContent = this.data.settings.outingsRatio;

    document.getElementById('celebSavingsAmt').textContent = savingsAmt + ' ج.م';
    document.getElementById('celebEssentialsAmt').textContent = essentialsAmt + ' ج.م';
    document.getElementById('celebOutingsAmt').textContent = outingsAmt + ' ج.م';

    this.openModal('incomeCelebrationModal');
    this.renderAll();
    this.flyToken('🪙', 'up');
    this.showToast(`🎉 تم استلام ${amount.toLocaleString()} ج.م وتقسيمها للتحويش والصرف بنجاح!`, 'success');
  }

  // Delete Pending Income
  deletePendingIncome(pendId) {
    if (!confirm('هل أنت متأكد من حذف هذا القبض المنتظر؟')) return;
    this.data.pendingIncomes = (this.data.pendingIncomes || []).filter(p => p.id !== pendId);
    this.tombstone('pendingIncomes', pendId);
    this.saveData();
    this.renderAll();
    this.showToast('🗑️ تم حذف القبض المنتظر بنجاح');
  }

  // Handle New Expense (+ مصروف)
  handleNewExpense(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const category = document.getElementById('expenseCategory').value;
    const note = document.getElementById('expenseNote').value || '';
    const date = document.getElementById('expenseDate').value || new Date().toISOString().split('T')[0];

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ مصروف صحيح');
      return;
    }

    if (amount > this.data.balances.spendableBalance) {
      this.showToast('⚠️ عذراً! المبلغ المطلوب يجاوز المتاح للصرف حالياً');
    }

    // 🚨 Expensive Outing / Sama Check
    if (category === 'خروجة' || category === 'سما') {
      const budget = this.data.settings.weeklyOutingsBudget;
      const spent = this.getWeeklyOutingsSpent();
      const remaining = Math.max(0, budget - spent);

      // Ratio percent relative to remaining budget (or total budget if remaining <= 0)
      const baseForPercent = remaining > 0 ? remaining : Math.max(1, budget);
      const ratioPercent = Math.round((amount / baseForPercent) * 100);

      // Trigger warning modal for ratio >= 50%
      if (ratioPercent >= 50) {
        this.pendingExpensiveExpense = { amount, category, note, date };

        const spendableAfter = Math.max(0, this.data.balances.spendableBalance - amount);
        const budgetAfter = Math.max(0, remaining - amount);

        document.getElementById('expOutingAmt').textContent = `${amount.toLocaleString()} ج.م`;
        document.getElementById('expOutingSpendableAfter').textContent = `${spendableAfter.toLocaleString()} ج.م`;
        document.getElementById('expOutingBudgetAfter').textContent = `${budgetAfter.toLocaleString()} ج.م`;
        document.getElementById('expOutingRatioPercent').textContent = `${ratioPercent}%`;

        const banner = document.getElementById('expensiveOutingBanner');
        const title = document.getElementById('expensiveOutingWarnTitle');
        const desc = document.getElementById('expensiveOutingWarnDesc');

        if (ratioPercent >= 100) {
          if (banner) banner.className = 'decision-card decision-red';
          if (title) title.textContent = '🚨 خروجة غالية جداً!';
          if (desc) desc.textContent = `الخروجة دي هتستهلك ${ratioPercent}% من ميزانية خروجاتك المتبقية.`;
        } else {
          if (banner) banner.className = 'decision-card decision-yellow';
          if (title) title.textContent = '🟡 تنبيه: خروجة مكلفة نسبياً';
          if (desc) desc.textContent = `الخروجة دي هتستهلك ${ratioPercent}% من ميزانية خروجاتك المتبقية.`;
        }

        this.openModal('expensiveOutingModal');
        return; // Pause execution until user confirms or cancels in modal!
      }
    }

    // Standard expense execution
    this.saveExpenseData({ amount, category, note, date });
  }

  confirmExpensiveExpense() {
    if (!this.pendingExpensiveExpense) return;
    const item = this.pendingExpensiveExpense;
    this.pendingExpensiveExpense = null;
    this.closeModal('expensiveOutingModal');
    this.saveExpenseData(item);
  }

  cancelExpensiveExpense() {
    this.pendingExpensiveExpense = null;
    this.closeModal('expensiveOutingModal');
    this.showToast('ℹ️ تم إلغاء تسجيل الخروجة');
  }

  saveExpenseData({ amount, category, note, date }) {
    // Deduct from spendable balance
    this.data.balances.spendableBalance -= amount;
    this.touchBalances();

    const expenseEntry = {
      id: 'exp_' + Date.now(),
      amount,
      category,
      note,
      date
    };

    this.data.expenses.unshift(expenseEntry);
    this.saveData();
    this.closeModal('newExpenseModal');
    this.renderAll();

    this.showToast(`✅ تم خصم ${amount} ج.م بنجاح من المتاح للصرف`);
    this.flyToken('💸', 'down');
    
    const amtEl = document.getElementById('expenseAmount');
    const noteEl = document.getElementById('expenseNote');
    if (amtEl) amtEl.value = '';
    if (noteEl) noteEl.value = '';
  }

  // Handle Withdraw From Savings ("استخدام من التحويش")
  handleWithdrawSavings(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const reason = document.getElementById('withdrawReason').value;

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ صحيح');
      return;
    }

    if (amount > this.data.balances.reservedSavings) {
      this.showToast('⚠️ المبلغ المطلوب أكبر من رصيد التحويش المحجوز!');
      return;
    }

    // Transfer from savings to spendable
    this.data.balances.reservedSavings -= amount;
    this.data.balances.spendableBalance += amount;
    this.touchBalances();

    // Reset Streak!
    this.data.settings.lastSavingsWithdrawalDate = new Date().toISOString().split('T')[0];

    // Log as a special expense note
    this.data.expenses.unshift({
      id: 'exp_' + Date.now(),
      amount: 0,
      category: 'سحب تحويش',
      note: `سحب ${amount} ج.م من التحويش (سبب: ${reason})`,
      date: new Date().toISOString().split('T')[0]
    });

    this.saveData();
    this.closeModal('withdrawSavingsModal');
    this.updateStreakCount();
    this.renderAll();

    this.showToast('⚠️ تم السحب من التحويش وتحويله للمتاح للصرف. تم إعادة ضبط أيام التماسك (Streak).');
    
    document.getElementById('withdrawAmount').value = '';
    document.getElementById('withdrawReason').value = '';
  }

  // Calculate Rider Shift Net Income & Efficiency
  calculateShiftNet() {
    var orders = parseFloat(document.getElementById('shiftOrders').value) || 0;
    var rate = parseFloat(document.getElementById('shiftRate').value) || 0;
    var bonus = parseFloat(document.getElementById('shiftBonus').value) || 0;
    var tips = parseFloat(document.getElementById('shiftTips').value) || 0;
    var expenses = parseFloat(document.getElementById('shiftExpenses').value) || 0;
    var hours = parseFloat(document.getElementById('shiftHours').value) || 0;
    var km = parseFloat(document.getElementById('shiftKm').value) || 0;

    var gross = (orders * rate) + bonus + tips;
    var net = gross - expenses;

    var netEl = document.getElementById('shiftNetCalcVal');
    var hourlyEl = document.getElementById('shiftHourlyRateVal');
    var kmEl = document.getElementById('shiftKmRateVal');
    var ratioEl = document.getElementById('shiftExpenseRatioVal');

    if (netEl) netEl.textContent = net.toLocaleString('ar-EG') + ' ج.م';

    if (hourlyEl) {
      var hourlyRate = hours > 0 ? (net / hours).toFixed(1) : 0;
      hourlyEl.textContent = hourlyRate + ' ج.م/س';
    }

    if (kmEl) {
      var kmRate = km > 0 ? (net / km).toFixed(1) : 0;
      kmEl.textContent = kmRate + ' ج.م/كم';
    }

    if (ratioEl) {
      var ratio = gross > 0 ? Math.round((expenses / gross) * 100) : 0;
      ratioEl.textContent = ratio + '%';
    }

    return net;
  }

  // Handle Rider Shift Form Submit
  handleRiderShiftSubmit(e) {
    e.preventDefault();
    const net = this.calculateShiftNet();

    if (net <= 0) {
      this.showToast('⚠️ صافي الوردية يجب أن يكون أكبر من صفر');
      return;
    }

    // ── Save the shift as a work session (for the heat map) ──
    const orders = parseFloat(document.getElementById('shiftOrders').value) || 0;
    const rate = parseFloat(document.getElementById('shiftRate').value) || 0;
    const bonus = parseFloat(document.getElementById('shiftBonus').value) || 0;
    const tips = parseFloat(document.getElementById('shiftTips').value) || 0;
    const expenses = parseFloat(document.getElementById('shiftExpenses').value) || 0;
    const hours = parseFloat(document.getElementById('shiftHours').value) || 0;
    const km = parseFloat(document.getElementById('shiftKm').value) || 0;
    const hour = parseInt(document.getElementById('shiftStartHour').value, 10);
    const shiftDate = document.getElementById('shiftDate').value || new Date().toISOString().split('T')[0];

    if (!this.data.workSessions) this.data.workSessions = [];
    this.data.workSessions.unshift({
      id: 'ws_' + Date.now(),
      date: shiftDate,
      hour: isNaN(hour) ? 12 : hour,
      orders, rate, bonus, tips, expenses, hours, km,
      net,
      createdAt: Date.now()
    });
    this.saveData();

    // Pre-fill Income Modal with shift net
    document.getElementById('incomeAmount').value = net;
    document.getElementById('incomeSource').value = 'طلبات';
    document.getElementById('incomeNote').value = `صافي وردية دليفري (${orders} أوردر)`;
    document.getElementById('incomeDate').value = shiftDate;

    this.openModal('newIncomeModal');
    this.renderAll();
  }

  // Outings Weekly Spent Calculation
  getWeeklyOutingsSpent() {
    const now = new Date();
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay())); // Sunday as start
    startOfWeek.setHours(0, 0, 0, 0);

    return this.data.expenses
      .filter(exp => exp.category === 'خروجة' && new Date(exp.date) >= startOfWeek)
      .reduce((sum, exp) => sum + exp.amount, 0);
  }

  // Update Outings Budget Config
  updateWeeklyOutingsBudget() {
    const val = parseFloat(document.getElementById('weeklyOutingsInput').value);
    if (!isNaN(val) && val >= 0) {
      this.data.settings.weeklyOutingsBudget = val;
      this.saveData();
      this.renderAll();
      this.showToast('✅ تم تحديث ميزانية الخروجات الأسبوعية بنجاح');
    }
  }

  // Decision Helper ("هل أقدر أصرف؟")
  evaluateCanISpend() {
    const amt = parseFloat(document.getElementById('spendCheckAmount').value);
    const box = document.getElementById('spendDecisionResult');
    const badge = document.getElementById('decisionBadge');
    const text = document.getElementById('decisionText');

    if (isNaN(amt) || amt <= 0) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'flex';
    const spendable = this.data.balances.spendableBalance;
    const outingsRemaining = Math.max(0, this.data.settings.weeklyOutingsBudget - this.getWeeklyOutingsSpent());

    if (amt <= spendable && amt <= outingsRemaining) {
      box.className = 'decision-card decision-green';
      badge.textContent = '🟢 تقدر تصرف وإنت مرتاح';
      text.textContent = `المبلغ (${amt} ج.م) متوفر تماماً في المتاح للصرف وضمن حدود ميزانية خروجاتك الأسبوعية.`;
    } else if (amt <= spendable) {
      box.className = 'decision-card decision-yellow';
      badge.textContent = '🟡 الصرف هيأثر على ميزانية الخروجات';
      text.textContent = `المبلغ متوفر في المتاح للصرف (${spendable} ج.م)، لكنه أكبر من ميزانية الخروجات المتبقية (${outingsRemaining} ج.م). يصرف على مسؤوليتك!`;
    } else {
      box.className = 'decision-card decision-red';
      badge.textContent = '🔴 لا أنصحك بالصرف إطلاقاً!';
      text.textContent = `المبلغ المطلوب (${amt} ج.م) يتجاوز رصيدك المتاح للصرف (${spendable} ج.م). لو صرفت هتحتاج تكسر التحويش 🔒!`;
    }
  }

  // Goal & Debt Handlers
  handleNewGoal(e) {
    e.preventDefault();
    const title = document.getElementById('goalTitle').value;
    const targetAmount = parseFloat(document.getElementById('goalTargetAmount').value);
    const currentAmount = parseFloat(document.getElementById('goalCurrentAmount').value) || 0;

    if (!title || isNaN(targetAmount) || targetAmount <= 0) {
      this.showToast('⚠️ يرجى إدخال اسم المبلغ المطلوب بشكل صحيح');
      return;
    }

    this.data.goals.push({
      id: 'goal_' + Date.now(),
      title,
      targetAmount,
      currentAmount,
      date: new Date().toISOString().split('T')[0]
    });

    this.saveData();
    this.closeModal('newGoalModal');
    this.renderAll();
    this.showToast('✅ تم إضافة الهدف المالي بنجاح');
    document.getElementById('goalTitle').value = '';
    document.getElementById('goalTargetAmount').value = '';
  }

  handleNewDebt(e) {
    e.preventDefault();
    const creditor = document.getElementById('debtTitle').value;
    const totalAmount = parseFloat(document.getElementById('debtTotalAmount').value);
    const paidAmount = parseFloat(document.getElementById('debtPaidAmount').value) || 0;
    const dueDate = document.getElementById('debtDueDate').value || '';
    const interestEl = document.getElementById('debtInterest');
    const interest = interestEl ? (parseFloat(interestEl.value) || 0) : 0;

    if (!creditor || isNaN(totalAmount) || totalAmount <= 0) {
      this.showToast('⚠️ يرجى إدخال اسم صاحب الدين والمبلغ الأصلي');
      return;
    }

    this.data.debts.push({
      id: 'debt_' + Date.now(),
      creditor,
      totalAmount,
      paidAmount,
      dueDate,
      interest
    });

    this.saveData();
    this.closeModal('newDebtModal');
    this.renderAll();
    this.showToast('✅ تم تسجيل الدين بنجاح');
    document.getElementById('debtTitle').value = '';
    document.getElementById('debtTotalAmount').value = '';
    if (interestEl) interestEl.value = '';
  }

  payDebt(debtId) {
    const debt = this.data.debts.find(d => d.id === debtId);
    if (!debt) return;

    const remaining = debt.totalAmount - debt.paidAmount;
    const amtStr = prompt(`أدخل مبلغ السداد للدين (${esc(debt.creditor)}) - المتبقي: ${remaining} ج.م:`, remaining);
    const payAmt = parseFloat(amtStr);

    if (!isNaN(payAmt) && payAmt > 0) {
      if (payAmt > this.data.balances.spendableBalance) {
        this.showToast('⚠️ المبلغ المتاح للصرف غير كافٍ لسداد هذا الدين!');
        return;
      }

      debt.paidAmount += payAmt;
      this.data.balances.spendableBalance -= payAmt;
      this.touchBalances();

      // Log expense
      this.data.expenses.unshift({
        id: 'exp_' + Date.now(),
        amount: payAmt,
        category: 'ديون',
        note: `سداد جزء من دين ${esc(debt.creditor)}`,
        date: new Date().toISOString().split('T')[0]
      });

      this.saveData();
      this.renderAll();
      this.showToast(`✅ تم تسديد ${payAmt} ج.م للدين بنجاح`);
    }
  }

  deleteItem(type, id) {
    if (!confirm('هل أنت متأكد من حذف هذه العملية؟')) return;
    const map = { income: 'incomes', expense: 'expenses', goal: 'goals', debt: 'debts' };
    const coll = map[type];
    if (coll) {
      this.data[coll] = (this.data[coll] || []).filter(x => x.id !== id);
      this.tombstone(coll, id);
    }
    this.saveData();
    this.renderAll();
    this.showToast('🗑️ تم الحذف بنجاح');
  }

  // 🔐 شنطة (Tombstone): سجّل إن الآي دي ده اتمسح نهائيًا — عشان دمج المزامنة
  // (اللي بيجمع كل حاجة من كل الأجهزة) ما يرجّعهوش تاني كأنه لسه موجود
  tombstone(coll, id) {
    if (!id) return;
    if (!this.data._tombstones) this.data._tombstones = {};
    if (!this.data._tombstones[coll]) this.data._tombstones[coll] = {};
    this.data._tombstones[coll][id] = Date.now();
  }

  // تسجيل/تحديث يوم شغل — بيشيل قبر اليوم لو كان اتحفر قبل كده + بيوثّق وقت التسجيل
  markWorkDay(key, status) {
    const map = this.getWorkDaysMap();
    map[key] = status;
    if (!this.data.workDaysAt) this.data.workDaysAt = {};
    this.data.workDaysAt[key] = Date.now();
    if (this.data._tombstones && this.data._tombstones.workDays) {
      delete this.data._tombstones.workDays[key];
      if (!Object.keys(this.data._tombstones.workDays).length) delete this.data._tombstones.workDays;
    }
  }

  // شيل يسجل يوم شغل — قبر + شيل توثيق الوقت
  unmarkWorkDay(key) {
    const map = this.getWorkDaysMap();
    delete map[key];
    if (this.data.workDaysAt) delete this.data.workDaysAt[key];
    this.tombstone('workDays', key);
  }

  // 🕒 ساعة الرصيد — بتتحرك بس بالتغييرات الحقيقية في الرصيد
  // (ساعة الحفظ العامة كانت تخلّي أي حفظ إعدادات يغلب رصيد جديد من جهاز تاني)
  touchBalances() {
    this.data.balancesAt = Date.now();
  }

  // Ratios Configuration
  saveRatios() {
    const s = parseFloat(document.getElementById('ratioSavings').value);
    const e = parseFloat(document.getElementById('ratioEssentials').value);
    const o = parseFloat(document.getElementById('ratioOutings').value);

    if (s + e + o !== 100) {
      this.showToast('⚠️ مجموع النسب يجب أن يساوي 100% بالضبط!');
      return;
    }

    this.data.settings.savingsRatio = s;
    this.data.settings.essentialsRatio = e;
    this.data.settings.outingsRatio = o;
    this.saveData();
    this.showToast('✅ تم حفظ نسب تقسيم القبض بنجاح');
  }

  // Data Import/Reset  (export lives in downloadBackup)
  importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const input = event.target;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!imported.balances || !imported.incomes) {
          this.showToast('⚠️ ملف البيانات غير صالح');
          return;
        }

        // Offer merge vs replace — never silently wipe existing data
        const curIncomes = (this.data.incomes || []).length;
        const newIncomes = (imported.incomes || []).length;

        const choice = confirm(
          `📥 الملف فيه ${newIncomes} عملية قبض.\n\n` +
          `✅ OK = دمج مع بياناتك الحالية (${curIncomes} قبض) — الأنسب\n` +
          `❌ Cancel = استبدال كل البيانات بالملف`
        );

        if (choice) {
          this.mergeImported(imported);
          this.showToast('🎉 تم دمج البيانات بنجاح!', 'success');
        } else {
          this.data = imported;
          this.saveData();
          this.showToast('🎉 تم استعادة البيانات بنجاح!', 'success');
        }

        this.renderAll();
      } catch (err) {
        this.showToast('⚠️ حدث خطأ أثناء قراءة الملف');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  // Merge imported data into the current data (keeps everything, dedupes by id)
  mergeImported(imported) {
    const mergeList = (cur, inc, key) => {
      const seen = new Set((cur || []).map(x => x.id));
      const add = (inc || []).filter(x => !x.id || !seen.has(x.id));
      return [...add, ...(cur || [])];
    };

    this.data.incomes = mergeList(this.data.incomes, imported.incomes);
    this.data.expenses = mergeList(this.data.expenses, imported.expenses);
    this.data.goals = mergeList(this.data.goals, imported.goals);
    this.data.debts = mergeList(this.data.debts, imported.debts);
    this.data.pendingIncomes = mergeList(this.data.pendingIncomes, imported.pendingIncomes);
    this.data.workSessions = mergeList(this.data.workSessions, imported.workSessions);
    this.data.adjustments = mergeList(this.data.adjustments, imported.adjustments);

    // Balances: take the newer/highest sensible values
    this.data.balances = {
      reservedSavings: Math.max(this.data.balances.reservedSavings || 0, imported.balances?.reservedSavings || 0),
      spendableBalance: Math.max(this.data.balances.spendableBalance || 0, imported.balances?.spendableBalance || 0)
    };
    this.touchBalances();

    this.saveData();
  }

  confirmResetData() {
    if (confirm('⚠️ هل أنت متأكد تماماً من تصفير وحذف جميع بيانات التطبيق؟ لا يمكن التراجع عن هذا الإجراء!')) {
      // 🛡️ Keep a snapshot so the user can restore if it was a mistake
      this._saveSnapshot();
      // 🔐 شنطة جماعية: سجّل كل الآي هات القديم — عشان المزامنة ما ترجّعهمش من السحابة
      const old = this.data;
      const tom = { incomes: {}, expenses: {}, goals: {}, debts: {}, pendingIncomes: {}, workSessions: {}, adjustments: {}, workDays: {} };
      ['incomes', 'expenses', 'goals', 'debts', 'pendingIncomes', 'workSessions', 'adjustments'].forEach(c => {
        (old[c] || []).forEach(x => { if (x && x.id) tom[c][x.id] = Date.now(); });
      });
      Object.keys(old.workDays || {}).forEach(k => { tom.workDays[k] = Date.now(); });
      this.data = this.getDefaultData();
      this.data._tombstones = tom;
      localStorage.removeItem(STORAGE_KEY);
      this.saveData();
      this.renderAll();
      this.showToast('🧹 تم تصفير البيانات بنجاح');
    }
  }

  // Keep only the last 90 days of work sessions (keeps the heat map meaningful)
  pruneWorkSessions() {
    if (!this.data.workSessions) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = cutoff.toISOString().split('T')[0];
    const before = this.data.workSessions.length;
    this.data.workSessions = this.data.workSessions.filter(w => w.date >= cutoffKey);
    if (this.data.workSessions.length !== before) this.saveData();
  }

  // ═══════════════════════════════════════════════════════════
  //  WORK TRACKER (جدول الشغل — نزلت ولا لا؟)
  //  workDays = { 'YYYY-MM-DD': true(نزلت) | false(راحة) }
  // ═══════════════════════════════════════════════════════════

  WORK_DAY_NAMES   = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  WORK_MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

  getWorkDaysMap() {
    if (!this.data.workDays) this.data.workDays = {};
    return this.data.workDays;
  }

  workDateKey(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // مفتاح التاريخ بالتوقيت المحلي — مهم! UTC كان مخلي من 12 لـ 3 بالليل
  // بتوقيت مصر التسجيل يقع على تاريخ امبارح فيسقط فوق تسجيلة امبارح
  localKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  todayKey() {
    return this.localKey(new Date());
  }

  // Monthly counters: { worked, off, incomeTotal, incomeDays }
  workMonthStats(y, m) {
    const map = this.getWorkDaysMap();
    const days = new Date(y, m + 1, 0).getDate();
    const prefix = this.workDateKey(y, m, 1).slice(0, 7);
    let worked = 0, off = 0;
    for (let d = 1; d <= days; d++) {
      const st = map[this.workDateKey(y, m, d)];
      if (st === true) worked++;
      else if (st === false) off++;
    }
    // Link work with money: only incomes recorded on days marked as worked
    let incomeTotal = 0;
    const incomeDays = new Set();
    (this.data.incomes || []).forEach(inc => {
      if (!inc.date || !inc.date.startsWith(prefix)) return;
      if (map[inc.date] !== true) return;
      incomeTotal += Number(inc.amount) || 0;
      incomeDays.add(inc.date);
    });
    return { worked, off, incomeTotal, incomeDayCount: incomeDays.size };
  }

  // Dashboard + كبسولة النهارده — today's status, streak, ring, month chips
  renderWorkTracker() {
    document.getElementById('workTodayName').textContent = (() => {
      const n = new Date();
      return `النهارده ${this.WORK_DAY_NAMES[n.getDay()]} ${n.getDate()} ${this.WORK_MONTH_NAMES[n.getMonth()]}`;
    })();

    const status = this.getWorkDaysMap()[this.todayKey()];
    document.getElementById('hubBtnYes').classList.toggle('active', status === true);
    document.getElementById('hubBtnNo').classList.toggle('active', status === false);

    this.renderTodayHub();

    const now = new Date();
    const stats = this.workMonthStats(now.getFullYear(), now.getMonth());
    document.getElementById('workStatWorked').textContent = stats.worked;
    document.getElementById('workStatOff').textContent = stats.off;
    document.getElementById('workStatMoney').textContent = stats.incomeTotal.toLocaleString();
    document.getElementById('workStatAvg').textContent =
      stats.incomeDayCount ? Math.round(stats.incomeTotal / stats.incomeDayCount).toLocaleString() : '—';
  }

  // ═══ كبسولة النهارده — حلقة صافي اليوم + شعلة الأيام المتتالية ═══
  renderTodayHub() {
    const tKey = this.todayKey();
    const map = this.getWorkDaysMap();

    // صافي النهارده = قبض النهارده − مصاريف النهارده
    const inc = (this.data.incomes || []).filter(i => i.date === tKey)
      .reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const exp = (this.data.expenses || []).filter(e => e.date === tKey)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const net = inc - exp;

    const numEl = document.getElementById('todayNetVal');
    if (numEl) {
      numEl.textContent = net.toLocaleString();
      numEl.className = 'ring-num' + (net < 0 ? ' neg' : net > 0 ? ' pos' : '');
    }

    // الحلقة — نسبة الوصول لهدف اليوم
    const target = Number(this.data.settings && this.data.settings.dailyWorkTarget) || 300;
    const pct = Math.max(0, Math.min(100, (net / target) * 100));
    const C = 2 * Math.PI * 42;
    const ring = document.getElementById('dailyRingFill');
    if (ring) {
      ring.style.strokeDasharray = C.toFixed(1);
      ring.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
      ring.classList.toggle('ring-good', pct >= 100);
      ring.classList.toggle('ring-bad', net < 0);
    }

    // حالة النهارده
    const stEl = document.getElementById('todayHubStatus');
    if (stEl) {
      const st = map[tKey];
      stEl.textContent = st === true
        ? (pct >= 100 ? '🎉 كملت هدف النهارده!' : '🔥 شغال — كمل قبض')
        : st === false ? '🌙 راحة النهارده' : '⏳ سجل إنك نزلت';
      stEl.className = 'hub-status ' + (st === true ? 'st-worked' : st === false ? 'st-off' : 'st-none');
    }

    // شعلة الأيام المتتالية
    const streak = this.getWorkStreak();
    const fire = document.getElementById('todayStreak');
    if (fire) {
      fire.textContent = streak >= 3 ? `🔥 ${streak} أيام ورا بعض`
        : streak === 2 ? '🔥 يومين ورا بعض'
        : streak === 1 ? '🔥 بدأتها' : '';
      fire.classList.toggle('blazing', streak >= 2);
    }

    const tEl = document.getElementById('hubTargetText');
    if (tEl) tEl.textContent = `🎯 هدفك: ${Number(target).toLocaleString()} ج.م`;

    // 💸 كملت هدف النهارده؟ مطر فلوس! (مرة واحدة في اليوم — ومن غير احتفال عند فتح الصفحة)
    if (net > 0 && net >= target) {
      if (!this._hubSeen) {
        // أول فتح: الهدف واقف من زمان → من غير احتفال، ونسلم هدفي جديد لو عبرت الحد حيًا
        // (من غير ما نثبّت المفتاح عشان العبور الحي بعدها يشتغل)
      } else if (this._hubHitKey !== tKey) {
        this._hubHitKey = tKey;
        this.moneyRain(26);
      }
    } else if (this._hubHitKey === tKey && net < target) {
      // نزل تحت الهدف تاني — نسمح بالاحتفال يتعيد لو كملت تاني
      delete this._hubHitKey;
    }
    this._hubSeen = true;
  }

  // كم يوم متتالي نزلت شغل (يبدأ من النهارده أو آخر يوم مسجل)
  getWorkStreak() {
    const map = this.getWorkDaysMap();
    const d = new Date();
    if (map[this.todayKey()] === undefined) d.setDate(d.getDate() - 1);
    let streak = 0;
    while (map[this.localKey(d)] === true) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // 🛵 ميني سكوتر — بيكبر كل ما تنزل، وبيتعب من الإرهاق لو راحة كتير — دوس عليه تسمّيه
  renderMascot() {
    const actor = document.getElementById('mascotActor');
    if (!actor) return;
    const emoji = document.getElementById('mascotEmoji');
    const lvlEl = document.getElementById('mascotLvl');
    const nameEl = document.getElementById('mascotName');
    const moodEl = document.getElementById('mascotMoodTxt');
    const xpFill = document.getElementById('mascotXpFill');
    if (!emoji || !lvlEl || !nameEl || !moodEl || !xpFill) return;

    const map = this.data.workDays || {};
    let worked = 0;
    Object.keys(map).forEach(k => { if (map[k] === true) worked++; });

    const level = Math.floor(worked / 5) + 1;
    const tiers = [
      { lvl: 1, emoji: '🛵', name: 'مبتدي الطريق' },
      { lvl: 2, emoji: '🛵', name: 'شاطر' },
      { lvl: 3, emoji: '🏍️', name: 'محترف الشوارع' },
      { lvl: 4, emoji: '🚀', name: 'أسطورة' },
      { lvl: 5, emoji: '👑', name: 'ملك الطريق' }
    ];
    const tier = tiers.slice().reverse().find(t => level >= t.lvl);

    const streak = this.getWorkStreak();
    // عدّاد أيام الراحة المتتالية (من آخر يوم مسجل) — توقيت محلي
    const d = new Date();
    if (map[this.todayKey()] === undefined) d.setDate(d.getDate() - 1);
    let rest = 0;
    while (map[this.localKey(d)] === false) { rest++; d.setDate(d.getDate() - 1); }

    const today = map[this.todayKey()];
    const mood = (today === true || streak >= 1) ? 'happy' : (rest >= 2 ? 'tired' : (rest === 1 ? 'rest' : 'idle'));
    actor.classList.remove('is-happy', 'is-tired', 'is-rest', 'is-idle');
    actor.classList.add('is-' + mood);
    emoji.textContent = mood === 'tired' ? '😪' : tier.emoji;

    const name = (this.data.settings && this.data.settings.mascotName) || 'بوني';
    nameEl.textContent = name;
    lvlEl.textContent = 'Lv ' + level;
    xpFill.style.width = Math.min(100, (worked % 5) / 5 * 100) + '%';

    const moodTxt = mood === 'happy'
      ? (streak > 1 ? `شايل نهارده! ${streak} أيام ورا بعض 🔥` : 'شايل نهارده! عقبال لفل جديد')
      : mood === 'tired' ? `طاح من الإرهاق... ${rest} أيام راحة كتير 😪`
      : mood === 'rest' ? 'راحة النهارده — بكرة ننزل غصب عنكم 😂' : 'جاهز ينزل معاك النهارده';
    moodEl.textContent = moodTxt;

    // تثبيت اللفل في الإعدادات — لو الجهاز قفل قبل ما اتحفظ بيرجع ويلحق نفسه
    const savedLvl = parseInt((this.data.settings || {}).mascotLvl, 10) || 0;
    if (level > savedLvl) {
      if (!this.data.settings) this.data.settings = {};
      this.data.settings.mascotLvl = level;
      try { this.saveData(); } catch (e) { /* ignore */ }
    }

    // لفل جديد؟ احتفال صغير (أول فتح للصفحة من غير احتفال، ولا احتفال مكرر بعد إعادة تحميل)
    if (this._mascotLvlSeen === undefined) {
      this._mascotLvlSeen = Math.max(savedLvl, level);
    } else if (level > this._mascotLvlSeen) {
      this._mascotLvlSeen = level;
      actor.classList.remove('lvl-up');
      void actor.offsetWidth;   // إعادة تشغيل الأنيميشن
      actor.classList.add('lvl-up');
      // 🤸 السكوتر يعمل ولفي على البار!
      try { this.mascotWheelie(); } catch (e) { /* ignore */ }
      const flare = document.getElementById('mascotFlare');
      if (flare) {
        flare.style.display = '';
        try { this.moneyRain(14, true); } catch (e) { /* ignore */ }
        setTimeout(() => { flare.style.display = 'none'; }, 2600);
      }
      try { this.showToast(`🛵 ${name} بقى: ${tier.name} (Lv ${level})!`, 'success'); } catch (e) { /* ignore */ }
    }
  }

  // ═══ 🚦 ساعية الذروة — تشجيع للورديات الصبح والليل ═══

  // إعدادات الذروة (وقت الذروة الصبح + الليل — قابلين للتعديل)
  getPeaksCfg() {
    const p = (this.data.settings || {}).peak || {};
    return {
      enabled: p.enabled !== false,
      morning: p.morning || '07:30',
      night: p.night || '20:00'
    };
  }

  savePeakTime(which) {
    const id = which === 'morning' ? 'saPeakMorning' : 'saPeakNight';
    const el = document.getElementById(id);
    if (!el || !el.value) return;
    if (!this.data.settings) this.data.settings = {};
    this.data.settings.peak = Object.assign({ enabled: true, morning: '07:30', night: '20:00' }, this.data.settings.peak || {});
    this.data.settings.peak[which] = el.value;
    this.saveData();
    this.renderPeakStrip();
    this.showToast('⏰ الذروة بقى ساءتها ' + el.value, 'success');
  }

  togglePeakAlerts() {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings.peak = Object.assign({ enabled: true, morning: '07:30', night: '20:00' }, this.data.settings.peak || {});
    this.data.settings.peak.enabled = !(this.data.settings.peak.enabled !== false);
    this.saveData();
    this.renderPeakStrip();
    this.renderSmartAlertSettings();
    this.showToast(this.data.settings.peak.enabled ? '🚦 نغمة الذروة ON — بوني هيصحّيك' : '↩️ نغمة الذروة مغلقة', 'info');
  }

  // حساب الذروة الحالية: mode = peak / approaching / off + رسالة مخصصة
  peakNow() {
    const cfg = this.getPeaksCfg();
    if (!cfg.enabled) return null;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const parse = (s) => {
      const [h, m] = String(s || '').split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const PEAK_LEN = 180;      // الذروة ساعة ونص شغالة وواحد ونص؟ 3 ساعات = نزول قبل + حدودها
    const PRE = 75;            // قبل الذروة بقوم 75 دقيقة

    const worked = (this.data.workDays || {})[this.todayKey()] === true;
    const name = (this.data.settings && this.data.settings.mascotName) || 'بوني';
    const R = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const make = (shift, peakM) => {
      const isMorning = shift === 'morning';
      if (mins >= peakM && mins < peakM + PEAK_LEN) {
        return {
          mode: 'peak', shift,
          icon: isMorning ? '🔥' : '🌙',
          cls: 'is-peak',
          title: isMorning ? 'ذروة الصبح في الشارع' : 'ذروة الليل في الشارع',
          txt: worked
            ? R(['💪 ' + (isMorning ? 'شارع حاضر في الذروة — كمل نفس النفس بالليل' : 'شارع حاضر بالليل — عقبال الرصيد يزيد')])
            : R(['🚀 ' + name + ' بيصوت: انزل يلا يا وحش!', '⏳ فلوس الذروة مش هترجع — سجّل ' + (isMorning ? 'النهارده' : 'الليله') + ' من كده', '🛵 ' + (isMorning ? 'الصبح عشا سكوتر' : 'الليل عشا سكوتر') + ' يامعلم'])
        };
      }
      if (mins >= peakM - PRE && mins < peakM) {
        const left = peakM - mins;
        return {
          mode: 'approaching', shift,
          icon: '⏰',
          cls: 'is-approaching',
          title: (isMorning ? 'ذروة الصبح' : 'ذروة الليل') + ' بتقرب',
          txt: left <= 15
            ? `⏱️ فاضل بس ${left} دقيقة — ${worked ? 'اخذ ألاعرب قهوه وحلن' : 'جيب حاجتك خليك جاهز'}`
            : `🚦 فاضل ${Math.round(left / 60 * 10) / 10} ساعة تقريبًا — ${worked ? 'أنت مقدّم، من متسخ سطوح' : 'يلا وجّه سكوترك قبلها'}`
        };
      }
      return null;
    };

    const m = make('morning', parse(cfg.morning));
    if (m) return m;
    const n = make('night', parse(cfg.night));
    if (n) return n;

    // بين الذروات — فترة راحة
    return {
      mode: 'off', shift: null,
      icon: '🌤️',
      cls: 'is-off',
      title: 'هدنة الشارع',
      txt: '☕ استريح — بوني ينامها ورده الوديه'
    };
  }

  // الشريط الحي في كابوت النهارده — بيغير النص تلقائيًا كل دقيقة
  renderPeakStrip() {
    const strip = document.getElementById('peakStrip');
    if (!strip) return;
    // 💡 شعاع ضي ليلي على البار — بعد 8 مساءً لحد 5 صبحاً
    try {
      const m0 = document.getElementById('navMascot');
      if (m0) {
        const h = new Date().getHours();
        m0.classList.toggle('ride-night', h >= 20 || h < 5);
      }
    } catch (e) { /* ignore */ }
    const p = this.peakNow();
    if (!p) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.style.display = '';
    strip.className = 'peak-strip ' + p.cls;
    strip.innerHTML = `
      <span class="peak-icon">${p.icon}</span>
      <div class="peak-body">
        <b class="peak-title">${esc(p.title)}</b>
        <small class="peak-txt">${esc(p.txt)}</small>
      </div>`;
    // 🛵 إحساس الذروة على البار — توهج الطريق يج أقوى (ذروة حقيقية بس)
    const m = document.getElementById('navMascot');
    if (m) m.classList.toggle('ride-peak', p.cls === 'is-peak');
  }

  // رسايل إشعار الصبح — كل يوم تشجيع مختلف
  morningPushMsg() {
    const name = (this.data.settings && this.data.settings.mascotName) || 'بوني';
    const worked = (this.data.workDays || {})[this.todayKey()] === true;
    const msgs = worked
      ? [
        { t: '☀️ صباح الفلوس يا وحش', b: `${name} مستنيك — اسحب استكشاف وشوف مكسبك امبارح.` },
        { t: '🔥 شايل نهارده أصلاً', b: 'كمّل سلسلة — ذروة الصبح في الطريق.' }
      ] : [
        { t: '🌅 امسحك نزلت؟', b: `الشارع صاحي و${name} جاهز — ذروة الصبح قربت.` },
        { t: '🚀 يلا يا وحش', b: 'ساعة فلوس مضاعفة صباحًا — سكوتك مستنيك.' },
        { t: '☕ فطار سكوت', b: 'جهّز نفسك — ذروة الصبح هي أكتر فلوس في اليوم.' }
      ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  // تسمية السكوتر — دوسة واحدة على الشريط
  renameMascot() {
    const cur = (this.data.settings && this.data.settings.mascotName) || 'بوني';
    const v = prompt('اسم السكوتر بتاعك؟', cur);
    if (v === null) return;
    const n = (v || '').trim().slice(0, 12);
    this.data.settings.mascotName = n || 'بوني';
    this.saveData();
    this.renderMascot();
    this.showToast('✅ السكوتر اسمه دلوقتي: ' + this.data.settings.mascotName, 'success');
  }

  // تغيير هدف اليوم
  editDailyTarget() {
    const cur = Number(this.data.settings && this.data.settings.dailyWorkTarget) || 300;
    const v = prompt('هدفك اليومي من الشغل كام (ج.م)؟', cur);
    if (v === null) return;
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) { this.showToast('⚠️ اكتب رقم صحيح', 'error'); return; }
    this.data.settings.dailyWorkTarget = Math.round(n);
    this.saveData();
    this.renderTodayHub();
    this.showToast(`🎯 الهدف بقى ${Math.round(n)} ج.م يوميًا — عقبال ما تكمّله!`, 'success');
  }

  // Toggle today's status from the dashboard (tap the same one again = unmark)
  setWorkDay(status) {
    const map = this.getWorkDaysMap();
    const key = this.todayKey();
    const was = map[key];
    if (was === status) this.unmarkWorkDay(key);
    else this.markWorkDay(key, status);

    this.saveData();
    this.renderWorkTracker();
    this.renderWorkCalendar();
    this.renderHeaderWorkChip();
    this.renderMascot();

    if (was === status) this.showToast('↩️ اتشال تسجيل النهارده', 'info');
    else if (status) { this.showToast('✅ سجلت إنك نزلت الشغل النهارده — عقبال كل يوم!', 'success'); this.moneyRain(12, true); }
    else this.showToast('🌙 راحة كده... بكرة نزول ومنه ياجر', 'info');
  }

  // Full monthly calendar — month navigation
  workCalNav(delta) {
    if (!this._workCal) { const n = new Date(); this._workCal = { y: n.getFullYear(), m: n.getMonth() }; }
    let m = this._workCal.m + delta;
    let y = this._workCal.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    this._workCal = { y, m };
    this.renderWorkCalendar();
  }

  renderWorkCalendar() {
    const grid = document.getElementById('workCalGrid');
    if (!grid) return;
    if (!this._workCal) { const n = new Date(); this._workCal = { y: n.getFullYear(), m: n.getMonth() }; }
    const { y, m } = this._workCal;
    const map = this.getWorkDaysMap();
    const tKey = this.todayKey();

    document.getElementById('workCalTitle').textContent = `${this.WORK_MONTH_NAMES[m]} ${y}`;

    const stats = this.workMonthStats(y, m);
    document.getElementById('workCalStats').innerHTML =
      `✅ نزلت <b>${stats.worked}</b> يوم &nbsp;•&nbsp; 🌙 راحة <b>${stats.off}</b> &nbsp;•&nbsp; 💸 قبض أيام الشغل <b>${stats.incomeTotal.toLocaleString()}</b> ج.م`;

    // Week columns start on Saturday (الأسبوع المصري يبدأ السبت)
    const HEAD = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
    let html = HEAD.map(h => `<span class="work-cal-head">${h}</span>`).join('');

    const offset = (new Date(y, m, 1).getDay() + 1) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < offset; i++) html += '<span class="work-cal-cell blank"></span>';

    for (let d = 1; d <= daysInMonth; d++) {
      const key = this.workDateKey(y, m, d);
      const st = map[key];
      const cls = ['work-cal-cell'];
      if (st === true) cls.push('worked');
      else if (st === false) cls.push('off');
      if (key === tKey) cls.push('today');
      html += `<span class="${cls.join(' ')}" onclick="app.cycleWorkDay('${key}')"><b>${d}</b><i>${st === true ? '✓' : st === false ? '—' : ''}</i></span>`;
    }
    grid.innerHTML = html;
  }

  // Tap a day: unset → نزلت → راحة → unset
  cycleWorkDay(key) {
    const map = this.getWorkDaysMap();
    const cur = map[key];
    if (cur === undefined) this.markWorkDay(key, true);        // unset → نزلت
    else if (cur === true) this.markWorkDay(key, false);       // نزلت → راحة
    else this.unmarkWorkDay(key);                              // راحة → unset (ما يرجعش من مزامنة جهاز تاني)

    this.saveData();
    this.renderWorkCalendar();
    this.renderHeaderWorkChip();
    this.renderMascot();
    if (key === this.todayKey()) this.renderWorkTracker();
  }

  // ☁️ مؤشر المزامنة الحي في الهيدر — نقطة ملوّنة على حسب حالة السحابة
  renderHeaderSync() {
    const chip = document.getElementById('headerSyncChip');
    const dot = document.getElementById('headerSyncDot');
    const txt = document.getElementById('headerSyncTxt');
    if (!chip || !dot || !txt) return;

    const fb = (typeof window.BHFirebase !== 'undefined') ? window.BHFirebase : null;
    const user = fb ? fb.getUser() : null;
    const st = this._cloudState || (fb ? fb.getState() : null);
    const status = user ? ((st && st.status) || 'offline') : 'signed-out';

    chip.classList.remove('is-ok', 'is-off', 'is-busy', 'is-err');
    let label = 'مزامنة';
    let title = 'افتح إعدادات المزامنة';

    if (!fb || !user) {
      title = 'سجّل بحساب Google واحد على كل أجهزتك عشان تكمش مزامنة الجهازات';
    } else if (status === 'synced') {
      chip.classList.add('is-ok');
      label = 'متزامن';
      const t = (st && st.lastSync) || parseInt(localStorage.getItem(SYNC_TIME_KEY) || '0', 10);
      if (t) {
        const hhmm = new Date(t).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const mins = Math.round((Date.now() - t) / 60000);
        label = mins >= 5 ? 'متزامن · ' + hhmm : 'متزامن';
        title = 'كل أجهزتك شايفة نفس البيانات. آخر مزامنة: ' + hhmm;
      } else {
        title = 'كل أجهزتك شايفة نفس البيانات.';
      }
    } else if (status === 'syncing') {
      chip.classList.add('is-busy');
      label = 'بينقل';
      title = 'بننقل بياناتك للسحابة...';
    } else if (status === 'offline') {
      chip.classList.add('is-off');
      label = 'بدون نت';
      title = 'مش متصل بالسحابة دلوقتي — هيتزامن أول ما النت يرجع';
    } else if (status === 'error') {
      chip.classList.add('is-err');
      label = 'خطأ';
      title = 'في مشكلة في المزامنة — ' + ((st && st.lastError) || 'دوس للتفاصيل');
    }

    txt.textContent = label;
    chip.title = title;
  }

  // 🛵 شارة حالة شغل النهارده في الهيدر — بتدوّر زي نفس المفاتيح في التقويم
  renderHeaderWorkChip() {
    const chip = document.getElementById('headerWorkChip');
    const icon = document.getElementById('headerWorkIcon');
    const txt = document.getElementById('headerWorkTxt');
    if (!chip || !icon || !txt) return;
    const v = (this.data.workDays || {})[this.todayKey()];
    chip.classList.toggle('is-yes', v === true);
    chip.classList.toggle('is-off', v === false);
    chip.classList.toggle('is-todo', v !== true && v !== false);
    icon.textContent = v === true ? '🛵' : v === false ? '🌙' : '⏳';
    txt.textContent = v === true ? 'نزلت' : v === false ? 'راحة' : 'لسه؟';
    chip.title = v === true ? 'نزلت شغل النهارده — دوس تحوّلها لراحة'
      : v === false ? 'راحة النهارده — دوس ترجّعها لسه؟'
      : 'لسه مسجلتش النهارده — دوس يحددك إنك نزلت';
  }

  // Render Master Logic
  renderAll() {
    this.renderHeaderWorkChip();
    this.renderMascot();
    this.renderPeakStrip();
    this.renderBalances();
    this.renderPendingIncomes();
    this.renderDebtAlerts();
    this.renderOutingsWidget();
    this.renderQuickStats();
    this.renderVariableIncomeStats();
    this.renderRecentTransactions();
    this.renderIncomeHistory();
    this.renderExpenseHistory();
    this.renderGoals();
    this.renderDebts();
    this.calculateFutureSimulation();
    this.renderMonthComparison();
    this.renderHeatmap();
    this.checkBadges();
    this.renderChallenges();
    this.renderDebtPlanner();
    this.renderAdjustHistory();
    this.renderSmartAlerts();
    this.renderSmartAlertSettings();
    this.renderWorkTracker();
  }

  // ── Month-over-Month Comparison ──────────────────────────────
  renderMonthComparison() {
    const card = document.getElementById('monthComparisonCard');
    if (!card) return;

    const now   = new Date();
    const curY  = now.getFullYear();
    const curM  = now.getMonth();        // 0-indexed
    const prevM = curM === 0 ? 11 : curM - 1;
    const prevY = curM === 0 ? curY - 1 : curY;

    const inMonth = (dateStr, y, m) => {
      const d = new Date(dateStr);
      return d.getFullYear() === y && d.getMonth() === m;
    };

    const sum = (arr, y, m) =>
      arr.filter(x => inMonth(x.date, y, m)).reduce((s, x) => s + (x.amount || 0), 0);

    const curInc  = sum(this.data.incomes,  curY,  curM);
    const prevInc = sum(this.data.incomes,  prevY, prevM);
    const curExp  = sum(this.data.expenses, curY,  curM);
    const prevExp = sum(this.data.expenses, prevY, prevM);
    const curSav  = curInc  - curExp;
    const prevSav = prevInc - prevExp;

    const pct = (cur, prev) => {
      if (prev === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    };

    const row = (label, cur, prev, higherIsBetter = true) => {
      const diff = pct(cur, prev);
      const up   = diff >= 0;
      const good = higherIsBetter ? up : !up;
      const arrow = up ? '▲' : '▼';
      const cls   = good ? 'mc-good' : 'mc-bad';
      const sign  = up ? '+' : '';
      return `
        <div class="mc-row">
          <span class="mc-label">${label}</span>
          <span class="mc-prev">${prev.toLocaleString()} <small>ج.م</small></span>
          <span class="mc-arrow ${cls}">${arrow}</span>
          <span class="mc-cur">${cur.toLocaleString()} <small>ج.م</small></span>
          <span class="mc-pct ${cls}">${sign}${diff}%</span>
        </div>`;
    };

    // Overall verdict
    const score = (curInc >= prevInc ? 1 : 0) + (curExp <= prevExp ? 1 : 0) + (curSav >= prevSav ? 1 : 0);
    const verdicts = [
      { s: 0, icon: '📉', text: 'شهر صعب — ركّز في الشهر الجاي!', cls: 'mc-verdict-bad' },
      { s: 1, icon: '😐', text: 'شهر عادي — ممكن تتحسن أكتر', cls: 'mc-verdict-warn' },
      { s: 2, icon: '👍', text: 'شهر كويس — استمر!', cls: 'mc-verdict-ok' },
      { s: 3, icon: '🏆', text: 'شهر ممتاز — أحسن من الشهر اللي فات في كل حاجة!', cls: 'mc-verdict-great' },
    ];
    const v = verdicts.find(x => x.s === score) || verdicts[0];

    const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

    card.innerHTML = `
      <div class="card-header">
        <span class="card-title"><span class="card-icon">📊</span> مقارنة شهر بشهر</span>
        <span class="sub-balance-label">${monthNames[prevM]} ← ${monthNames[curM]}</span>
      </div>
      <div class="mc-header-row">
        <span></span>
        <span class="mc-col-label">الشهر الماضي</span>
        <span></span>
        <span class="mc-col-label">الشهر الحالي</span>
        <span class="mc-col-label">الفرق</span>
      </div>
      ${row('💰 القبض',     curInc, prevInc, true)}
      ${row('💸 المصاريف', curExp, prevExp, false)}
      ${row('🔒 الصافي',   curSav, prevSav, true)}
      <div class="mc-verdict ${v.cls}">${v.icon} ${v.text}</div>
    `;
  }

  // Render Pending Incomes Card & Items
  renderPendingIncomes() {
    const list = this.data.pendingIncomes || [];
    const card = document.getElementById('pendingIncomesCard');
    const container = document.getElementById('dashboardPendingList');
    const badge = document.getElementById('pendingCountBadge');
    const totalValEl = document.getElementById('pendingTotalAmountVal');

    if (!card) return;

    if (list.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';

    const totalAmt = list.reduce((sum, i) => sum + i.amount, 0);
    if (totalValEl) totalValEl.textContent = totalAmt.toLocaleString('ar-EG') + ' ج.م';
    if (badge) badge.textContent = `${list.length} عمليات منتظرة`;

    if (!container) return;

    container.innerHTML = list.map(item => `
      <div class="list-item" style="border-right: 3px solid var(--essentials);">
        <div class="item-main">
          <div class="item-icon outing">⏳</div>
          <div class="item-details">
            <span class="item-title">${esc(item.source)} — ${item.amount.toLocaleString()} ج.م</span>
            <span class="item-sub">${esc(item.notes || 'قبض منتظر')} • ${item.date}</span>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn btn-savings btn-sm" onclick="app.confirmPendingIncome('${item.id}')">✅ تم الاستلام</button>
          <button class="delete-btn" onclick="app.deletePendingIncome('${item.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderBalances() {
    const reserved = this.data.balances.reservedSavings;
    const spendable = this.data.balances.spendableBalance;
    const total = reserved + spendable;

    // Current month + year in the dashboard header
    const dateEl = document.getElementById('dashboardDateText');
    if (dateEl) {
      const now = new Date();
      const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
      dateEl.textContent = monthNames[now.getMonth()] + ' ' + now.getFullYear();
    }

    // عداد الرصيد المتحرك — الأرقام بتنطع من القيمة القديمة للجديدة
    this.animateNumber(document.getElementById('totalBalanceVal'), total);
    this.animateNumber(document.getElementById('reservedSavingsVal'), reserved);
    this.animateNumber(document.getElementById('spendableBalanceVal'), spendable);

    // Header balance chip — always visible on every tab
    this.animateNumber(document.getElementById('headerBalanceVal'), total);

    // الخلفية الحية — لون الإضاءة حسب حالة الفلوس
    const mood = total <= 0 ? 'poor' : (spendable < 100 ? 'tight' : 'rich');
    document.body.classList.toggle('bh-rich', mood === 'rich');
    document.body.classList.toggle('bh-tight', mood === 'tight');
    document.body.classList.toggle('bh-poor', mood === 'poor');
  }

  // رقم بيتحرك من القيمة القديمة للجديدة (زي عداد التاكسي 🚕)
  animateNumber(el, to, dur = 800) {
    if (!el) return;
    const from = Number(el._bhVal != null ? el._bhVal : 0);
    if (from === to) { el.textContent = to.toLocaleString(); return; }
    el._bhVal = to;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || dur === 0) { el.textContent = to.toLocaleString(); return; }
    const t0 = performance.now();
    const easeOut = (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(from + (to - from) * easeOut(p)).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 💸 مطر الفلوس — احتفال لما تكمل هدف اليوم (أو تسجل إنك نزلت)
  moneyRain(count = 24, small = false) {
    try {
      let host = document.getElementById('bhCoinRain');
      if (!host) {
        host = document.createElement('div');
        host.id = 'bhCoinRain';
        document.body.appendChild(host);
      }
      const coins = ['💵', '🪙', '💰', '💎'];
      for (let i = 0; i < count; i++) {
        const c = document.createElement('span');
        c.className = 'bh-coin';
        c.textContent = coins[Math.floor(Math.random() * coins.length)];
        c.style.left = (Math.random() * 96 + 2) + '%';
        c.style.fontSize = ((small ? 13 : 18) + Math.random() * (small ? 6 : 14)) + 'px';
        c.style.animationDuration = (1.7 + Math.random() * 1.5) + 's';
        c.style.animationDelay = (Math.random() * 0.7) + 's';
        c.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
        host.appendChild(c);
        setTimeout(() => c.remove(), 4200);
      }
    } catch (e) { /* ignore */ }
  }

  renderOutingsWidget() {
    const budget = this.data.settings.weeklyOutingsBudget;
    const spent = this.getWeeklyOutingsSpent();
    const remaining = Math.max(0, budget - spent);
    const percent = Math.min(100, Math.round((spent / budget) * 100)) || 0;

    const fill = document.getElementById('outingsProgressFill');
    if (fill) fill.style.width = percent + '%';

    document.getElementById('outingsBudgetStatus').textContent = `${spent} من ${budget} ج.م`;
    document.getElementById('outingsRemainingVal').textContent = `${remaining} ج.م`;
    document.getElementById('outingsUsagePercent').textContent = `${percent}% مستهلك`;

    const detailText = document.getElementById('outingsBudgetDetailText');
    if (detailText) detailText.textContent = `المصروف هذا الأسبوع: ${spent} ج.م من أصل ${budget} ج.م`;
  }

  renderQuickStats() {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Weekly Expenses
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    startOfWeek.setHours(0,0,0,0);

    const weeklyExp = this.data.expenses
      .filter(e => new Date(e.date) >= startOfWeek)
      .reduce((sum, e) => sum + e.amount, 0);

    // Monthly Income & Expenses
    const monthlyInc = this.data.incomes
      .filter(i => {
        const d = new Date(i.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, i) => sum + i.amount, 0);

    const monthlyExp = this.data.expenses
      .filter(e => {
        const d = new Date(e.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, e) => sum + e.amount, 0);

    document.getElementById('weeklyExpensesVal').textContent = weeklyExp.toLocaleString();
    document.getElementById('totalSavedVal').textContent = this.data.balances.reservedSavings.toLocaleString();
    document.getElementById('monthlyIncomeVal').textContent = monthlyInc.toLocaleString();
    document.getElementById('monthlyExpensesVal').textContent = monthlyExp.toLocaleString();
  }

  renderVariableIncomeStats() {
    const incomes = this.data.incomes;
    if (incomes.length === 0) {
      document.getElementById('lastIncomeVal').textContent = '0 ج.م';
      document.getElementById('avgIncomeVal').textContent = '0 ج.م';
      document.getElementById('maxIncomeVal').textContent = '0 ج.م';
      document.getElementById('minIncomeVal').textContent = '0 ج.م';
      return;
    }

    const last = incomes[0].amount;
    const amounts = incomes.map(i => i.amount);
    const sum = amounts.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / amounts.length);
    const max = Math.max(...amounts);
    const min = Math.min(...amounts);

    document.getElementById('lastIncomeVal').textContent = `${last.toLocaleString()} ج.م`;
    document.getElementById('avgIncomeVal').textContent = `${avg.toLocaleString()} ج.م`;
    document.getElementById('maxIncomeVal').textContent = `${max.toLocaleString()} ج.م`;
    document.getElementById('minIncomeVal').textContent = `${min.toLocaleString()} ج.م`;
  }

  renderRecentTransactions() {
    const list = document.getElementById('recentTransactionsList');
    if (!list) return;

    // Combine recent incomes and expenses
    const combined = [
      ...this.data.incomes.map(i => ({ ...i, itemType: 'income' })),
      ...this.data.expenses.map(e => ({ ...e, itemType: 'expense' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    if (combined.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📝</div>لا توجد عمليات مسجلة بعد</div>`;
      return;
    }

    list.innerHTML = combined.map(item => {
      const isInc = item.itemType === 'income';
      const iconClass = isInc ? 'income' : (item.category === 'خروجة' ? 'outing' : 'expense');
      const iconSymbol = isInc ? '💵' : (item.category === 'خروجة' ? '❤️' : '💸');
      const amountSign = isInc ? '+' : '-';
      const colorClass = isInc ? 'positive' : 'negative';

      return `
        <div class="list-item">
          <div class="item-main">
            <div class="item-icon ${iconClass}">${iconSymbol}</div>
            <div class="item-details">
              <span class="item-title">${isInc ? 'قبض: ' + esc(item.source) : esc(item.category)}</span>
              <span class="item-sub">${item.date} ${(item.notes || item.note) ? '• ' + esc(item.notes || item.note) : ''}</span>
            </div>
          </div>
          <div class="item-amount ${colorClass}">${amountSign}${item.amount.toLocaleString()} ج.م</div>
        </div>
      `;
    }).join('');
  }

  renderIncomeHistory() {
    const container = document.getElementById('incomeHistoryList');
    if (!container) return;

    if (this.data.incomes.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💵</div>لا يوجد قبض مسجل بعد</div>`;
      return;
    }

    container.innerHTML = this.data.incomes.map(inc => `
      <div class="list-item">
        <div class="item-main">
          <div class="item-icon income">💵</div>
          <div class="item-details">
            <span class="item-title">قبض (${esc(inc.source)})</span>
            <span class="item-sub">${inc.date} ${inc.notes ? '• ' + inc.notes : ''}</span>
            <small style="color: var(--text-muted); font-size: 0.72rem;">🔒تحويش: ${inc.savingsAmt} | 💳متاح: ${inc.essentialsAmt + inc.outingsAmt}</small>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <span class="item-amount positive">+${inc.amount.toLocaleString()} ج.م</span>
          <button class="delete-btn" onclick="app.deleteItem('income', '${inc.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderExpenseHistory() {
    const container = document.getElementById('expenseHistoryList');
    if (!container) return;

    if (this.data.expenses.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💳</div>لا توجد مصاريف مسجلة بعد</div>`;
      return;
    }

    container.innerHTML = this.data.expenses.map(exp => `
      <div class="list-item">
        <div class="item-main">
          <div class="item-icon ${exp.category === 'خروجة' ? 'outing' : 'expense'}">${exp.category === 'خروجة' ? '❤️' : '💸'}</div>
          <div class="item-details">
            <span class="item-title">${esc(exp.category)}</span>
            <span class="item-sub">${exp.date} ${exp.note ? '• ' + exp.note : ''}</span>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <span class="item-amount negative">-${exp.amount.toLocaleString()} ج.م</span>
          <button class="delete-btn" onclick="app.deleteItem('expense', '${exp.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderGoals() {
    const container = document.getElementById('goalsList');
    if (!container) return;

    if (this.data.goals.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎯</div>لا توجد أهداف أضفتها بعد</div>`;
      return;
    }

    container.innerHTML = this.data.goals.map(goal => {
      const remaining = Math.max(0, goal.targetAmount - goal.currentAmount);
      const percent = Math.min(100, Math.round((goal.currentAmount / goal.targetAmount) * 100)) || 0;

      return `
        <div class="list-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="color: #fff;">🎯 ${esc(goal.title)}</strong>
            <button class="delete-btn" onclick="app.deleteItem('goal', '${goal.id}')">🗑️</button>
          </div>
          <div class="progress-bar-container" style="margin: 2px 0;">
            <div class="progress-fill fill-savings" style="width: ${percent}%;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-muted);">
            <span>المحجوز: <strong class="val-savings">${goal.currentAmount.toLocaleString()} ج.م</strong></span>
            <span>المحتجز المطلوب: ${goal.targetAmount.toLocaleString()} ج.m (${percent}%)</span>
          </div>
        </div>
      `;
    }).join('');
  }

  renderDebts() {
    const container = document.getElementById('debtsList');
    if (!container) return;

    let totalRemaining = 0;

    if (this.data.debts.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📌</div>لا توجد ديون مسجلة. عظيم!</div>`;
      document.getElementById('totalDebtsRemainingVal').textContent = '0 ج.م';
      return;
    }

    // Sort: urgent unpaid first (by due date), then unpaid without dates, paid last
    const sortedDebts = [...this.data.debts].sort((a, b) => {
      const paidA = a.totalAmount - a.paidAmount <= 0;
      const paidB = b.totalAmount - b.paidAmount <= 0;
      if (paidA !== paidB) return paidA ? 1 : -1;
      if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

    container.innerHTML = sortedDebts.map(debt => {
      const remaining = debt.totalAmount - debt.paidAmount;
      totalRemaining += Math.max(0, remaining);

      const urgency = this.getDebtUrgency(debt);
      const urgencyColor = !urgency ? ''
        : (urgency.level === 'overdue' || urgency.level === 'today') ? 'var(--danger)'
        : urgency.level === 'soon' ? 'var(--warning)'
        : 'var(--savings)';
      const urgencyHtml = urgency ? ` • <span style="color: ${urgencyColor}; font-weight: 800;">${urgency.label}</span>` : '';
      const isDanger = urgency && (urgency.level === 'overdue' || urgency.level === 'today');

      return `
        <div class="list-item" style="flex-direction: column; align-items: stretch; gap: 8px; ${isDanger ? 'border-right: 3px solid var(--danger);' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="color: #fff;">📌 ${esc(debt.creditor)}</strong>
              <div style="font-size: 0.75rem; color: var(--text-muted);">استحقاق: ${debt.dueDate || 'غير محدد'}${urgencyHtml}</div>
            </div>
            <div style="display: flex; gap: 6px;">
              ${remaining > 0 ? `<button class="btn btn-primary btn-sm" onclick="app.payDebt('${debt.id}')">سداد جزء</button>` : `<span class="streak-badge">تم السداد بالكامل ✅</span>`}
              <button class="delete-btn" onclick="app.deleteItem('debt', '${debt.id}')">🗑️</button>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-top: 4px;">
            <span>الأصلي: ${debt.totalAmount.toLocaleString()} ج.م</span>
            <span>المسدد: ${debt.paidAmount.toLocaleString()} ج.م</span>
            <span style="color: var(--danger); font-weight: 800;">المتبقي: ${remaining.toLocaleString()} ج.م</span>
          </div>
        </div>
      `;
    }).join('');

    document.getElementById('totalDebtsRemainingVal').textContent = `${totalRemaining.toLocaleString()} ج.م`;
  }

  // ═══════ Debt Due Date Alerts (تنبيه استحقاق الديون) ═══════

  // Calculate urgency level for a single debt
  getDebtUrgency(debt) {
    const remaining = debt.totalAmount - debt.paidAmount;
    if (remaining <= 0 || !debt.dueDate) return null;

    const due = new Date(debt.dueDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

    if (days < 0)  return { level: 'overdue', days, icon: '🔴', label: `متأخر ${this.daysArabic(Math.abs(days))}` };
    if (days === 0) return { level: 'today', days: 0, icon: '🔴', label: 'مستحق النهاردة' };
    if (days === 1) return { level: 'soon', days: 1, icon: '🟠', label: 'مستحق بكرة' };
    if (days <= 3) return { level: 'soon', days, icon: '🟠', label: `مستحق بعد ${this.daysArabic(days)}` };
    if (days <= 7) return { level: 'week', days, icon: '🟢', label: `مستحق بعد ${this.daysArabic(days)}` };
    return null;
  }

  // Arabic plural helper for days
  daysArabic(n) {
    if (n === 1) return 'يوم';
    if (n === 2) return 'يومين';
    if (n <= 10) return `${n} أيام`;
    return `${n} يوم`;
  }

  // All debts that need attention (overdue/today/soon/within a week), sorted by urgency
  getUrgentDebts() {
    return (this.data.debts || [])
      .map(d => ({ debt: d, urgency: this.getDebtUrgency(d) }))
      .filter(x => x.urgency !== null)
      .sort((a, b) => a.urgency.days - b.urgency.days);
  }

  // Dashboard alert card for debts about to be due
  renderDebtAlerts() {
    const card = document.getElementById('debtAlertsCard');
    if (!card) return;

    const urgent = this.getUrgentDebts();
    if (urgent.length === 0) {
      card.style.display = 'none';
      card.innerHTML = '';
      return;
    }

    card.style.display = 'block';

    const items = urgent.map(({ debt, urgency }) => {
      const remaining = Math.max(0, debt.totalAmount - debt.paidAmount);
      const isDanger = urgency.level === 'overdue' || urgency.level === 'today';

      return `
        <div class="list-item" style="border-right: 3px solid ${isDanger ? 'var(--danger)' : 'var(--savings)'};">
          <div class="item-main">
            <div class="item-icon expense">${urgency.icon}</div>
            <div class="item-details">
              <span class="item-title">📌 ${esc(debt.creditor)}</span>
              <span class="item-sub">${urgency.label} • المتبقي: ${remaining.toLocaleString()} ج.م</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn btn-primary btn-sm" onclick="app.payDebt('${debt.id}')">سداد</button>
          </div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="card-header">
        <span class="card-title"><span class="card-icon">⏰</span> ديون قربت تستحق</span>
        <span class="sub-balance-label">${urgent.length} ديون</span>
      </div>
      <div class="history-list">${items}</div>
    `;
  }

  // System notification for critical debts (overdue / today / soon) — once per day
  checkDebtDueNotifications() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const critical = this.getUrgentDebts().filter(x => x.urgency.level !== 'week');
    if (critical.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
    if (this.data.settings.lastDebtNotifyDate === today) return;

    this.data.settings.lastDebtNotifyDate = today;
    this.saveData();

    const lines = critical.map(({ debt, urgency }) => {
      const remaining = Math.max(0, debt.totalAmount - debt.paidAmount);
      return `${urgency.icon} ${esc(debt.creditor)}: ${urgency.label} — المتبقي ${remaining.toLocaleString()} ج.م`;
    });

    try {
      new Notification('⏰ تنبيه ديون مستحقة', {
        body: lines.join('\n'),
        icon: 'assets/icon-192.png'
      });
    } catch (e) {
      console.error('Debt notification error:', e);
    }
  }

  // Financial Future Simulator ("مستقبلي المالي")
  calculateFutureSimulation() {
    const weeklyInput = document.getElementById('simWeeklySavings');
    const currentInput = document.getElementById('simCurrentBalance');

    if (!weeklyInput || !currentInput) return;

    let weekly = parseFloat(weeklyInput.value);
    let current = parseFloat(currentInput.value);

    // Default fallbacks if empty or invalid
    if (isNaN(weekly)) {
      weekly = 1000;
    }

    if (isNaN(current)) {
      current = (this.data.balances.reservedSavings + this.data.balances.spendableBalance) || 3000;
    }

    // Timeline Projections
    const m1 = Math.round(current + (weekly * 4));
    const m3 = Math.round(current + (weekly * 12));
    const m6 = Math.round(current + (weekly * 26));
    const y1 = Math.round(current + (weekly * 52));

    const m1El = document.getElementById('sim1MonthVal');
    const m3El = document.getElementById('sim3MonthsVal');
    const m6El = document.getElementById('sim6MonthsVal');
    const y1El = document.getElementById('sim1YearVal');

    if (m1El) m1El.textContent = `≈ ${m1.toLocaleString()} ج.م`;
    if (m3El) m3El.textContent = `≈ ${m3.toLocaleString()} ج.م`;
    if (m6El) m6El.textContent = `≈ ${m6.toLocaleString()} ج.م`;
    if (y1El) y1El.textContent = `≈ ${y1.toLocaleString()} ج.م`;

    // Scenarios (after 1 year = 52 weeks)
    const strongWeekly = Math.round(weekly * 1.2);
    const strongTotal = Math.round(current + (strongWeekly * 52));

    const mediumWeekly = Math.round(weekly * 1.0);
    const mediumTotal = Math.round(current + (mediumWeekly * 52));

    const weakWeekly = Math.round(weekly * 0.7);
    const weakTotal = Math.round(current + (weakWeekly * 52));

    const sW = document.getElementById('simStrongWeekly');
    const sV = document.getElementById('simStrongVal');

    const mW = document.getElementById('simMediumWeekly');
    const mV = document.getElementById('simMediumVal');

    const wW = document.getElementById('simWeakWeekly');
    const wV = document.getElementById('simWeakVal');

    if (sW) sW.textContent = strongWeekly.toLocaleString();
    if (sV) sV.textContent = `≈ ${strongTotal.toLocaleString()} ج.م`;

    if (mW) mW.textContent = mediumWeekly.toLocaleString();
    if (mV) mV.textContent = `≈ ${mediumTotal.toLocaleString()} ج.م`;

    if (wW) wW.textContent = weakWeekly.toLocaleString();
    if (wV) wV.textContent = `≈ ${weakTotal.toLocaleString()} ج.م`;
  }

  // HTML5 Canvas Chart Rendering
  renderReportChart() {
    const canvas = document.getElementById('financeReportChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.offsetWidth || 340;
    const height = 180;
    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    const monthlyInc = parseFloat(document.getElementById('monthlyIncomeVal').textContent.replace(/,/g, '')) || 0;
    const monthlyExp = parseFloat(document.getElementById('monthlyExpensesVal').textContent.replace(/,/g, '')) || 0;
    const reserved = this.data.balances.reservedSavings;

    const maxVal = Math.max(monthlyInc, monthlyExp, reserved, 1000);

    const barWidth = 45;
    const gap = 40;
    const startX = (width - (3 * barWidth + 2 * gap)) / 2;

    const items = [
      { label: 'الدخل', value: monthlyInc, color: '#06b6d4' },
      { label: 'المصاريف', value: monthlyExp, color: '#ef4444' },
      { label: 'التحويش', value: reserved, color: '#10b981' }
    ];

    items.forEach((item, idx) => {
      const x = startX + idx * (barWidth + gap);
      const barHeight = (item.value / maxVal) * (height - 50);
      const y = height - 30 - barHeight;

      // Draw Bar
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 6);
      ctx.fill();

      // Draw Value
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Cairo';
      ctx.textAlign = 'center';
      ctx.fillText(item.value.toLocaleString(), x + barWidth / 2, y - 6);

      // Draw Label
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Cairo';
      ctx.fillText(item.label, x + barWidth / 2, height - 10);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  CHALLENGES & BADGES  (نظام التحديات والشارات)
  // ═══════════════════════════════════════════════════════════

  getChallenges() {
    const self = this;
    return [
      // ── تحديات الشغل (زي سكوترك) ──
      {
        id: 'ch_wstreak5', icon: '🛵',
        title: '5 أيام نزول ورا بعض',
        desc: 'نزّل 5 أيام متتالية من غير راحة تقطف السلسلة — بوني هيفرح!',
        target: 5, unit: 'يوم',
        progress: () => Math.min(5, self.getWorkStreak() || 0)
      },
      {
        id: 'ch_wmonth20', icon: '📅',
        title: '20 يوم شغل في الشهر',
        desc: 'سجّل نزول 20 يوم خلال الشهر الحالي من تقويم الشغل.',
        target: 20, unit: 'يوم',
        progress: () => {
          const n = new Date();
          try { return Math.min(20, self.workMonthStats(n.getFullYear(), n.getMonth()).worked); }
          catch (e) { return 0; }
        }
      },
      {
        id: 'ch_scooter3', icon: '🏍️',
        title: 'السكوتر Lv 3',
        desc: 'وصّل بوني لمحترف الشوارع — سجّل 10 أيام نزول إجمالي.',
        target: 10, unit: 'يوم',
        progress: () => Math.min(10, Object.keys(self.data.workDays || {}).filter(k => self.data.workDays[k] === true).length)
      },
      {
        id: 'ch_wtotal50', icon: '👑',
        title: '50 يوم نزول إجمالي',
        desc: '50 يوم شغل مسجل في تاريخك مع التطبيق — ملك الطريق فعلاً.',
        target: 50, unit: 'يوم',
        progress: () => Math.min(50, Object.keys(self.data.workDays || {}).filter(k => self.data.workDays[k] === true).length)
      },
      {
        id: 'ch_streak30', icon: '🔥',
        title: '30 يوم بدون لمس التحويش',
        desc: 'متسحبش ولا جنيه من التحويش لمدة 30 يوم ورا بعض.',
        target: 30, unit: 'يوم',
        progress: () => Math.min(30, self.data.settings.savingsStreakDays || 0)
      },
      {
        id: 'ch_save5k', icon: '🏦',
        title: 'اجمع 5,000 تحويش',
        desc: 'خلي رصيد التحويش يوصل 5,000 ج.م.',
        target: 5000, unit: 'ج.م',
        progress: () => Math.min(5000, Math.round(self.data.balances.reservedSavings))
      },
      {
        id: 'ch_10days', icon: '📅',
        title: '10 أيام متتالية فيها قبض',
        desc: 'سجّل قبض كل يوم لمدة 10 أيام ورا بعض.',
        target: 10, unit: 'يوم',
        progress: () => Math.min(10, self.calcIncomeStreak())
      },
      {
        id: 'ch_noouting', icon: '🚫',
        title: 'أسبوع بدون خروجات',
        desc: '7 أيام متتالية من غير أي مصروف خروجات أو سما.',
        target: 7, unit: 'يوم',
        progress: () => Math.min(7, self.calcNoOutingStreak())
      },
      {
        id: 'ch_income10k', icon: '💎',
        title: 'دخل 10,000 في الشهر',
        desc: 'اجمع 10,000 ج.م قبض خلال الشهر الحالي.',
        target: 10000, unit: 'ج.م',
        progress: () => Math.min(10000, self.calcMonthIncome())
      },
      {
        id: 'ch_shift10', icon: '🚴',
        title: '10 ورديات مسجلة',
        desc: 'سجّل ورديات في حاسبة الكفاءة عشان تاخد إحصائياتك.',
        target: 10, unit: 'وردية',
        progress: () => Math.min(10, (self.data.workSessions || []).length)
      },
      {
        id: 'ch_debtfree', icon: '🧾',
        title: 'تخلص من كل الديون',
        desc: 'سدّد كل الديون المسجلة بالكامل.',
        target: 1, unit: 'دين',
        progress: () => {
          const debts = self.data.debts || [];
          if (debts.length === 0) return 0;
          return debts.every(d => d.paidAmount >= d.totalAmount) ? 1 : 0;
        }
      },
      {
        id: 'ch_goal', icon: '🎯',
        title: 'حقق هدف مالي',
        desc: 'وصلت لأحد أهدافك المالية بالكامل.',
        target: 1, unit: 'هدف',
        progress: () => {
          const goals = self.data.goals || [];
          return goals.some(g => g.currentAmount >= g.targetAmount && g.targetAmount > 0) ? 1 : 0;
        }
      }
    ];
  }

  // Consecutive days (ending today) with at least one recorded income
  calcIncomeStreak() {
    const dates = new Set((this.data.incomes || []).map(i => i.date));
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 400; i++) {
      const key = d.toISOString().split('T')[0];
      if (dates.has(key)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else if (i === 0) {
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }

  // Consecutive days (ending today) with no outings / smoking expenses
  calcNoOutingStreak() {
    const dates = new Set(
      (this.data.expenses || [])
        .filter(e => e.category === 'خروجة' || e.category === 'سما')
        .map(e => e.date)
    );
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 400; i++) {
      const key = d.toISOString().split('T')[0];
      if (dates.has(key)) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // Total income in the current month
  calcMonthIncome() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    return Math.round(
      (this.data.incomes || [])
        .filter(i => {
          const d = new Date(i.date);
          return d.getFullYear() === y && d.getMonth() === m;
        })
        .reduce((s, i) => s + (i.amount || 0), 0)
    );
  }

  getBadges() {
    const self = this;
    const earnedMap = this.data.settings.badges || {};

    const defs = [
      { id: 'bd_first_income', icon: '🎉', title: 'أول قبض', desc: 'سجّلت أول دخل ليك', check: () => (self.data.incomes || []).length >= 1 },
      { id: 'bd_10_incomes', icon: '💵', title: '10 قبوض', desc: 'سجّلت 10 عمليات قبض', check: () => (self.data.incomes || []).length >= 10 },
      { id: 'bd_50_incomes', icon: '💎', title: 'محترف', desc: 'سجّلت 50 عملية قبض', check: () => (self.data.incomes || []).length >= 50 },
      { id: 'bd_100_incomes', icon: '👑', title: 'أسطورة', desc: 'سجّلت 100 عملية قبض', check: () => (self.data.incomes || []).length >= 100 },
      { id: 'bd_sav_1k', icon: '🔒', title: 'أول 1000', desc: 'جمّعت 1000 ج.م تحويش', check: () => self.data.balances.reservedSavings >= 1000 },
      { id: 'bd_sav_5k', icon: '🏦', title: '5000 محفوظة', desc: 'جمّعت 5000 ج.م تحويش', check: () => self.data.balances.reservedSavings >= 5000 },
      { id: 'bd_sav_10k', icon: '💰', title: 'عشرة آلاف', desc: 'جمّعت 10,000 ج.م تحويش', check: () => self.data.balances.reservedSavings >= 10000 },
      { id: 'bd_streak_3', icon: '✨', title: '3 أيام تماسك', desc: '3 أيام بدون لمس التحويش', check: () => (self.data.settings.savingsStreakDays || 0) >= 3 },
      { id: 'bd_streak_7', icon: '🔥', title: 'أسبوع كامل', desc: '7 أيام بدون لمس التحويش', check: () => (self.data.settings.savingsStreakDays || 0) >= 7 },
      { id: 'bd_streak_30', icon: '🏆', title: 'شهر كامل', desc: '30 يوم بدون لمس التحويش', check: () => (self.data.settings.savingsStreakDays || 0) >= 30 },
      { id: 'bd_streak_100', icon: '👑', title: '100 يوم', desc: '100 يوم بدون لمس التحويش', check: () => (self.data.settings.savingsStreakDays || 0) >= 100 },
      { id: 'bd_first_expense', icon: '💸', title: 'أول مصروف', desc: 'سجّلت أول مصروف ليك', check: () => (self.data.expenses || []).length >= 1 },
      { id: 'bd_income_streak_7', icon: '📅', title: 'أسبوع نشط', desc: '7 أيام متتالية فيها قبض', check: () => self.calcIncomeStreak() >= 7 },
      { id: 'bd_no_outing_7', icon: '🚫', title: 'صفر خروجات', desc: 'أسبوع كامل بدون خروجات', check: () => self.calcNoOutingStreak() >= 7 },
      { id: 'bd_goal_done', icon: '🎯', title: 'هدف محقق', desc: 'حققّت هدف مالي بالكامل', check: () => (self.data.goals || []).some(g => g.currentAmount >= g.targetAmount && g.targetAmount > 0) },
      { id: 'bd_debt_free', icon: '🧾', title: 'خالص من الديون', desc: 'سدّدت كل الديون', check: () => { const d = self.data.debts || []; return d.length > 0 && d.every(x => x.paidAmount >= x.totalAmount); } },
      { id: 'bd_shift_10', icon: '🚴', title: '10 ورديات', desc: 'سجّلت 10 ورديات', check: () => (self.data.workSessions || []).length >= 10 },
      { id: 'bd_early_bird', icon: '🌅', title: 'الصبحي', desc: 'سجّلت وردية قبل 10 الصبح', check: () => (self.data.workSessions || []).some(w => (w.hour || 12) < 10) },
      { id: 'bd_night_owl', icon: '🌙', title: 'الليلي', desc: 'سجّلت وردية بعد 8 بالليل', check: () => (self.data.workSessions || []).some(w => (w.hour || 12) >= 20) }
    ];

    return defs.map(b => ({ ...b, earned: !!earnedMap[b.id] }));
  }

  checkBadges() {
    if (!this.data.settings.badges) this.data.settings.badges = {};
    const newly = [];
    this.getBadges().forEach(b => {
      if (!b.earned && b.check()) {
        this.data.settings.badges[b.id] = Date.now();
        newly.push(b);
      }
    });
    if (newly.length > 0) {
      this.saveData();
      newly.forEach((b, i) => {
        setTimeout(() => this.celebrateBadge(b), i * 700);
      });
    }
    return newly;
  }

  celebrateBadge(badge) {
    const el = document.createElement('div');
    el.className = 'badge-celebration';
    el.innerHTML = `
      <div class="badge-celeb-inner">
        <div class="badge-celeb-icon">${badge.icon}</div>
        <div class="badge-celeb-title">شارة جديدة!</div>
        <div class="badge-celeb-name">${esc(badge.title)}</div>
        <div class="badge-celeb-desc">${esc(badge.desc)}</div>
      </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 500);
    }, 2400);
  }

  toggleChallenge(chId) {
    if (!this.data.settings.challenges) this.data.settings.challenges = {};
    if (this.data.settings.challenges[chId]) {
      delete this.data.settings.challenges[chId];
      this.showToast('↩️ تم إلغاء تفعيل التحدي');
    } else {
      this.data.settings.challenges[chId] = Date.now();
      this.showToast('🎯 تم تفعيل التحدي — بالتوفيق!');
    }
    this.saveData();
    this.renderAll();
  }

  renderChallenges() {
    const list = document.getElementById('challengesList');
    if (!list) return;

    const active = this.data.settings.challenges || {};
    const challenges = this.getChallenges();

    list.innerHTML = challenges.map(c => {
      const isActive = !!active[c.id];
      let val = 0;
      try { val = Number(c.progress()) || 0; } catch (e) { val = 0; }   // تحدي واحد يقع؟ الباقي يفضل شغال
      const pct = Math.min(100, Math.round((val / c.target) * 100));
      const done = val >= c.target;
      const isMoney = c.unit === 'ج.م';

      return `
        <div class="challenge-item ${done ? 'done' : ''} ${isActive ? 'active' : ''}">
          <div class="challenge-head">
            <div class="challenge-icon">${c.icon}</div>
            <div class="challenge-info">
              <div class="challenge-title">${esc(c.title)}</div>
              <div class="challenge-desc">${esc(c.desc)}</div>
            </div>
            <button class="challenge-toggle ${isActive ? 'on' : ''}" onclick="app.toggleChallenge('${c.id}')" title="${isActive ? 'إلغاء' : 'تفعيل'}">
              ${isActive ? '✓' : '○'}
            </button>
          </div>
          <div class="challenge-progress-row">
            <div class="challenge-progress">
              <div class="challenge-fill ${done ? 'complete' : ''}" style="width: ${pct}%"></div>
            </div>
            <span class="challenge-val">${isMoney ? val.toLocaleString() : val} / ${isMoney ? c.target.toLocaleString() : c.target} ${c.unit}</span>
          </div>
          ${done ? '<div class="challenge-done-badge">🎉 تم الإنجاز</div>' : ''}
        </div>
      `;
    }).join('');

    const grid = document.getElementById('badgesGrid');
    if (!grid) return;
    const badges = this.getBadges();
    const earnedCount = badges.filter(b => b.earned).length;

    grid.innerHTML = badges.map(b => `
      <div class="badge-item ${b.earned ? 'earned' : 'locked'}" title="${b.desc}">
        <div class="badge-icon">${b.earned ? b.icon : '🔒'}</div>
        <div class="badge-name">${b.title}</div>
        ${b.earned ? '<div class="badge-check">✓</div>' : ''}
      </div>
    `).join('');

    const counter = document.getElementById('badgeCounter');
    if (counter) counter.textContent = `${earnedCount} / ${badges.length}`;
  }

  // ═══════════════════════════════════════════════════════════
  //  WORK HEATMAP  (خريطة أيام وساعات الشغل)
  // ═══════════════════════════════════════════════════════════

  getHeatmapData() {
    const DAY_KEYS = ['ي', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج']; // Sun..Sat
    const DAY_FULL = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const BUCKETS = 6;

    const grid = DAY_KEYS.map(() => new Array(BUCKETS).fill(0));
    let total = 0;
    let maxCell = 0;
    let bestDay = { idx: -1, val: 0 };
    let bestBucket = { idx: -1, val: 0 };

    (this.data.workSessions || []).forEach(w => {
      const d = new Date(w.date);
      if (isNaN(d)) return;
      const dayIdx = d.getDay();
      const hour = Number(w.hour) || 0;
      const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor(hour / 4)));
      const val = Number(w.net) || 0;

      grid[dayIdx][bucket] += val;
      total += val;
      if (val > maxCell) maxCell = val;

      const daySum = grid[dayIdx].reduce((s, v) => s + v, 0);
      if (daySum > bestDay.val) bestDay = { idx: dayIdx, val: daySum };
      if (val > bestBucket.val) bestBucket = { idx: bucket, val };
    });

    return { grid, DAY_KEYS, DAY_FULL, BUCKETS, total, maxCell, bestDay, bestBucket };
  }

  renderHeatmap() {
    const wrap = document.getElementById('heatmapWrap');
    if (!wrap) return;

    const h = this.getHeatmapData();

    if ((this.data.workSessions || []).length === 0) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺️</div>
          سجّل وردياتك في حاسبة الكفاءة (صفحة القبض) عشان تشوف خريطة شغلك
        </div>
      `;
      const stats = document.getElementById('heatmapStats');
      if (stats) stats.innerHTML = '';
      return;
    }

    const BUCKET_LABELS = ['12-4 فجر', '4-8 ص', '8-12 ظ', '12-4 م', '4-8 م', '8-12 ل'];

    const header = `<div class="heat-cell heat-head heat-corner"></div>` +
      BUCKET_LABELS.map(b => `<div class="heat-cell heat-head">${b}</div>`).join('');

    const rows = h.DAY_KEYS.map((dayLetter, dayIdx) => {
      const cells = h.grid[dayIdx].map((val, bIdx) => {
        const ratio = h.maxCell > 0 ? val / h.maxCell : 0;
        const level = val === 0 ? 0 : ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
        const isBest = h.bestDay.idx === dayIdx && h.bestBucket.idx === bIdx && val > 0;
        const title = `${h.DAY_FULL[dayIdx]} — ${BUCKET_LABELS[bIdx]}: ${val.toLocaleString()} ج.م`;
        return `<div class="heat-cell lvl-${level} ${isBest ? 'best' : ''}" title="${title}">${val > 0 ? val.toLocaleString() : ''}</div>`;
      }).join('');
      const dayTotal = h.grid[dayIdx].reduce((s, v) => s + v, 0);
      return `<div class="heat-cell heat-day ${h.bestDay.idx === dayIdx ? 'best' : ''}">${dayLetter}</div>${cells}<div class="heat-cell heat-total">${dayTotal > 0 ? dayTotal.toLocaleString() : ''}</div>`;
    }).join('');

    const legend = `
      <div class="heat-legend">
        <span class="heat-legend-title">الأقل</span>
        <span class="heat-cell lvl-0"></span>
        <span class="heat-cell lvl-1"></span>
        <span class="heat-cell lvl-2"></span>
        <span class="heat-cell lvl-3"></span>
        <span class="heat-cell lvl-4"></span>
        <span class="heat-legend-title">الأكثر</span>
      </div>
    `;

    wrap.innerHTML = `<div class="heat-grid">${header}${rows}</div>${legend}`;

    const stats = document.getElementById('heatmapStats');
    if (stats) {
      const BUCKET_FULL = ['من 12 لـ 4 الفجر', 'من 4 لـ 8 الصبح', 'من 8 لـ 12 الضهر', 'من 12 لـ 4 العصر', 'من 4 لـ 8 المغرب', 'من 8 لـ 12 بالليل'];
      const totalShifts = (this.data.workSessions || []).length;
      const avgShift = totalShifts > 0 ? Math.round(h.total / totalShifts) : 0;

      stats.innerHTML = `
        <div class="heat-stat">
          <span class="heat-stat-label">💰 إجمالي الأرباح المسجلة</span>
          <span class="heat-stat-val val-savings">${h.total.toLocaleString()} ج.م</span>
        </div>
        <div class="heat-stat">
          <span class="heat-stat-label">🚴 عدد الورديات</span>
          <span class="heat-stat-val val-spendable">${totalShifts}</span>
        </div>
        <div class="heat-stat">
          <span class="heat-stat-label">📈 متوسط الوردية</span>
          <span class="heat-stat-val">${avgShift.toLocaleString()} ج.م</span>
        </div>
        <div class="heat-stat">
          <span class="heat-stat-label">🏆 أحسن يوم</span>
          <span class="heat-stat-val val-outings">${h.bestDay.idx >= 0 ? h.DAY_FULL[h.bestDay.idx] : '—'}</span>
        </div>
        <div class="heat-stat">
          <span class="heat-stat-label">⏰ أحسن وقت</span>
          <span class="heat-stat-val val-outings">${h.bestBucket.idx >= 0 ? BUCKET_FULL[h.bestBucket.idx] : '—'}</span>
        </div>
        <div class="heat-tip">
          💡 ${h.bestDay.idx >= 0
            ? `أعلى دخل ليك بيكون ${h.DAY_FULL[h.bestDay.idx]} — ركّز شغلك عليه وطمّع أيامك كمان.`
            : 'سجّل وردياتك عشان نعرف أحسن يوم وأحسن وقت عندك.'}
        </div>
      `;
    }
  }


  // ═══════════════════════════════════════════════════════════
  //  DEBT PAYOFF PLANNER  (مخطط سداد الديون)
  // ═══════════════════════════════════════════════════════════

  // Build an optimized payoff plan for unpaid debts
  // Strategy: "avalanche" (highest remaining first) or "snowball" (smallest first)
  getDebtPlan(strategy = 'avalanche', monthlyBudget = 0) {
    const debts = (this.data.debts || [])
      .filter(d => d.totalAmount - d.paidAmount > 0.001)
      .map(d => ({
        id: d.id,
        creditor: d.creditor,
        remaining: Math.round((d.totalAmount - d.paidAmount) * 100) / 100,
        dueDate: d.dueDate || '',
        interest: Number(d.interest) || 0
      }));

    if (debts.length === 0) return { debts: [], order: [], months: 0, totalInterest: 0, monthlyNeeded: 0, totalDebt: 0 };

    // Sort by strategy
    const sorted = [...debts].sort((a, b) => {
      if (strategy === 'snowball') {
        if (a.remaining !== b.remaining) return a.remaining - b.remaining;
      } else {
        if (a.interest !== b.interest) return b.interest - a.interest;
        if (a.remaining !== b.remaining) return b.remaining - a.remaining;
      }
      return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
    });

    const totalDebt = sorted.reduce((s, d) => s + d.remaining, 0);
    const budget = monthlyBudget > 0 ? monthlyBudget : totalDebt / 6;
    const monthlyNeeded = Math.ceil(budget);

    let monthIndex = 0;
    let totalInterest = 0;
    const order = [];
    const work = sorted.map(d => ({ ...d }));

    const MAX_MONTHS = 600;
    while (work.length > 0 && monthIndex < MAX_MONTHS) {
      let monthSpend = 0;
      let paidSomething = false;

      for (const debt of work) {
        if (monthSpend >= budget) break;
        const available = budget - monthSpend;
        const pay = Math.min(debt.remaining, available);
        if (pay <= 0) continue;

        debt.remaining = Math.round((debt.remaining - pay) * 100) / 100;
        monthSpend += pay;
        paidSomething = true;

        if (debt.remaining <= 0.001 && !debt.paidOffMonth) {
          debt.paidOffMonth = monthIndex + 1;
          order.push({ creditor: debt.creditor, month: monthIndex + 1, dueDate: debt.dueDate });
        }
      }

      // Simple monthly interest accrual on remaining balances
      if (monthIndex > 0) {
        work.forEach(d => {
          if (d.remaining > 0 && d.interest > 0) {
            totalInterest += d.remaining * (d.interest / 100 / 12);
          }
        });
      }

      monthIndex++;
      if (!paidSomething) break;
    }

    work.filter(d => d.remaining > 0.001).forEach(d => {
      order.push({ creditor: d.creditor, month: null, remaining: d.remaining, dueDate: d.dueDate });
    });

    return {
      debts: sorted,
      order,
      months: monthIndex,
      totalInterest: Math.round(totalInterest),
      monthlyNeeded,
      totalDebt: Math.round(totalDebt),
      strategy
    };
  }

  // Estimate the date when a debt will be cleared
  getPayoffDateLabel(months) {
    if (!months) return '—';
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + months, 1);
    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
  }

  renderDebtPlanner() {
    const wrap = document.getElementById('debtPlannerWrap');
    if (!wrap) return;

    const unpaid = (this.data.debts || []).filter(d => d.totalAmount - d.paidAmount > 0.001);

    if (unpaid.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎉</div>
          مفيش ديون مسجلة — أنت حر! 💪
        </div>
      `;
      return;
    }

    const strategy = this.data.settings.debtStrategy || 'avalanche';
    const budget = this.data.settings.debtMonthlyBudget || 0;
    const plan = this.getDebtPlan(strategy, budget);

    const orderMap = {};
    plan.order.forEach(o => { orderMap[o.creditor] = o; });

    const rows = plan.debts.map((d, i) => {
      const o = orderMap[d.creditor];
      const isTarget = i === 0;
      const badge = o && o.month
        ? `<span class="dp-badge paid">✅ ينتهي ${this.getPayoffDateLabel(o.month)}</span>`
        : `<span class="dp-badge late">⏳ محتاج وقت أكتر</span>`;

      return `
        <div class="dp-row ${isTarget ? 'target' : ''}">
          <div class="dp-order">${i + 1}</div>
          <div class="dp-info">
            <div class="dp-name">${esc(d.creditor)} ${isTarget ? '<span class="dp-target-tag">الأولوية</span>' : ''}</div>
            <div class="dp-meta">${d.dueDate ? `استحقاق ${d.dueDate}` : 'بدون تاريخ استحقاق'} ${d.interest > 0 ? ` • فايدة ${d.interest}%` : ''}</div>
            ${badge}
          </div>
          <div class="dp-amount">${d.remaining.toLocaleString()}<small>ج.م</small></div>
        </div>
      `;
    }).join('');

    const timeline = plan.order.filter(o => o.month).map(o => `
      <div class="dp-timeline-item">
        <div class="dp-timeline-dot"></div>
        <div class="dp-timeline-text">
          <strong>${esc(o.creditor)}</strong> — خلصته في <span class="dp-tl-month">${this.getPayoffDateLabel(o.month)}</span>
        </div>
      </div>
    `).join('');

    const maxDebt = Math.max(...plan.debts.map(d => d.remaining));
    const bars = plan.debts.map(d => {
      const pct = Math.max(6, Math.round((d.remaining / maxDebt) * 100));
      return `
        <div class="dp-bar-row">
          <span class="dp-bar-label">${esc(d.creditor)}</span>
          <div class="dp-bar-track">
            <div class="dp-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="dp-bar-val">${d.remaining.toLocaleString()}</span>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `
      <div class="dp-controls">
        <div class="dp-strategies">
          <button class="dp-strat ${strategy === 'avalanche' ? 'active' : ''}" onclick="app.setDebtStrategy('avalanche')">🏔️ الأعلى أولاً</button>
          <button class="dp-strat ${strategy === 'snowball' ? 'active' : ''}" onclick="app.setDebtStrategy('snowball')">⛄ الأصغر أولاً</button>
        </div>
        <div class="dp-budget-row">
          <label class="dp-budget-label">💰 اللي تقدر تسدده شهرياً:</label>
          <input type="number" id="dpMonthlyBudget" class="form-control" value="${budget || plan.monthlyNeeded}" oninput="app.updateDebtBudget()">
          <span class="dp-budget-unit">ج.م</span>
        </div>
      </div>

      <div class="dp-summary">
        <div class="dp-summary-item">
          <span class="dp-sum-label">إجمالي الديون</span>
          <span class="dp-sum-val val-danger">${plan.totalDebt.toLocaleString()} ج.م</span>
        </div>
        <div class="dp-summary-item">
          <span class="dp-sum-label">تنهيها في</span>
          <span class="dp-sum-val">${plan.months} شهر</span>
        </div>
        <div class="dp-summary-item">
          <span class="dp-sum-label">آخر موعد</span>
          <span class="dp-sum-val val-savings">${this.getPayoffDateLabel(plan.months)}</span>
        </div>
        <div class="dp-summary-item">
          <span class="dp-sum-label">سداد شهري</span>
          <span class="dp-sum-val val-outings">${plan.monthlyNeeded.toLocaleString()} ج.م</span>
        </div>
      </div>

      <div class="dp-section-title">📋 ترتيب السداد الأفضل</div>
      <div class="dp-rows">${rows}</div>

      <div class="dp-section-title">📅 خط زمني الخلاص</div>
      <div class="dp-timeline">${timeline || '<div class="dp-hint">زد المبلغ الشهري عشان الخطة تظهر</div>'}</div>

      <div class="dp-section-title">📊 مقارنة الديون</div>
      <div class="dp-bars">${bars}</div>

      ${plan.totalInterest > 0 ? `<div class="dp-interest-note">💸 لو سددت كل الديون بالترتيب ده، الفايدة الإجمالية ≈ <strong>${plan.totalInterest.toLocaleString()} ج.م</strong></div>` : ''}

      <button class="btn btn-primary btn-full" onclick="app.payDebtPlan()">⚡ سدد أول دين في الترتيب دلوقتي</button>
    `;
  }

  setDebtStrategy(strategy) {
    this.data.settings.debtStrategy = strategy;
    this.saveData();
    this.renderDebtPlanner();
    this.showToast(strategy === 'avalanche' ? '🏔️ تم اختيار: الأعلى أولاً' : '⛄ تم اختيار: الأصغر أولاً');
  }

  updateDebtBudget() {
    const el = document.getElementById('dpMonthlyBudget');
    if (!el) return;
    const val = parseFloat(el.value);
    if (isNaN(val) || val < 0) return;
    this.data.settings.debtMonthlyBudget = val;
    this.saveData();
    const wrap = document.getElementById('debtPlannerWrap');
    if (wrap) {
      const wasBudget = document.activeElement === el;
      this.renderDebtPlanner();
      if (wasBudget) {
        const next = document.getElementById('dpMonthlyBudget');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      }
    }
  }

  // Pay the first debt in the plan using the current spendable balance
  payDebtPlan() {
    const strategy = this.data.settings.debtStrategy || 'avalanche';
    const plan = this.getDebtPlan(strategy, this.data.settings.debtMonthlyBudget || 0);
    if (plan.debts.length === 0) {
      this.showToast('🎉 مفيش ديون متبقية');
      return;
    }
    this.payDebt(plan.debts[0].id);
  }

  // ═══════════════════════════════════════════════════════════
  //  SHARE TARGET  (شارك → BH)
  //  Parse shared text like "50 بنزين" into an expense
  // ═══════════════════════════════════════════════════════════

  // Keyword → category mapping (Arabic + English)
  getCategoryKeywords() {
    return {
      'مواصلات': ['بنزين', 'بزين', 'مواصلات', 'سولار', 'تاكسي', 'أوبر', 'uber', 'petrol', 'fuel', 'ذهاب', 'راجعة', 'تذكرة'],
      'أكل': ['اكل', 'أكل', 'سناكس', 'قهوة', 'شاي', 'فول', 'عشا', 'غدا', 'ساندوتش', 'عصير', 'وجبة', 'food', 'مطعم', 'بيتزا', 'برجر', 'كول', 'وجبة'],
      'خروجة': ['خروجه', 'خروج', 'سهرة', 'سينما', 'movic', 'movie', 'حفل', 'bara'],
      'سما': ['سما', 'سيجارة', 'سجائر', 'تبغ', 'cigarette'],
      'شغل': ['صيانه', 'صيانة', 'اطارات', 'إطارات', 'زيت', 'قطع', 'قطع غيار', 'maintenance', 'اطار'],
      'موبايل/إنترنت': ['موبايل', 'نت', 'انترنت', 'إنترنت', 'شحن', 'فودافون', 'أورانج', 'etisalat', 'we', 'espresso'],
      'ديون': ['دين', 'سداد', 'قسط', 'installment'],
      'أخرى': ['']
    };
  }

  // Parse shared text → { amount, category, note, type }
  parseSharedText(raw) {
    const text = (raw || '').trim();
    if (!text) return null;

    // ── 1. Find the amount ──
    // Look for "number + currency" or "currency + number"
    const amountPatterns = [
      /(\d+(?:[.,]\d+)?)\s*(?:ج\.?\s*م|جنيه|egy|£|\$|لير|ريال|دولار)?/,
      /(?:ج\.?\s*م|جنيه|£|\$)\s*(\d+(?:[.,]\d+)?)/
    ];

    let amount = null;
    for (const re of amountPatterns) {
      const m = text.match(re);
      if (m) {
        const v = parseFloat(String(m[1]).replace(/,/g, ''));
        if (!isNaN(v) && v > 0) { amount = v; break; }
      }
    }
    if (!amount) return null;

    // ── 2. Detect category from keywords ──
    const lower = text.toLowerCase();
    const kw = this.getCategoryKeywords();
    let category = 'أخرى';
    let bestLen = 0;

    for (const [cat, words] of Object.entries(kw)) {
      for (const w of words) {
        if (!w) continue;
        if (lower.includes(w.toLowerCase()) && w.length > bestLen) {
          bestLen = w.length;
          category = cat;
        }
      }
    }

    // ── 3. Detect income keywords ──
    const incomeWords = ['قبض', 'دخل', 'ايراد', 'أرباح', 'ربح', 'استلام', 'تحويل', 'payout', 'income', 'bonus', 'بونص'];
    const isIncome = incomeWords.some(w => lower.includes(w.toLowerCase()));
    const isExpense = !isIncome;

    // ── 4. Clean note (strip the number + matched keyword) ──
    let note = text.replace(amountPatterns[0], '').trim();
    note = note.replace(/^[\s\-–—:،,]+|[\s\-–—:،,]+$/g, '');
    for (const [cat, words] of Object.entries(kw)) {
      for (const w of words) {
        if (w && note.toLowerCase().includes(w.toLowerCase())) {
          note = note.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
        }
      }
    }
    for (const w of incomeWords) {
      if (note.toLowerCase().includes(w.toLowerCase())) {
        note = note.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
      }
    }
    note = note.replace(/^[\s\-–—:،,]+|[\s\-–—:،,]+$/g, '');
    if (!note) note = 'مشاركة من تطبيق آخر';

    return {
      amount: Math.round(amount * 100) / 100,
      category: isExpense ? category : 'طلبات',
      note: note.slice(0, 60),
      type: isIncome ? 'income' : 'expense',
      raw: text
    };
  }

  // Handle a share intent (text + title + url from the URL params)
  handleShareTarget() {
    // A Google sign-in redirect lands back here — finish it before anything else
    if (this.handleAuthRedirect()) return;

    const params = new URLSearchParams(window.location.search);
    const text = params.get('text') || params.get('title') || '';
    const url = params.get('url') || '';
    const combined = [text, url].filter(Boolean).join(' ').trim();

    // Clean up the URL params so a refresh doesn't re-trigger
    if (combined) {
      window.history.replaceState({}, '', './index.html');
    }

    if (!combined) return;

    const parsed = this.parseSharedText(combined);
    if (!parsed) {
      this.showToast('⚠️ مقدرش أفهم المبلغ من النص ده — جرّب تكتب رقم مثل "50 بنزين"', 'error');
      return;
    }

    // Show a confirmation modal with the parsed data
    this.openSharePreview(parsed);
  }

  // Complete a Google sign-in that came back through the redirect flow.
  // Returns true if a redirect was handled (so other handlers can bail out).
  handleAuthRedirect() {
    if (typeof window.BHFirebase === 'undefined') return false;

    // Firebase puts the result in the URL hash or query string
    const hash = window.location.hash || '';
    const search = window.location.search || '';
    const looksLikeRedirect =
      hash.indexOf('firebaseError') >= 0 ||
      hash.indexOf('id_token') >= 0 ||
      hash.indexOf('access_token') >= 0 ||
      search.indexOf('apiKey=') >= 0 ||
      search.indexOf('mode=signIn') >= 0;

    if (!looksLikeRedirect) return false;

    // ⚠️ DO NOT clean the URL yet — Firebase reads the result straight from
    // window.location.hash inside getRedirectResult(). Clearing it first is
    // exactly what made the sign-in appear to "never come back".

    // If the Firebase SDK isn't ready yet, retry once it loads.
    // (Leave the URL untouched so Firebase can still pick up the hash later.)
    const st = window.BHFirebase.getState();
    if (!st.ready) {
      this._pendingAuthRedirect = true;
      return true;
    }

    window.BHFirebase.completeRedirectSignIn().then((user) => {
      // NOW it's safe to clean the URL (after Firebase consumed the hash)
      try {
        window.history.replaceState({}, '', window.location.pathname);
      } catch (e) { /* ignore */ }

      if (user) {
        this._cloudReady = true;
        localStorage.setItem(SYNC_TIME_KEY, String(Date.now()));
        this.updateUserAvatar();
        this.showToast('☁️ تم تسجيل الدخول بـ Google بنجاح!', 'success');
        this.pullFromCloud();
      } else {
        this.updateUserAvatar();
      }
    }).catch(() => {
      // Still clean up so a refresh doesn't loop
      try {
        window.history.replaceState({}, '', window.location.pathname);
      } catch (e) { /* ignore */ }
      this.updateUserAvatar();
    });

    return true;
  }

  // Preview modal for a parsed shared entry
  openSharePreview(parsed) {
    const existing = document.getElementById('sharePreviewModal');
    if (existing) existing.remove();

    const isIncome = parsed.type === 'income';
    const el = document.createElement('div');
    el.id = 'sharePreviewModal';
    el.className = 'modal-overlay active';
    el.innerHTML = `
      <div class="modal-container">
        <div class="modal-header">
          <span class="modal-title">📥 ${isIncome ? 'قبض' : 'مصروف'} من مشاركة</span>
          <button class="close-btn" onclick="document.getElementById('sharePreviewModal').remove()">✕</button>
        </div>

        <div class="share-raw">${parsed.raw.replace(/[<>&]/g, '')}</div>

        <form onsubmit="app.confirmSharedEntry(event)">
          <div class="form-group">
            <label class="form-label">المبلغ (ج.م)</label>
            <input type="number" id="shareAmount" class="form-control" value="${parsed.amount}" step="0.01" required>
          </div>

          ${isIncome ? '' : `
          <div class="form-group">
            <label class="form-label">نوع المصروف</label>
            <select id="shareCategory" class="form-control">
              ${['أكل','مواصلات','خروجة','سما','موبايل/إنترنت','شغل','ديون','أخرى'].map(c =>
                `<option value="${c}" ${c === parsed.category ? 'selected' : ''}>${c}</option>`
              ).join('')}
            </select>
          </div>`}

          <div class="form-group">
            <label class="form-label">ملاحظة</label>
            <input type="text" id="shareNote" class="form-control" value="${parsed.note.replace(/"/g, '&quot;')}">
          </div>

          <div class="form-group">
            <label class="form-label">التاريخ</label>
            <input type="date" id="shareDate" class="form-control" value="${new Date().toISOString().split('T')[0]}">
          </div>

          <button type="submit" class="btn ${isIncome ? 'btn-savings' : 'btn-danger'} btn-full">
            ✅ تأكيد الحفظ
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(el);

    this.showToast(`📥 تم قراءة المبلغ: ${parsed.amount} ج.م`, 'info');
  }

  // Save the confirmed shared entry
  confirmSharedEntry(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('shareAmount').value);
    const date = document.getElementById('shareDate').value || new Date().toISOString().split('T')[0];
    const note = document.getElementById('shareNote').value || '';
    const catEl = document.getElementById('shareCategory');
    const category = catEl ? catEl.value : 'طلبات';

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ مبلغ غير صحيح');
      return;
    }

    const modal = document.getElementById('sharePreviewModal');
    const isIncome = !catEl; // no category select → it was an income

    if (isIncome) {
      // Save as income with the standard split
      const sRatio = this.data.settings.savingsRatio / 100;
      const eRatio = this.data.settings.essentialsRatio / 100;
      const oRatio = this.data.settings.outingsRatio / 100;
      const savingsAmt = Math.round(amount * sRatio);
      const essentialsAmt = Math.round(amount * eRatio);
      const outingsAmt = Math.round(amount * oRatio);

      this.data.balances.reservedSavings += savingsAmt;
      this.data.balances.spendableBalance += (essentialsAmt + outingsAmt);
      this.touchBalances();
      this.data.incomes.unshift({
        id: 'inc_' + Date.now(),
        amount, savingsAmt, essentialsAmt, outingsAmt,
        date, source: 'طلبات', notes: note
      });
    } else {
      this.data.balances.spendableBalance -= amount;
      this.touchBalances();
      this.data.expenses.unshift({
        id: 'exp_' + Date.now(),
        amount, category, note, date
      });
    }

    this.saveData();
    if (modal) modal.remove();
    this.renderAll();
    this.showToast(`✅ تم حفظ ${amount} ج.م بنجاح`, 'success');
  }

  // ═══════════════════════════════════════════════════════════
  //  BALANCE ADJUSTMENT  (تسوية الرصيد الحقيقي)
  //  Sets the real balances WITHOUT creating an income/expense
  // ═══════════════════════════════════════════════════════════

  setAdjustMode(mode) {
    this._adjustMode = mode || 'total';
    const isTotal = this._adjustMode === 'total';

    const btnTotal = document.getElementById('modeTotal');
    const btnDetail = document.getElementById('modeDetail');
    const fTotal = document.getElementById('modeTotalFields');
    const fDetail = document.getElementById('modeDetailFields');

    if (btnTotal) btnTotal.classList.toggle('active', isTotal);
    if (btnDetail) btnDetail.classList.toggle('active', !isTotal);
    if (fTotal) fTotal.style.display = isTotal ? 'block' : 'none';
    if (fDetail) fDetail.style.display = isTotal ? 'none' : 'block';

    this.updateAdjustPreview();
  }

  openBalanceAdjust() {
    const reserved = this.data.balances.reservedSavings;
    const spendable = this.data.balances.spendableBalance;

    const elSpend = document.getElementById('adjustSpendable');
    const elSpend2 = document.getElementById('adjustSpendable2');
    const elRes = document.getElementById('adjustReserved');
    if (elSpend) elSpend.value = spendable;
    if (elSpend2) elSpend2.value = spendable;
    if (elRes) elRes.value = reserved;

    const note = document.getElementById('adjustNote');
    if (note) note.value = '';

    this.setAdjustMode('total');
    this.openModal('balanceAdjustModal');
  }

  // Compute + show the before/after preview
  updateAdjustPreview() {
    const preview = document.getElementById('adjustPreview');
    if (!preview) return;

    const curReserved = this.data.balances.reservedSavings;
    const curSpendable = this.data.balances.spendableBalance;

    const splitEnabled = document.getElementById('adjustSplitEnabled');
    const splitPct = document.getElementById('adjustSplitPct');
    const pctLabel = document.getElementById('adjustSplitPctLabel');
    const splitGroup = document.getElementById('adjustSplitGroup');

    const isSplit = splitEnabled ? splitEnabled.checked : false;
    if (splitGroup) splitGroup.style.display = isSplit ? 'block' : 'none';

    const pct = splitPct ? parseInt(splitPct.value, 10) || 0 : 0;
    if (pctLabel) pctLabel.textContent = pct + '%';

    let newReserved, newSpendable;

    if (this._adjustMode === 'detail') {
      const r = parseFloat(document.getElementById('adjustReserved').value) || 0;
      const s = parseFloat(document.getElementById('adjustSpendable2').value) || 0;
      newReserved = r;
      newSpendable = s;
    } else {
      const total = parseFloat(document.getElementById('adjustSpendable').value) || 0;
      if (isSplit) {
        newReserved = Math.round(total * (pct / 100));
        newSpendable = total - newReserved;
      } else {
        newReserved = curReserved;
        newSpendable = total;
      }
    }

    const curTotal = curReserved + curSpendable;
    const newTotal = newReserved + newSpendable;
    const diff = newTotal - curTotal;

    const diffHtml = diff === 0
      ? `<span class="ap-same">بدون تغيير</span>`
      : diff > 0
        ? `<span class="ap-up">+${diff.toLocaleString()} ج.م زيادة</span>`
        : `<span class="ap-down">${diff.toLocaleString()} ج.م فرق</span>`;

    preview.innerHTML = `
      <div class="ap-row">
        <span class="ap-label">الرصيد دلوقتي</span>
        <span class="ap-val">${curTotal.toLocaleString()} ج.م</span>
      </div>
      <div class="ap-row">
        <span class="ap-label">بعد الضبط</span>
        <span class="ap-val ap-new">${newTotal.toLocaleString()} ج.م</span>
      </div>
      <div class="ap-row">
        <span class="ap-label">الفرق</span>
        ${diffHtml}
      </div>
      <div class="ap-split">
        🔒 تحويش: <strong>${newReserved.toLocaleString()}</strong> &nbsp;•&nbsp;
        💳 صرف: <strong>${newSpendable.toLocaleString()}</strong>
      </div>
    `;
  }

  confirmBalanceAdjust(e) {
    e.preventDefault();

    const splitEnabled = document.getElementById('adjustSplitEnabled');
    const splitPct = document.getElementById('adjustSplitPct');
    const isSplit = splitEnabled ? splitEnabled.checked : false;
    const pct = splitPct ? parseInt(splitPct.value, 10) || 0 : 0;

    let newReserved, newSpendable;

    if (this._adjustMode === 'detail') {
      newReserved = Math.max(0, parseFloat(document.getElementById('adjustReserved').value) || 0);
      newSpendable = Math.max(0, parseFloat(document.getElementById('adjustSpendable2').value) || 0);
    } else {
      const total = Math.max(0, parseFloat(document.getElementById('adjustSpendable').value) || 0);
      if (isSplit) {
        newReserved = Math.round(total * (pct / 100));
        newSpendable = total - newReserved;
      } else {
        newReserved = this.data.balances.reservedSavings;
        newSpendable = total;
      }
    }

    const oldReserved = this.data.balances.reservedSavings;
    const oldSpendable = this.data.balances.spendableBalance;
    const oldTotal = oldReserved + oldSpendable;
    const newTotal = newReserved + newSpendable;
    const diff = newTotal - oldTotal;

    if (oldReserved === newReserved && oldSpendable === newSpendable) {
      this.showToast('ℹ️ مفيش تغيير في الرصيد');
      this.closeModal('balanceAdjustModal');
      return;
    }

    // Apply
    this.data.balances.reservedSavings = newReserved;
    this.data.balances.spendableBalance = newSpendable;
    this.touchBalances();

    // Keep an audit log of adjustments (not counted as income/expenses)
    if (!this.data.adjustments) this.data.adjustments = [];
    const noteEl = document.getElementById('adjustNote');
    this.data.adjustments.unshift({
      id: 'adj_' + Date.now(),
      date: new Date().toISOString().split('T')[0],
      oldTotal, newTotal, diff,
      oldReserved, oldSpendable,
      newReserved, newSpendable,
      note: noteEl ? noteEl.value : ''
    });
    if (this.data.adjustments.length > 50) this.data.adjustments.length = 50;

    this.saveData();
    this.closeModal('balanceAdjustModal');
    this.renderAll();
    if (diff > 0) {
      this.showToast(`✅ تم ضبط الرصيد — زيادة ${diff.toLocaleString()} ج.م (بدون قيد قبض)`, 'success');
    } else {
      this.showToast(`✅ تم ضبط الرصيد — فرق ${Math.abs(diff).toLocaleString()} ج.م (بدون قيد مصروف)`, 'info');
    }
  }

  // Show the adjustment history
  renderAdjustHistory() {
    const box = document.getElementById('adjustHistoryBox');
    if (!box) return;

    const list = this.data.adjustments || [];
    if (list.length === 0) {
      box.innerHTML = '<div class="adjust-empty">لسه مفيش تسويات — اضبط رصيدك أول مرة عشان التطبيق يبدأ من رقم صح</div>';
      return;
    }

    box.innerHTML = list.slice(0, 8).map(a => `
      <div class="adjust-item">
        <div class="adjust-item-main">
          <span class="adjust-item-title">
            ${a.diff >= 0 ? '📈' : '📉'}
            ${a.diff >= 0 ? '+' : ''}${a.diff.toLocaleString()} ج.م
          </span>
          <span class="adjust-item-sub">${a.date} • ${a.oldTotal.toLocaleString()} ← ${a.newTotal.toLocaleString()}${a.note ? ' • ' + a.note : ''}</span>
        </div>
      </div>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════
  //  USER ACCOUNT  (حساب المستخدم + صورة البروفايل)
  // ═══════════════════════════════════════════════════════════

  updateUserAvatar() {
    this.renderHeaderSync();
    const user = (typeof window.BHFirebase !== 'undefined') ? window.BHFirebase.getUser() : null;
    const photo = (user && user.photoURL) ? user.photoURL : null;
    const name = (user && (user.displayName || user.email)) || 'مستخدم مجهول';
    const isAnon = !user || user.isAnonymous;

    const img = document.getElementById('userAvatarImg');
    const fb = document.getElementById('userAvatarFallback');
    if (img && fb) {
      if (photo) {
        img.src = photo;
        img.style.display = 'block';
        fb.style.display = 'none';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
        fb.style.display = 'flex';
        fb.textContent = isAnon ? '👤' : (name.charAt(0) || '👤').toUpperCase();
      }
    }

    const mImg = document.getElementById('menuAvatarImg');
    const mFb = document.getElementById('menuAvatarFallback');
    if (mImg && mFb) {
      if (photo) {
        mImg.src = photo;
        mImg.style.display = 'block';
        mFb.style.display = 'none';
      } else {
        mImg.removeAttribute('src');
        mImg.style.display = 'none';
        mFb.style.display = 'flex';
        mFb.textContent = isAnon ? '👤' : (name.charAt(0) || '👤').toUpperCase();
      }
    }

    const mName = document.getElementById('userMenuName');
    const mEmail = document.getElementById('userMenuEmail');
    if (mName) mName.textContent = isAnon ? 'مستخدم مجهول' : name;
    if (mEmail) mEmail.textContent = user && user.email ? user.email : (isAnon ? 'هذا الجهاز بس' : '—');

    const st = (typeof window.BHFirebase !== 'undefined') ? window.BHFirebase.getState() : null;
    const dot = document.getElementById('syncDot');
    const syncTxt = document.getElementById('userMenuSyncText');
    if (dot && syncTxt && st) {
      const map = {
        'synced': ['ok', 'متزامن مع السحابة'],
        'syncing': ['busy', 'جاري المزامنة...'],
        'offline': ['warn', 'مفيش نت'],
        'error': ['bad', 'مشكلة في المزامنة'],
        'signed-out': ['idle', 'غير مسجّل دخول'],
        'not-configured': ['idle', 'المزامنة مش مفعّلة'],
        'sdk-missing': ['warn', 'مكتبة Firebase مش محمّلة']
      };
      const m = map[st.status] || ['idle', st.status];
      dot.className = 'sync-dot ' + m[0];
      syncTxt.textContent = m[1];
    }

    const btn = document.getElementById('userAvatarBtn');
    if (btn) btn.classList.toggle('signed-in', !!user && !isAnon);

    // Show / hide the sign-in vs sign-out buttons
    const signOutBtn = document.getElementById('menuSignOutBtn');
    const syncBtn = document.getElementById('menuSyncBtn');
    if (signOutBtn) signOutBtn.style.display = user ? 'block' : 'none';
    if (syncBtn) syncBtn.style.display = user ? 'block' : 'none';
  }

  toggleUserMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('userMenu');
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    this.closeUserMenu();
    if (!isOpen) {
      menu.classList.add('open');
      this.updateUserAvatar();
    }
  }

  closeUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.remove('open');
  }

  // ═══════════════════════════════════════════════════════════
  //  FIRST-RUN WELCOME  (تسجيل دخول Google أول ما تفتح)
  // ═══════════════════════════════════════════════════════════

  maybeShowWelcome() {
    if (this.data.settings.welcomeSeen) return;
    if (typeof window.BHFirebase === 'undefined' || !window.BHFirebase.isConfigured()) return;
    if (window.BHFirebase.getUser()) {
      this.data.settings.welcomeSeen = true;
      this.saveData();
      return;
    }
    setTimeout(() => this.showWelcomeModal(), 700);
  }

  showWelcomeModal() {
    const existing = document.getElementById('welcomeModal');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'welcomeModal';
    el.className = 'modal-overlay active welcome-overlay';
    el.innerHTML = `
      <div class="modal-container welcome-box">
        <div class="welcome-logo">💰</div>
        <h2 class="welcome-title">أهلاً بيك في BH 👋</h2>
        <p class="welcome-sub">
          سجّل دخول بـ Google مرة واحدة، وم بعدها<b> بياناتك هتتنزّل على السحابة</b> وتتفتح من أي جهاز — ومن غير ما تضيع أبداً.
        </p>

        <div class="welcome-benefits">
          <div class="welcome-benefit"><span>☁️</span><span>مزامنة تلقائية بين كل أجهزتك</span></div>
          <div class="welcome-benefit"><span>🛡️</span><span>بياناتك محفوظة لو مسحت المتصفح</span></div>
          <div class="welcome-benefit"><span>⚡</span><span>تفتح التطبيق وبياناتك جاهزة</span></div>
        </div>

        <button class="btn btn-primary btn-full welcome-google" onclick="app.welcomeGoogle()">
          <span class="google-g">G</span> المتابعة بحساب Google
        </button>
        <div class="welcome-alt">
          <button class="btn btn-secondary btn-sm" onclick="app.welcomeAnon()">🔓 دخول سريع (هذا الجهاز بس)</button>
        </div>
        <button class="welcome-skip" onclick="app.skipWelcome()">تخطي — أعمله بعدين</button>
      </div>
    `;
    document.body.appendChild(el);
  }

  async welcomeGoogle() {
    const btn = document.querySelector('.welcome-google');
    if (btn) { btn.innerHTML = '⏳ جاري فتح Google...'; btn.disabled = true; }
    await this.cloudSignInGoogle();
    this.closeWelcome();
  }

  async welcomeAnon() {
    const btn = document.querySelector('.welcome-alt .btn');
    if (btn) { btn.innerHTML = '⏳ جاري الدخول...'; btn.disabled = true; }
    await this.cloudSignInAnon();
    this.closeWelcome();
  }

  skipWelcome() {
    this.closeWelcome();
  }

  closeWelcome() {
    this.data.settings.welcomeSeen = true;
    this.saveData();
    const el = document.getElementById('welcomeModal');
    if (el) {
      el.classList.remove('active');
      setTimeout(() => el.remove(), 250);
    }
    this.updateUserAvatar();
  }

  // ═══════════════════════════════════════════════════════════
  //  SMART ALERTS  (التنبيهات الذكية)
  // ═══════════════════════════════════════════════════════════

  getSmartAlertSettings() {
    const s = this.data.settings.smartAlerts || {};
    return {
      enabled: s.enabled !== false,
      lowBalanceEnabled: s.lowBalanceEnabled !== false,
      lowBalanceThreshold: Number(s.lowBalanceThreshold) || 200,
      forgotShiftEnabled: s.forgotShiftEnabled !== false,
      goalCloseEnabled: s.goalCloseEnabled !== false,
      outingsBudgetEnabled: s.outingsBudgetEnabled !== false,
      lastShown: s.lastShown || {}
    };
  }

  // Evaluate every condition and return the active alerts
  getSmartAlerts() {
    const cfg = this.getSmartAlertSettings();
    if (!cfg.enabled) return [];

    const alerts = [];
    const spendable = this.data.balances.spendableBalance;

    // 1) Low balance
    if (cfg.lowBalanceEnabled && spendable > 0 && spendable <= cfg.lowBalanceThreshold) {
      alerts.push({
        id: 'low_balance',
        icon: '💸',
        level: spendable <= cfg.lowBalanceThreshold / 2 ? 'red' : 'yellow',
        title: 'رصيدك المتاح قارب يعمل',
        body: `فاضل ${spendable.toLocaleString()} ج.م بس — خلّي بالك قبل ما تصرف.`,
        action: 'سجّل مصروف'
      });
    } else if (cfg.lowBalanceEnabled && spendable <= 0) {
      alerts.push({
        id: 'no_balance',
        icon: '🚨',
        level: 'red',
        title: 'رصيدك المتاح خلص',
        body: 'مفيش فلوس للصرف دلوقتي — السحب من التحويش يبقى خطر.',
        action: 'شوف التحويش'
      });
    }

    // 2) Forgot to log yesterday's shift
    if (cfg.forgotShiftEnabled) {
      const sessions = this.data.workSessions || [];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yKey = yesterday.toISOString().split('T')[0];
      const loggedYesterday = sessions.some(w => w.date === yKey);
      const loggedToday = sessions.some(w => w.date === new Date().toISOString().split('T')[0]);
      // Only nag if the user normally works (logged at least once in the last 7 days)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const recentCount = sessions.filter(w => new Date(w.date) >= weekAgo).length;

      if (!loggedYesterday && !loggedToday && recentCount >= 2) {
        alerts.push({
          id: 'forgot_shift',
          icon: '📋',
          level: 'yellow',
          title: 'مفيش وردية مسجلة امبارح',
          body: 'سجّل وردية امبارح عشان خريطة شغلك وأرقامك تفضل دقيقة.',
          action: 'سجّل وردية'
        });
      }
    }

    // 3) A goal is close to completion
    if (cfg.goalCloseEnabled) {
      (this.data.goals || []).forEach(g => {
        if (!g.targetAmount || g.currentAmount >= g.targetAmount) return;
        const remaining = g.targetAmount - g.currentAmount;
        const pct = (g.currentAmount / g.targetAmount) * 100;
        if (pct >= 80 && remaining > 0) {
          alerts.push({
            id: 'goal_close_' + g.id,
            icon: '🎯',
            level: 'green',
            title: `هدف "${g.title}" قارب يتحقق`,
            body: `فاضل ${remaining.toLocaleString()} ج.م بس (${Math.round(pct)}% خلص).`,
            action: 'الأهداف'
          });
        }
      });
    }

    // 4) Weekly outings budget nearly gone
    if (cfg.outingsBudgetEnabled) {
      const budget = this.data.settings.weeklyOutingsBudget || 0;
      const spent = this.getWeeklyOutingsSpent();
      if (budget > 0 && spent >= budget * 0.9 && spent < budget) {
        alerts.push({
          id: 'outings_close',
          icon: '❤️',
          level: 'yellow',
          title: 'ميزانية الخروجات أوشكت',
          body: `فاضل ${(budget - spent).toLocaleString()} ج.م من ${budget.toLocaleString()} ج.م هذا الأسبوع.`,
          action: 'المصاريف'
        });
      }
    }

    return alerts;
  }

  // Handle tapping an alert action
  handleAlertAction(alertId) {
    const alerts = this.getSmartAlerts();
    const a = alerts.find(x => x.id === alertId);
    if (!a) return;
    if (a.id === 'low_balance' || a.id === 'no_balance') {
      this.switchTab('moreView');
      this.showToast('💡 اسحب من التحويش لو محتاج — بس ده هيكسر الـ Streak', 'info');
    } else if (a.id === 'forgot_shift') {
      this.switchTab('incomesView');
      setTimeout(() => {
        const el = document.getElementById('shiftOrders');
        if (el) el.scrollIntoView({ block: 'center' });
      }, 300);
    } else if (a.id === 'goal_close_' + a.id.split('goal_close_')[1]) {
      this.switchTab('goalsView');
    } else if (a.id === 'outings_close') {
      this.switchTab('expensesView');
    }
    this.dismissAlert(a.id);
  }

  // Mark an alert as seen (don't show it again today)
  dismissAlert(alertId) {
    const cfg = this.getSmartAlertSettings();
    cfg.lastShown[alertId] = new Date().toISOString().split('T')[0];
    this.data.settings.smartAlerts = Object.assign({}, this.data.settings.smartAlerts, cfg);
    this.saveData();
    this.renderSmartAlerts();
  }

  // Render the in-app alert card on the dashboard
  renderSmartAlerts() {
    const card = document.getElementById('smartAlertsCard');
    if (!card) return;

    const all = this.getSmartAlerts();
    const cfg = this.getSmartAlertSettings();
    const today = new Date().toISOString().split('T')[0];
    // Hide alerts already dismissed today
    const alerts = all.filter(a => cfg.lastShown[a.id] !== today);

    if (alerts.length === 0) {
      card.style.display = 'none';
      card.innerHTML = '';
      return;
    }

    card.style.display = 'block';
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title"><span class="card-icon">🔔</span> تنبيهات تحتاج انتباه</span>
        <span class="sub-balance-label">${alerts.length}</span>
      </div>
      ${alerts.map(a => `
        <div class="sa-item ${a.level}">
          <div class="sa-icon">${a.icon}</div>
          <div class="sa-body">
            <div class="sa-title">${esc(a.title)}</div>
            <div class="sa-text">${a.body}</div>
          </div>
          <div class="sa-actions">
            <button class="sa-btn" onclick="app.handleAlertAction('${a.id}')">${a.action}</button>
            <button class="sa-dismiss" onclick="app.dismissAlert('${a.id}')" title="إخفاء">✕</button>
          </div>
        </div>
      `).join('')}
    `;
  }

  // Schedule a system notification for the next morning (via the Service Worker)
  scheduleSmartNotification() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;

    const cfg = this.getSmartAlertSettings();
    if (!cfg.enabled) return;

    // Next check: tomorrow 9:00 AM
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(9, 0, 0, 0);

    const alerts = this.getSmartAlerts();
    const top = alerts[0];
    // ☀️ لو مفيش تنبيهات مهمة — رسالة تشجيع الصبح بتاعة ساعية الذروة
    const pep = top ? null : this.morningPushMsg();
    const title = top ? top.title : (pep ? pep.t : 'صباح الفلوس ☀️');
    const body = top ? top.body : (pep ? pep.b : 'افتح BH وشوف رصيدك ووردية امبارح.');

    try {
      navigator.serviceWorker.controller.postMessage({
        action: 'SCHEDULE_SMART_ALERT',
        timestamp: when.getTime(),
        title,
        body,
        tag: 'bh-smart-alert'
      });
    } catch (e) { /* non-critical */ }
  }

  // Render the smart alerts settings card
  renderSmartAlertSettings() {
    const box = document.getElementById('smartAlertSettings');
    if (!box) return;

    const cfg = this.getSmartAlertSettings();
    const peaks = this.getPeaksCfg();
    const alerts = this.getSmartAlerts();

    box.innerHTML = `
      <div class="sa-settings-row">
        <div>
          <strong>🔔 التنبيهات الذكية</strong>
          <small>تنبيهات على الرصيد والورديات والأهداف</small>
        </div>
        <button class="sa-toggle ${cfg.enabled ? 'on' : ''}" onclick="app.toggleSmartAlert('enabled')">${cfg.enabled ? '✓' : '○'}</button>
      </div>

      <div class="sa-settings-sub ${cfg.enabled ? '' : 'disabled'}">
        <div class="sa-settings-row">
          <div>
            <strong>🚦 نغمة الذروة</strong>
            <small>تشجيع حي صبح وبليل حسب ساعة الذروة</small>
          </div>
          <button class="sa-toggle ${peaks.enabled ? 'on' : ''}" onclick="app.togglePeakAlerts()">${peaks.enabled ? '✓' : '○'}</button>
        </div>

        ${peaks.enabled ? `
        <div class="sa-settings-row">
          <div><small>🌅 ذروة الصبح</small></div>
          <div style="display:flex;">
            <input type="time" id="saPeakMorning" class="form-control" value="${peaks.morning}" onchange="app.savePeakTime('morning')" style="width:100px; padding:4px 8px !important; text-align:center; font-size:.8rem;">
          </div>
        </div>
        <div class="sa-settings-row">
          <div><small>🌙 ذروة الليل</small></div>
          <div style="display:flex;">
            <input type="time" id="saPeakNight" class="form-control" value="${peaks.night}" onchange="app.savePeakTime('night')" style="width:100px; padding:4px 8px !important; text-align:center; font-size:.8rem;">
          </div>
        </div>` : ''}

        <div class="sa-settings-row">
          <div>
            <strong>💸 رصيدك قارب يعمل</strong>
            <small>ينبهك لما المتاح للصرف يقل عن</small>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <input type="number" id="saThreshold" class="form-control" value="${cfg.lowBalanceThreshold}" min="0" step="10" oninput="app.saveSmartAlertThreshold()" style="width:78px; padding:6px 8px !important; text-align:center; font-size:.82rem;">
            <span style="font-size:.7rem; color:var(--text-muted);">ج.م</span>
          </div>
        </div>

        <div class="sa-settings-row">
          <div>
            <strong>📋 نسيت تسجّل وردية</strong>
            <small>لو مفيش وردية مسجلة امبارح</small>
          </div>
          <button class="sa-toggle ${cfg.forgotShiftEnabled ? 'on' : ''}" onclick="app.toggleSmartAlert('forgotShiftEnabled')">${cfg.forgotShiftEnabled ? '✓' : '○'}</button>
        </div>

        <div class="sa-settings-row">
          <div>
            <strong>🎯 هدفك قارب يتحقق</strong>
            <small>لما توصل 80% من أي هدف</small>
          </div>
          <button class="sa-toggle ${cfg.goalCloseEnabled ? 'on' : ''}" onclick="app.toggleSmartAlert('goalCloseEnabled')">${cfg.goalCloseEnabled ? '✓' : '○'}</button>
        </div>

        <div class="sa-settings-row">
          <div>
            <strong>❤️ ميزانية الخروجات أوشكت</strong>
            <small>لما توصل 90% من ميزانية الأسبوع</small>
          </div>
          <button class="sa-toggle ${cfg.outingsBudgetEnabled ? 'on' : ''}" onclick="app.toggleSmartAlert('outingsBudgetEnabled')">${cfg.outingsBudgetEnabled ? '✓' : '○'}</button>
        </div>
      </div>

      <div class="sa-current">
        التنبيهات النشطة دلوقتي: <strong>${alerts.length}</strong>
        ${alerts.length ? '<br>' + alerts.map(a => a.icon + ' ' + a.title).join('<br>') : ''}
      </div>

      <button class="btn btn-secondary btn-full btn-sm" onclick="app.testSmartNotification()" style="margin-top:10px;">
        🔔 اختبر إشعار دلوقتي
      </button>
    `;
  }

  toggleSmartAlert(key) {
    const cfg = this.getSmartAlertSettings();
    const stored = this.data.settings.smartAlerts || {};
    stored[key] = !cfg[key];
    this.data.settings.smartAlerts = stored;
    this.saveData();
    this.renderSmartAlertSettings();
    this.renderSmartAlerts();
  }

  saveSmartAlertThreshold() {
    const el = document.getElementById('saThreshold');
    if (!el) return;
    const v = parseFloat(el.value);
    if (isNaN(v) || v < 0) return;
    const stored = this.data.settings.smartAlerts || {};
    stored.lowBalanceThreshold = v;
    this.data.settings.smartAlerts = stored;
    this.saveData();
    this.renderSmartAlerts();
  }

  // Fire a test notification right now
  async testSmartNotification() {
    const alerts = this.getSmartAlerts();
    const title = alerts.length ? alerts[0].title : '🔔 تنبيه تجريبي من BH';
    const body = alerts.length ? alerts[0].body : 'ده إشعار تجريبي — التنبيهات شغالة تمام!';

    // In-app toast (always works)
    this.showToast(title + ' — ' + body, 'info');

    // System notification (if allowed)
    try {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification(title, { body, icon: 'assets/icon-192.png', tag: 'bh-smart-test' });
        } else if (Notification.permission === 'default') {
          const p = await Notification.requestPermission();
          if (p === 'granted') {
            new Notification(title, { body, icon: 'assets/icon-192.png', tag: 'bh-smart-test' });
          } else {
            this.showToast('⚠️ الإشعارات مسموحةش — فعّلها من إعدادات المتصفح', 'error');
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════
  //  SHARE
  // ═══════════════════════════════════════════════════════════

  // Share the app (Web Share API, with a copy-link fallback)
  async shareApp() {
    const url = window.location.origin + window.location.pathname;
    const text = 'BH — تطبيق إدارة القبض والمصاريف لفرسان الدليفري. جرّبه من هنا:';

    if (navigator.share) {
      try { await navigator.share({ title: 'BH — إدارة الفلوس', text: text, url: url }); } catch (e) { /* cancelled */ }
      return;
    }
    // Fallback: copy the link
    try {
      await navigator.clipboard.writeText(url);
      this.showToast('📋 تم نسخ الرابط', 'success');
    } catch (e) {
      this.showToast('📋 ' + url, 'info');
    }
  }

  get GITHUB_API()  { return 'https://api.github.com/repos/TDRS10/-bh/commits?per_page=1'; }
  get UPDATE_KEY()  { return 'BH_LAST_COMMIT_SHA'; }

  initUpdateUI() {
    var savedSHA = localStorage.getItem(this.UPDATE_KEY);
    var versionLabel = document.getElementById('currentVersionLabel');
    if (versionLabel) {
      versionLabel.textContent = savedSHA ? 'v' + savedSHA.substring(0, 7) : 'غير محدد';
    }

    var notifyBtn = document.getElementById('notifyPermissionBtn');
    if (notifyBtn && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        notifyBtn.textContent = '🔔 الإشعارات مفعلة ✅';
        notifyBtn.className = 'btn btn-secondary btn-full btn-sm';
      } else if (Notification.permission === 'denied') {
        notifyBtn.textContent = '🔕 الإشعارات محظورة في المتصفح';
      } else {
        notifyBtn.textContent = '🔔 تفعيل إشعارات التحديثات';
      }
    }
  }

  async toggleNotifications() {
    if (!('Notification' in window)) {
      this.showToast('⚠️ المتصفح لا يدعم إشعارات النظام', 'error');
      return;
    }

    if (Notification.permission === 'granted') {
      this.showToast('🔔 الإشعارات مفعلة بالفعل للتحديثات!', 'info');
      return;
    }

    if (Notification.permission === 'denied') {
      this.showToast('🔕 الإشعارات محظورة. يرجى تفعيلها من إعدادات المتصفح', 'error');
      return;
    }

    try {
      var permission = await Notification.requestPermission();
      this.initUpdateUI();
      if (permission === 'granted') {
        this.showToast('🎉 تم تفعيل إشعارات التحديث بنجاح!', 'success');
        try {
          new Notification('🔔 تطبيق BH', {
            body: 'تم تفعيل إشعارات التحديثات بنجاح!',
            icon: 'assets/icon-192.png'
          });
        } catch (e) {}
      } else {
        this.showToast('⚠️ لم يتم منح إذن الإشعارات', 'info');
      }
    } catch (e) {
      console.error('Notification permission error:', e);
    }
  }

  autoCheckUpdates() {
    // Check 5 seconds after launch silently
    setTimeout(() => {
      this.checkForUpdates(true);
    }, 5000);

    // Check periodically every 30 minutes
    setInterval(() => {
      this.checkForUpdates(true);
    }, 30 * 60 * 1000);
  }

  async checkForUpdates(isSilent) {
    var btn = document.getElementById('checkUpdateBtn');
    var statusBox = document.getElementById('updateStatus');
    var statusIcon = document.getElementById('updateStatusIcon');
    var statusText = document.getElementById('updateStatusText');
    var applyBtn = document.getElementById('applyUpdateBtn');

    if (!isSilent && btn) {
      btn.innerHTML = '⏳ جاري التحقق...';
      btn.disabled = true;
    }

    try {
      var response = await fetch(this.GITHUB_API);

      if (!response.ok) throw new Error('HTTP ' + response.status);

      var rawData = await response.json();
      var data = Array.isArray(rawData) ? rawData[0] : rawData;
      if (!data || !data.sha) throw new Error('لم يتم العثور على بيانات التحديث');

      var latestSHA = data.sha;
      var savedSHA = localStorage.getItem(this.UPDATE_KEY);
      var commitMsg = (data.commit && data.commit.message) ? data.commit.message : 'تحديث جديد';
      var rawDate = data.commit && data.commit.committer && data.commit.committer.date;
      var commitDate = rawDate
        ? new Date(rawDate).toLocaleDateString('ar-EG', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
          })
        : '';

      if (statusBox) statusBox.style.display = 'flex';

      if (savedSHA && savedSHA === latestSHA) {
        if (statusBox) {
          statusBox.className = 'decision-card decision-green';
          statusIcon.textContent = '✅';
          statusText.innerHTML = 'التطبيق محدث لآخر نسخة<br><span style="font-size:.72rem;opacity:.7;">' + commitDate + '</span>';
        }
        if (applyBtn) applyBtn.style.display = 'none';
        if (!isSilent) this.showToast('✅ التطبيق محدث بالفعل!', 'success');
      } else {
        if (statusBox) {
          statusBox.className = 'decision-card decision-yellow';
          statusIcon.textContent = '🆕';
          statusText.innerHTML = 'تحديث جديد متاح!<br><span style="font-size:.72rem;opacity:.7;">' + commitMsg.substring(0, 60) + '</span><br><span style="font-size:.68rem;opacity:.6;">' + commitDate + '</span>';
        }
        if (applyBtn) applyBtn.style.display = 'flex';
        this._pendingUpdateSHA = latestSHA;

        // Trigger Notification
        if (window.Notification && Notification.permission === 'granted') {
          if (this._lastNotifiedSHA !== latestSHA) {
            this._lastNotifiedSHA = latestSHA;
            try {
              var notif = new Notification('🆕 تحديث جديد متاح لتطبيق BH', {
                body: commitMsg,
                icon: 'assets/icon-192.png',
                tag: 'bh-update-' + latestSHA
              });
              notif.onclick = function() {
                window.focus();
                if (window.app) window.app.switchTab('moreView');
              };
            } catch (e) {
              console.log('Notification trigger error:', e);
            }
          }
        }

        this.showToast('🔔 يوجد تحديث جديد متاح للتطبيق!', 'info');
      }
    } catch (err) {
      console.error('Update check failed:', err);
      if (!isSilent) {
        if (statusBox) {
          statusBox.style.display = 'flex';
          statusBox.className = 'decision-card decision-red';
          statusIcon.textContent = '❌';
          statusText.innerHTML = 'فشل التحقق<br><span style="font-size:.7rem;opacity:.6;">(' + err.message + ')</span>';
        }
        if (applyBtn) applyBtn.style.display = 'none';
        this.showToast('❌ فشل — ' + err.message, 'error');
      }
    } finally {
      if (!isSilent && btn) {
        btn.innerHTML = '🔍 تحقق من التحديثات';
        btn.disabled = false;
      }
    }
  }

  async applyUpdate() {
    var applyBtn = document.getElementById('applyUpdateBtn');
    var statusIcon = document.getElementById('updateStatusIcon');
    var statusText = document.getElementById('updateStatusText');
    var statusBox = document.getElementById('updateStatus');

    applyBtn.innerHTML = '⏳ جاري التحديث...';
    applyBtn.disabled = true;
    statusBox.className = 'decision-card decision-yellow';
    statusIcon.textContent = '⏳';
    statusText.textContent = 'جاري تحميل التحديث...';

    try {
      // 1. Clear all service worker caches
      if ('caches' in window) {
        var cacheNames = await caches.keys();
        for (var i = 0; i < cacheNames.length; i++) {
          await caches.delete(cacheNames[i]);
        }
      }

      // 2. Unregister service worker
      if ('serviceWorker' in navigator) {
        var registrations = await navigator.serviceWorker.getRegistrations();
        for (var j = 0; j < registrations.length; j++) {
          await registrations[j].unregister();
        }
      }

      // 3. Save the new commit SHA
      if (this._pendingUpdateSHA) {
        localStorage.setItem(this.UPDATE_KEY, this._pendingUpdateSHA);
      }

      statusIcon.textContent = '✅';
      statusText.textContent = 'تم التحديث! جاري إعادة التحميل...';
      statusBox.className = 'decision-card decision-green';
      this.showToast('✅ تم التحديث بنجاح!', 'success');

      // 4. Hard reload
      setTimeout(function() {
        window.location.reload(true);
      }, 1200);

    } catch (err) {
      console.error('Update failed:', err);
      statusIcon.textContent = '❌';
      statusText.textContent = 'فشل التحديث — حاول مرة ثانية';
      statusBox.className = 'decision-card decision-red';
      applyBtn.innerHTML = '⬇️ حدّث الآن';
      applyBtn.disabled = false;
      this.showToast('❌ فشل التحديث', 'error');
    }
  }

  // Save current version on first load
  async saveInitialVersion() {
    var savedSHA = localStorage.getItem(this.UPDATE_KEY);
    if (!savedSHA) {
      try {
        var response = await fetch(this.GITHUB_API);
        if (response.ok) {
          var rawData = await response.json();
          var data = Array.isArray(rawData) ? rawData[0] : rawData;
          if (data && data.sha) {
            localStorage.setItem(this.UPDATE_KEY, data.sha);
            this.initUpdateUI();
          }
        }
      } catch (e) {
        // Offline — skip
      }
    }
  }
}

// Global App Instance
let app;
window.addEventListener('DOMContentLoaded', function() {
  app = new BHApp();
  app.initUpdateUI();
  app.saveInitialVersion();
  app.autoCheckUpdates();
});
