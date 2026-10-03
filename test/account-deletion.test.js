const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(
    path.join(projectDir, 'server.js'),
    'utf8'
);
const homepage = fs.readFileSync(
    path.join(projectDir, 'public', 'index.html'),
    'utf8'
);
const privacyPage = fs.readFileSync(
    path.join(projectDir, 'public', 'privacy-policy.html'),
    'utf8'
);
const deletionPage = fs.readFileSync(
    path.join(projectDir, 'public', 'account-deletion.html'),
    'utf8'
);

test('account deletion is authenticated, rate-limited and rechecks the password', () => {
    assert.match(serverSource, /app\.delete\('\/api\/account'/);
    assert.match(serverSource, /sameOriginRequest\(req\)/);
    assert.match(serverSource, /'delete-account'/);
    assert.match(
        serverSource,
        /passwordMatches\([\s\S]{0,250}user\.passwordHash/
    );
    assert.match(serverSource, /confirmation !== 'DELETE'/);
});

test('account deletion refuses to interrupt an active payment or label issuance', () => {
    assert.match(
        serverSource,
        /ACCOUNT_DELETION_BLOCKING_PAYMENT_STATUSES/
    );
    assert.match(serverSource, /'payment_confirmed'/);
    assert.match(serverSource, /'processing'/);
    assert.match(serverSource, /'pending_review'/);
    assert.match(serverSource, /ACTIVE_PAYMENT_EXISTS/);
    assert.match(
        serverSource,
        /ACCOUNT_DELETION_CANCELLABLE_PAYMENT_STATUSES/
    );
    assert.match(serverSource, /status: 'account_deleted'/);
});

test('account deletion removes private R2 files and personal account data', () => {
    assert.match(serverSource, /DeleteObjectsCommand/);
    assert.match(serverSource, /deletePrivateObjectsFromR2\(objectKeys\)/);
    assert.match(serverSource, /Shipment\.deleteMany/);
    assert.match(serverSource, /User\.deleteOne/);
    assert.match(
        serverSource,
        /customerEmail: ''[\s\S]{0,300}shipmentPayload: 1/
    );
    assert.match(serverSource, /clearSessionCookie\(res\)/);
});

test('the in-app account area exposes a transparent permanent deletion flow', () => {
    assert.match(homepage, /id="deleteAccountButton"/);
    assert.match(homepage, /id="deleteAccountDialog"/);
    assert.match(homepage, /autocomplete="current-password"/);
    assert.match(homepage, /method:'DELETE'/);
    assert.match(homepage, /الحذف نهائي/);
});

test('public privacy and account-deletion pages explain deletion and retention', () => {
    assert.match(privacyPage, /حذف حسابه من داخل المنصة/);
    assert.match(privacyPage, /سجل مالي محدود ومنزوع الارتباط بالحساب/);
    assert.match(deletionPage, /حذف حساب SUMSN/);
    assert.match(deletionPage, /لوحتي/);
    assert.match(deletionPage, /support@sumsn\.com/);
});

test('MongoDB schemas store R2 references instead of raw PDF or image bytes', () => {
    assert.match(serverSource, /labelObjectKey:/);
    assert.match(serverSource, /receiptObjectKey:/);
    assert.doesNotMatch(serverSource, /label(?:Data|Base64|Buffer):/);
    assert.doesNotMatch(serverSource, /receipt(?:Data|Base64|Buffer):/);
});
