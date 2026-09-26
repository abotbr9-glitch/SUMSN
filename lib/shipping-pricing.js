'use strict';

const SUMSN_MARKUP = 7;
const FIRST_TIER_START_KG = 10;
const SECOND_TIER_START_KG = 15;
const FIRST_TIER_PRICE_PER_KG = 1;
const SECOND_TIER_PRICE_PER_KG = 2;

function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
    return Number(finiteNumber(value).toFixed(2));
}

function excessWeightFee(weight) {
    const shipmentWeight = Math.max(0, finiteNumber(weight));

    // من 10 إلى 15 كجم: ريال لكل كجم زائد. بعد 15 كجم: ريالان لكل كجم زائد.
    // نحافظ على الأجزاء العشرية من الوزن كما كان يفعل التسعير السابق.
    const firstTierKilograms = Math.min(
        Math.max(shipmentWeight - FIRST_TIER_START_KG, 0),
        SECOND_TIER_START_KG - FIRST_TIER_START_KG
    );
    const secondTierKilograms = Math.max(
        shipmentWeight - SECOND_TIER_START_KG,
        0
    );

    return roundMoney(
        (firstTierKilograms * FIRST_TIER_PRICE_PER_KG) +
        (secondTierKilograms * SECOND_TIER_PRICE_PER_KG)
    );
}

function customerPrice(providerPrice, weight) {
    return roundMoney(
        finiteNumber(providerPrice) +
        SUMSN_MARKUP +
        excessWeightFee(weight)
    );
}

module.exports = {
    FIRST_TIER_PRICE_PER_KG,
    FIRST_TIER_START_KG,
    SECOND_TIER_PRICE_PER_KG,
    SECOND_TIER_START_KG,
    SUMSN_MARKUP,
    customerPrice,
    excessWeightFee
};
