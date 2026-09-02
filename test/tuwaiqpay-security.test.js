const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    liveTuwaiqPayPaymentUrl,
    normalizeSaudiMobile,
    secureTextEquals
} = require('../lib/tuwaiqpay-security');

const projectDir = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(
    path.join(projectDir, 'server.js'),
    'utf8'
);
const homepage = fs.readFileSync(
    path.join(projectDir, 'public', 'index.html'),
    'utf8'
);
const paymentPage = fs.readFileSync(
    path.join(projectDir, 'public', 'tuwaiq-payment.html'),
    'utf8'
);

test('Saudi mobile numbers are normalized for the Production API', () => {
    assert.equal(normalizeSaudiMobile('0501234567'), '+966501234567');
    assert.equal(normalizeSaudiMobile('501234567'), '+966501234567');
    assert.equal(normalizeSaudiMobile('+966 50 123 4567'), '+966501234567');
    assert.equal(normalizeSaudiMobile('050123456'), '');
});

test('webhook secrets require an exact non-empty match', () => {
    assert.equal(secureTextEquals('secret-value', 'secret-value'), true);
    assert.equal(secureTextEquals('secret-value', 'secret-Value'), false);
    assert.equal(secureTextEquals('', ''), false);
    assert.equal(secureTextEquals('short', 'longer'), false);
});

test('only known live HTTPS payment hosts are accepted', () => {
    for (const value of [
        'https://payment.tuwaiqpay.com.sa/pay/abc',
        'https://tuwaiqpay.com.sa/pay/abc',
        'https://hypbill.com/abc',
        'https://secure.hypbill.com/abc'
    ]) {
        assert.equal(liveTuwaiqPayPaymentUrl(value), true, value);
    }

    for (const value of [
        'http://payment.tuwaiqpay.com.sa/pay/abc',
        'https://dev-payment.tuwaiqpay.com.sa/pay/abc',
        'https://uat.tuwaiqpay.com.sa/pay/abc',
        'https://sandbox.hypbill.com/abc',
        'https://tuwaiqpay.com.sa.evil.example/pay/abc',
        'https://evil.example/pay/abc',
        'https://user:pass@payment.tuwaiqpay.com.sa/pay/abc',
        'https://payment.tuwaiqpay.com.sa:8443/pay/abc'
    ]) {
        assert.equal(liveTuwaiqPayPaymentUrl(value), false, value);
    }
});

test('the live API and webhook safety requirements are wired into the server', () => {
    assert.match(
        serverSource,
        /const TUWAIQPAY_BASE_URL\s*=\s*\r?\n\s*'https:\/\/onboarding-prod\.tuwaiqpay\.com\.sa';/
    );
    assert.match(serverSource, /TUWAIQPAY_WEBHOOK_HEADER_VALUE\.length >= 32/);
    assert.match(serverSource, /app\.post\('\/api\/webhooks\/tuwaiqpay-payment'/);
    assert.match(serverSource, /Math\.round\(paidAmount \* 100\)/);
    assert.match(serverSource, /currency !== 'SAR'/);
    assert.match(serverSource, /waitUntil\(fulfillmentPromise\)/);
});

test('the manual bank-transfer customer flow is removed', () => {
    assert.equal(
        fs.existsSync(path.join(projectDir, 'public', 'bank-transfer.html')),
        false
    );
    assert.equal(
        fs.existsSync(path.join(projectDir, 'public', 'admin-transfers.html')),
        false
    );
    assert.doesNotMatch(homepage, /bankTransferRequired|bankTransferUrl/);
    assert.match(homepage, /paymentRequired&&body\.paymentPageUrl/);
    assert.match(paymentPage, /دفع إلكتروني آمن عبر طويق باي/);
    assert.doesNotMatch(paymentPage, /index\.html\?account=login/);
});
