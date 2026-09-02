const crypto = require('node:crypto');

function normalizeSaudiMobile(value) {
    const digits = String(value || '').replace(/\D/g, '');

    if (/^05\d{8}$/.test(digits)) {
        return `+966${digits.slice(1)}`;
    }

    if (/^5\d{8}$/.test(digits)) {
        return `+966${digits}`;
    }

    if (/^9665\d{8}$/.test(digits)) {
        return `+${digits}`;
    }

    return '';
}

function secureTextEquals(actual, expected) {
    const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
    const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');

    return (
        actualBuffer.length === expectedBuffer.length &&
        actualBuffer.length > 0 &&
        crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    );
}

function tuwaiqPayPaymentCompleted(billStatus, transactionStatus) {
    const normalizedBillStatus =
        String(billStatus || '').trim().toUpperCase();
    const normalizedTransactionStatus =
        String(transactionStatus || '').trim().toUpperCase();

    return (
        normalizedBillStatus === 'PAID' ||
        ['PAID', 'PENDING_SETTLEMENT'].includes(
            normalizedTransactionStatus
        )
    );
}

function recognizedPaymentHost(hostname) {
    return (
        hostname === 'tuwaiqpay.com.sa' ||
        hostname.endsWith('.tuwaiqpay.com.sa') ||
        hostname === 'hypbill.com' ||
        hostname.endsWith('.hypbill.com')
    );
}

function liveTuwaiqPayPaymentUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        const hostname = url.hostname.toLowerCase();
        const forbiddenEnvironment =
            /(^|[.-])(dev|uat|test|sandbox)([.-]|$)/i.test(hostname);

        return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            (!url.port || url.port === '443') &&
            recognizedPaymentHost(hostname) &&
            !forbiddenEnvironment
        );
    } catch {
        return false;
    }
}

module.exports = {
    liveTuwaiqPayPaymentUrl,
    normalizeSaudiMobile,
    secureTextEquals,
    tuwaiqPayPaymentCompleted
};
