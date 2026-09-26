'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    SUMSN_MARKUP,
    customerPrice,
    excessWeightFee
} = require('../lib/shipping-pricing');

test('adds a fixed seven-riyal SUMSN markup to every label', () => {
    assert.equal(SUMSN_MARKUP, 7);
    assert.equal(customerPrice(14, 10), 21);
});

test('charges one riyal per kilogram above 10 kg through 15 kg', () => {
    assert.equal(excessWeightFee(10), 0);
    assert.equal(excessWeightFee(11), 1);
    assert.equal(excessWeightFee(12), 2);
    assert.equal(excessWeightFee(15), 5);
    assert.equal(customerPrice(14, 12), 23);
    assert.equal(customerPrice(14, 15), 26);
});

test('charges two riyals per kilogram above 15 kg in addition to the first tier', () => {
    assert.equal(excessWeightFee(16), 7);
    assert.equal(excessWeightFee(20), 15);
    assert.equal(customerPrice(14, 16), 28);
    assert.equal(customerPrice(14, 20), 36);
});

test('preserves fractional kilograms and rounds the final price to two decimals', () => {
    assert.equal(excessWeightFee(10.5), 0.5);
    assert.equal(excessWeightFee(15.5), 6);
    assert.equal(customerPrice(14.239, 15.5), 27.24);
});

test('does not add a weight fee at or below 10 kg', () => {
    assert.equal(excessWeightFee(0), 0);
    assert.equal(excessWeightFee(5), 0);
    assert.equal(excessWeightFee(9.99), 0);
});
