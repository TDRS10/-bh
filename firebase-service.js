/* ============================================================
   BH — Firebase Service Layer
   --------------------------------------------------------
   Responsibilities:
   • init Firebase (if configured)
   • anonymous + Google sign-in
   • push / pull the app data blob to the cloud
   • expose sync status to the UI
   • NEVER throw into the app — the app must keep working
     on localStorage alone if Firebase is missing/broken.
   ============================================================ */

window.BHFirebase = (function () {
  'use strict';

  const DATA_PATH = 'app';
  const META_PATH = 'meta';

  const state = {
    configured: false,   // config present + SDK loaded
    ready: false,        // firebase initialised
    user: null,          // current user
    status: 'not-configured', // not-configured | sdk-missing | ready | signed-out | syncing | synced | offline | error
    lastSync: null,      // ms timestamp
    lastError: null,
    listeners: []
  };

  function emit() {
    state.listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* listener errors must not break the app */ }
    });
  }

  function setStatus(status, err) {
    state.status = status;
    state.lastError = err || null;
    emit();
  }

  function isConfigured() {
    const cfg = window.BH_FIREBASE_CONFIG;
    return !!(cfg && cfg.apiKey && cfg.databaseURL && cfg.projectId);
  }

  /* ── Init ─────────────────────────────────────────────── */
  function init(attempt) {
    attempt = attempt || 0;

    if (!isConfigured()) {
      setStatus('not-configured');
      return false;
    }

    if (typeof firebase === 'undefined' || !firebase || !firebase.initializeApp) {
      setStatus('sdk-missing');
      return false;
    }

    // The auth / database libraries load as separate scripts — wait for them.
    if (typeof firebase.database !== 'function' || typeof firebase.auth !== 'function') {
      if (attempt < 40) {
        setTimeout(function () { init(attempt + 1); }, 100);
        return false;
      }
      setStatus('sdk-missing');
      return false;
    }

    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(window.BH_FIREBASE_CONFIG);
      }

      state.db = firebase.database();
      state.auth = firebase.auth();
      state.configured = true;
      state.ready = true;

      state.auth.onAuthStateChanged(function (user) {
        state.user = user;
        if (user) {
          setStatus('synced');
        } else {
          setStatus('signed-out');
        }
        emit();
      });

      // Connection monitoring
      try {
        state.db.ref('.info/connected').on('value', function (snap) {
          if (snap.val() === false && state.user) {
            setStatus('offline');
          } else if (snap.val() === true && state.user && state.status === 'offline') {
            setStatus('synced');
          }
        });
      } catch (e) { /* non-critical */ }

      setStatus('signed-out');
      return true;
    } catch (e) {
      console.error('Firebase init failed:', e);
      setStatus('error', e.message);
      return false;
    }
  }

  /* ── Auth ─────────────────────────────────────────────── */
  function signInAnonymously() {
    if (!state.auth) return Promise.reject(new Error('Firebase غير مفعّل'));
    setStatus('syncing');
    return state.auth.signInAnonymously()
      .then(function (cred) {
        state.user = cred.user;
        setStatus('synced');
        return cred.user;
      })
      .catch(function (e) {
        setStatus('error', e.message);
        throw e;
      });
  }

  function signInWithGoogle() {
    if (!state.auth) return Promise.reject(new Error('Firebase غير مفعّل'));
    setStatus('syncing');

    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    return state.auth.signInWithPopup(provider)
      .then(function (cred) {
        state.user = cred.user;
        setStatus('synced');
        return cred.user;
      })
      .catch(function (e) {
        setStatus('error', e.message);
        throw e;
      });
  }

  // Complete a sign-in that came back through the redirect flow
  function completeRedirectSignIn() {
    if (!state.auth) return Promise.resolve(null);
    return state.auth.getRedirectResult()
      .then(function (result) {
        if (result && result.user) {
          state.user = result.user;
          setStatus('synced');
          return result.user;
        }
        return null;
      })
      .catch(function (e) {
        // "The redirect URI does not match..." etc.
        if (e && e.code === 'auth/operation-not-supported-in-this-environment') {
          setStatus('signed-out');
          return null;
        }
        setStatus('error', e.message);
        return null;
      });
  }

  function signOut() {
    if (!state.auth) return Promise.resolve();
    return state.auth.signOut().then(function () {
      state.user = null;
      setStatus('signed-out');
    });
  }

  /* ── Data sync ────────────────────────────────────────── */
  function userPath() {
    if (!state.user) return null;
    return 'users/' + state.user.uid;
  }

  // Pull the remote envelope { updatedAt, data }
  function pull() {
    const base = userPath();
    if (!base) return Promise.resolve(null);

    setStatus('syncing');
    return state.db.ref(base + '/' + DATA_PATH).once('value')
      .then(function (snap) {
        const val = snap.val();
        if (!val || !val.data) {
          setStatus('synced');
          return null;
        }
        state.lastSync = val.updatedAt || Date.now();
        setStatus('synced');
        return val;
      })
      .catch(function (e) {
        setStatus(state.status === 'syncing' ? 'offline' : 'error', e.message);
        return null;
      });
  }

  // Push the local data envelope to the cloud
  function push(data) {
    const base = userPath();
    if (!base) return Promise.resolve(false);

    const envelope = {
      updatedAt: Date.now(),
      data: data
    };

    setStatus('syncing');
    return state.db.ref(base + '/' + DATA_PATH).set(envelope)
      .then(function () {
        state.lastSync = envelope.updatedAt;
        return state.db.ref(base + '/' + META_PATH).update({
          lastSync: envelope.updatedAt,
          device: navigator.userAgent.slice(0, 60)
        });
      })
      .then(function () {
        setStatus('synced');
        return true;
      })
      .catch(function (e) {
        setStatus('offline', e.message);
        return false;
      });
  }

  function onStatusChange(fn) {
    state.listeners.push(fn);
    try { fn(state); } catch (e) { /* ignore */ }
    return function () {
      const i = state.listeners.indexOf(fn);
      if (i >= 0) state.listeners.splice(i, 1);
    };
  }

  return {
    init: init,
    isConfigured: isConfigured,
    signInAnonymously: signInAnonymously,
    signInWithGoogle: signInWithGoogle,
    completeRedirectSignIn: completeRedirectSignIn,
    signOut: signOut,
    pull: pull,
    push: push,
    onStatusChange: onStatusChange,
    getState: function () { return state; },
    getUser: function () { return state.user; }
  };
})();
