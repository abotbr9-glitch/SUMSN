const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(projectDir, ...parts), 'utf8');

const packageJson = JSON.parse(read('package.json'));
const capacitorConfig = read('capacitor.config.ts');
const homepage = read('public', 'index.html');
const paymentPage = read('public', 'tuwaiq-payment.html');
const nativeBridge = read('public', 'native-app.js');
const infoPlist = read('ios', 'App', 'App', 'Info.plist');
const privacyManifest = read('ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
const nativePlugin = read('ios', 'App', 'App', 'SumsnNativePlugin.swift');
const xcodeProject = read('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const reviewNotes = read('docs', 'APP_STORE_REVIEW_NOTES_EN.txt');

test('the project has a reproducible Capacitor iOS shell for SUMSN', () => {
    assert.equal(packageJson.engines.node, '24.x');
    assert.ok(packageJson.dependencies['@capacitor/core']);
    assert.ok(packageJson.dependencies['@capacitor/ios']);
    assert.ok(packageJson.devDependencies['@capacitor/cli']);
    assert.equal(packageJson.scripts['native:sync'], 'cap sync ios');
    assert.match(capacitorConfig, /appId:\s*["']com\.sumsn\.shipping["']/);
    assert.match(capacitorConfig, /appName:\s*["']SUMSN["']/);
    assert.match(capacitorConfig, /url:\s*["']https:\/\/sumsn\.com["']/);
    assert.match(capacitorConfig, /cleartext:\s*false/);
});

test('the web experience exposes install metadata and native-only enhancements', () => {
    assert.match(homepage, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(homepage, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.match(homepage, /src="\/native-app\.js"/);
    assert.match(paymentPage, /src="\/native-app\.js"/);
    assert.match(nativeBridge, /shareShippingLabel/);
    assert.match(nativeBridge, /فتح الدفع الآمن/);
    assert.match(nativeBridge, /مشاركة أو طباعة البوليصة/);
});

test('native payment remains limited to approved live HTTPS TuwaiqPay hosts', () => {
    assert.match(nativePlugin, /components\.scheme\?\.lowercased\(\) == "https"/);
    assert.match(nativePlugin, /components\.user == nil/);
    assert.match(nativePlugin, /components\.password == nil/);
    assert.match(nativePlugin, /tuwaiqpay\.com\.sa/);
    assert.match(nativePlugin, /hypbill\.com/);
    assert.match(nativePlugin, /dev\|uat\|test\|sandbox/);
    assert.doesNotMatch(nativePlugin, /StoreKit/);
    assert.doesNotMatch(nativeBridge, /In-App Purchase/i);
});

test('shipping labels use a bounded native PDF share and print flow', () => {
    assert.match(nativeBridge, /25 \* 1024 \* 1024/);
    assert.match(nativeBridge, /credentials:\s*"same-origin"/);
    assert.match(nativeBridge, /Accept:\s*"application\/pdf"/);
    assert.match(nativePlugin, /data\.starts\(with:\s*Data\("%PDF"\.utf8\)\)/);
    assert.match(nativePlugin, /\.completeFileProtection/);
    assert.match(nativePlugin, /UIActivityViewController/);
    assert.match(nativePlugin, /removeItem\(at:\s*fileURL\)/);
});

test('the iOS target includes the custom bridge and Apple privacy manifest', () => {
    assert.match(xcodeProject, /MainViewController\.swift in Sources/);
    assert.match(xcodeProject, /SumsnNativePlugin\.swift in Sources/);
    assert.match(xcodeProject, /PrivacyInfo\.xcprivacy in Resources/);
    assert.match(infoPlist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.match(privacyManifest, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    assert.match(privacyManifest, /NSPrivacyCollectedDataTypeEmailAddress/);
    assert.match(privacyManifest, /NSPrivacyCollectedDataTypePhysicalAddress/);
    assert.match(privacyManifest, /NSPrivacyCollectedDataTypePurchaseHistory/);
});

test('review notes explain the physical-service payment classification', () => {
    assert.match(reviewNotes, /real-world shipping label/);
    assert.match(reviewNotes, /3\.1\.3\(e\)/);
    assert.match(reviewNotes, /No digital entitlement is unlocked/);
    assert.match(reviewNotes, /Delete account/i);
    assert.match(reviewNotes, /\[REPLACE WITH VERIFIED REVIEW ACCOUNT EMAIL\]/);
});
