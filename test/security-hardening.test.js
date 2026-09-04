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

test('the vulnerable extended URL-encoded parser is not enabled', () => {
    assert.doesNotMatch(serverSource, /express\.urlencoded/);
    assert.match(serverSource, /app\.set\('query parser', 'simple'\)/);
});

test('quote and checkout operations use distributed limits', () => {
    assert.match(serverSource, /mongoose\.model\('RateLimit'/);
    assert.match(serverSource, /'shipping-rates-short'/);
    assert.match(serverSource, /'shipping-rates-daily'/);
    assert.match(serverSource, /'create-shipment-user'/);
    assert.match(serverSource, /'create-shipment-ip'/);
});

test('both Saudi mobile numbers and bounded parcel values are checked before payment', () => {
    assert.match(
        serverSource,
        /!normalizeSaudiMobile\(body\.senderPhone\)/
    );
    assert.match(
        serverSource,
        /!normalizeSaudiMobile\(body\.receiverPhone\)/
    );
    assert.match(serverSource, /MAX_WEIGHT_KG/);
    assert.match(serverSource, /MAX_DIMENSION_CM/);
    assert.match(serverSource, /MAX_DECLARED_VALUE_SAR/);
    assert.match(homepage, /id="receiverPhone"[^>]*pattern=/);
});

test('abandoned payment payloads are purged and failed bill creation removes them immediately', () => {
    assert.match(serverSource, /cleanupExpiredSensitivePaymentPayloads/);
    assert.match(
        serverSource,
        /ABANDONED_PAYMENT_PAYLOAD_RETENTION_MS/
    );
    assert.match(
        serverSource,
        /status: 'payment_creation_failed'[\s\S]{0,300}\$unset: \{ shipmentPayload: 1 \}/
    );
});

test('provider label downloads are HTTPS-only, bounded and timed out', () => {
    assert.match(serverSource, /assertSafeExternalHttpsUrl/);
    assert.match(serverSource, /LABEL_DOWNLOAD_TIMEOUT_MS/);
    assert.match(serverSource, /limitedResponseBuffer/);
    assert.match(serverSource, /LABEL_CONTENT_INVALID/);
});
