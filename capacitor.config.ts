import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bhfinance.app',
  appName: 'BH',
  webDir: 'www',
  // The app is served from GitHub Pages — the native shell loads the same URL,
  // so every push to GitHub shows up in the app immediately.
  server: {
    url: 'https://mhmoudmohmed269-cmd.github.io/-bh/',
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#04060A',
    webContentsDebuggingEnabled: false
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#04060A',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#04060A',
      overlaysWebView: false
    },
    LocalNotifications: {
      smallIcon: 'ic_notification_icon',
      iconColor: '#00D9FF'
    }
  }
};

export default config;
