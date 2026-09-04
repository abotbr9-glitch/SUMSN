const crypto = require('node:crypto');

const LEGACY_PASSWORD_VERSION = 1;
const CURRENT_PASSWORD_VERSION = 2;

const PASSWORD_PARAMETERS = {
    [LEGACY_PASSWORD_VERSION]: {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
    },
    [CURRENT_PASSWORD_VERSION]: {
        N: 32768,
        r: 8,
        p: 3,
        maxmem: 64 * 1024 * 1024
    }
};

function normalizedPasswordVersion(value) {
    const version = Number(value);

    return PASSWORD_PARAMETERS[version]
        ? version
        : LEGACY_PASSWORD_VERSION;
}

function passwordDigest(password, salt, version = CURRENT_PASSWORD_VERSION) {
    const parameters = PASSWORD_PARAMETERS[
        normalizedPasswordVersion(version)
    ];

    return new Promise((resolve, reject) => {
        crypto.scrypt(
            String(password),
            String(salt),
            64,
            parameters,
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(derivedKey.toString('hex'));
            }
        );
    });
}

async function createPasswordRecord(password) {
    const salt = crypto.randomBytes(16).toString('hex');

    return {
        salt,
        hash: await passwordDigest(
            password,
            salt,
            CURRENT_PASSWORD_VERSION
        ),
        version: CURRENT_PASSWORD_VERSION
    };
}

async function passwordMatches(
    password,
    salt,
    expectedHash,
    version = LEGACY_PASSWORD_VERSION
) {
    const actualHash = await passwordDigest(
        password,
        salt,
        version
    );
    const actual = Buffer.from(actualHash, 'hex');
    const expected = Buffer.from(String(expectedHash || ''), 'hex');

    return (
        actual.length === expected.length &&
        actual.length > 0 &&
        crypto.timingSafeEqual(actual, expected)
    );
}

function passwordNeedsUpgrade(version) {
    return normalizedPasswordVersion(version) < CURRENT_PASSWORD_VERSION;
}

module.exports = {
    CURRENT_PASSWORD_VERSION,
    LEGACY_PASSWORD_VERSION,
    createPasswordRecord,
    passwordDigest,
    passwordMatches,
    passwordNeedsUpgrade
};
