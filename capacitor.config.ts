import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sumsn.shipping",
  appName: "SUMSN",
  webDir: "native-shell",
  appendUserAgent: " SUMSN-Native/1.0",
  backgroundColor: "#f7faff",
  loggingBehavior: "production",
  server: {
    // SUMSN is a live transactional service. The hosted application remains
    // the single source of truth for quotes, customer accounts, OTO orders,
    // TuwaiqPay payments, and private shipping labels. Capacitor injects the
    // native bridge into this secured WKWebView for iOS-only utilities.
    url: "https://sumsn.com",
    androidScheme: "https",
    cleartext: false,
    errorPath: "offline.html",
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: false,
    buildOptions: {
      signingStyle: "automatic",
      exportMethod: "app-store-connect",
    },
  },
};

export default config;
