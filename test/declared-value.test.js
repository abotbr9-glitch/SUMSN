const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const pageSource = fs.readFileSync(
    path.join(projectRoot, 'public', 'index.html'),
    'utf8'
);
const serverSource = fs.readFileSync(
    path.join(projectRoot, 'server.js'),
    'utf8'
);

test('declared parcel value is required and sent with shipment details', () => {
    assert.match(
        pageSource,
        /name="declaredValue"[^>]*min="1"[^>]*step="0\.01"[^>]*required/
    );
    assert.match(
        pageSource,
        /declaredValue:Number\(fd\.declaredValue\)/
    );
    assert.match(
        pageSource,
        /declaredValue:lastQuote\.declaredValue/
    );
});

test('server validates the declared value before payment', () => {
    assert.match(serverSource, /'declaredValue'/);
    assert.match(
        serverSource,
        /declaredValue: roundMoney\(req\.body\.declaredValue\)/
    );
    assert.match(
        serverSource,
        /validPositiveNumber\(\s*body\.declaredValue,\s*MAX_DECLARED_VALUE_SAR\s*\)/
    );
    assert.match(
        serverSource,
        /body\.declaredValue > maxOrderValue/
    );
});

test('OTO order receives parcel value separately from shipping price', () => {
    assert.match(
        serverSource,
        /const declaredValue = roundMoney\(body\.declaredValue\)/
    );
    assert.match(serverSource, /amount: declaredValue/);
    assert.match(serverSource, /subtotal: declaredValue/);
    assert.match(serverSource, /customsValue: String\(declaredValue\)/);
    assert.match(serverSource, /shippingAmount: payment\.providerCost/);
});
