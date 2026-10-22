/* ============================================================
   BH — Native Bridge  (Capacitor)
   --------------------------------------------------------
   Runs ONLY inside the native Android app. In a normal browser
   every function here is a safe no-op, so the same code works
   everywhere without changes.

   Capabilities used:
     • SplashScreen  — native splash, hidden when the app is ready
     • StatusBar     — dark status bar matching the app theme
     • Haptics       — vibration on save / delete / warning
     • Share         — native share sheet
     • LocalNotifications — reliable scheduled notifications
     • App           — back button + deep links
     • Browser       — open external links in the real browser
   ============================================================ */

window.BHNative = (function () {
  'use strict';

  const isNative = (function () {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  })();

  // Lazily grab a plugin — returns null when not running natively
  function plugin(name) {
    if (!isNative) return null;
    try {
      const cap = window.Capacitor;
      if (!cap || !cap.Plugins) return null;
      return cap.Plugins[name] || null;
    } catch (e) { return null; }
  }

  const Haptics = {
    light() { const p = plugin('Haptics'); if (p) { try { p.impact({ style: 'LIGHT' }); } catch (e) {} } },
    medium() { const p = plugin('Haptics'); if (p) { try { p.impact({ style: 'MEDIUM' }); } catch (e) {} } },
    heavy() { const p = plugin('Haptics'); if (p) { try { p.impact({ style: 'HEAVY' }); } catch (e) {} } },
    success() { const p = plugin('Haptics'); if (p) { try { p.notification({ type: 'SUCCESS' }); } catch (e) {} } },
    warning() { const p = plugin('Haptics'); if (p) { try { p.notification({ type: 'WARNING' }); } catch (e) {} } },
    error() { const p = plugin('Haptics'); if (p) { try { p.notification({ type: 'ERROR' }); } catch (e) {} } }
  };

  const Splash = {
    hide() {
      const p = plugin('SplashScreen');
      if (p) { try { p.hide({ fadeOutDuration: 250 }); } catch (e) {} }
    }
  };

  const StatusBar = {
    setup() {
      const p = plugin('StatusBar');
      if (!p) return;
      try {
        p.setStyle({ style: 'DARK' });
        p.setBackgroundColor({ color: '#04060A' });
      } catch (e) { /* ignore */ }
    },
    setDark(dark) {
      const p = plugin('StatusBar');
      if (p) { try { p.setStyle({ style: dark ? 'DARK' : 'LIGHT' }); } catch (e) {} }
    }
  };

  const Share = {
    // Opens the native share sheet. Falls back to the Web Share API.
    async share({ title, text, url }) {
      const p = plugin('Share');
      if (p) {
        try {
          await p.share({ title: title, text: text, url: url, dialogTitle: title });
          return true;
        } catch (e) { /* user cancelled */ }
        return false;
      }
      try {
        if (navigator.share) {
          await navigator.share({ title, text, url });
          return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    }
  };

  const Notifications = {
    // Schedule a local notification (works even when the app is closed)
    async schedule(id, title, body, whenMs) {
      const p = plugin('LocalNotifications');
      if (!p) return false;
      try {
        await p.schedule({
          notifications: [{
            id: id,
            title: title,
            body: body,
            schedule: { at: new Date(whenMs), allowWhileIdle: true }
          }]
        });
        return true;
      } catch (e) { return false; }
    },
    async cancelAll() {
      const p = plugin('LocalNotifications');
      if (p) { try { await p.cancelAll(); } catch (e) {} }
    },
    async requestPermission() {
      const p = plugin('LocalNotifications');
      if (!p) return false;
      try {
        const res = await p.checkPermissions();
        if (res.display === 'granted') return true;
        const req = await p.requestPermissions();
        return req.display === 'granted';
      } catch (e) { return false; }
    }
  };

  const App = {
    // The Android back button — go back inside the app before closing it
    onBackButton(handler) {
      const p = plugin('App');
      if (!p) return;
      try {
        p.addListener('backButton', () => { handler(); });
      } catch (e) { /* ignore */ }
    },
    // Called when the app comes back to the foreground
    onResume(handler) {
      const p = plugin('App');
      if (!p) return;
      try {
        p.addListener('appStateChange', ({ isActive }) => {
          if (isActive) handler();
        });
      } catch (e) { /* ignore */ }
    },
    async exit() {
      const p = plugin('App');
      if (p) { try { await p.exitApp(); } catch (e) {} }
    }
  };

  const Browser = {
    async open(url) {
      const p = plugin('Browser');
      if (p) { try { await p.open({ url }); return true; } catch (e) {} }
      window.open(url, '_blank', 'noopener');
      return true;
    }
  };

  const Preferences = {
    async get(key) {
      const p = plugin('Preferences');
      if (!p) return null;
      try { const r = await p.get({ key }); return r.value; } catch (e) { return null; }
    },
    async set(key, value) {
      const p = plugin('Preferences');
      if (!p) return false;
      try { await p.set({ key, value: String(value) }); return true; } catch (e) { return false; }
    }
  };

  // Set everything up once
  function init() {
    if (!isNative) return false;

    // Mark the body so the CSS can apply native-only adjustments
    document.body.classList.add('capacitor-native');

    StatusBar.setup();

    // Hide the native splash as soon as the web app is painted
    const hide = () => Splash.hide();
    if (document.readyState === 'complete') setTimeout(hide, 60);
    else window.addEventListener('load', () => setTimeout(hide, 60));

    // Ask for notification permission once
    setTimeout(() => { Notifications.requestPermission(); }, 2500);

    return true;
  }

  return {
    isNative: isNative,
    init: init,
    Haptics: Haptics,
    Splash: Splash,
    StatusBar: StatusBar,
    Share: Share,
    Notifications: Notifications,
    App: App,
    Browser: Browser,
    Preferences: Preferences
  };
})();
