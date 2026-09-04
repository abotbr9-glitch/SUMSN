const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CURRENT_PASSWORD_VERSION,
    LEGACY_PASSWORD_VERSION,
    createPasswordRecord,
    passwordDigest,
    passwordMatches,
    passwordNeedsUpgrade
} = require('../lib/password-security');

test('new passwords use the stronger current scrypt settings', async () => {
    const record = await createPasswordRecord('correct horse battery staple');

    assert.equal(record.version, CURRENT_PASSWORD_VERSION);
    assert.equal(
        await passwordMatches(
            'correct horse battery staple',
            record.salt,
            record.hash,
            record.version
        ),
        true
    );
    assert.equal(
        await passwordMatches(
            'wrong password',
            record.salt,
            record.hash,
            record.version
        ),
        false
    );
});

test('legacy password hashes remain valid and are marked for upgrade', async () => {
    const salt = '00112233445566778899aabbccddeeff';
    const hash = await passwordDigest(
        'existing customer password',
        salt,
        LEGACY_PASSWORD_VERSION
    );

    assert.equal(
        await passwordMatches(
            'existing customer password',
            salt,
            hash,
            LEGACY_PASSWORD_VERSION
        ),
        true
    );
    assert.equal(passwordNeedsUpgrade(LEGACY_PASSWORD_VERSION), true);
    assert.equal(passwordNeedsUpgrade(CURRENT_PASSWORD_VERSION), false);
});
