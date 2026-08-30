const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const crypto = require('crypto');
const path = require('node:path');
const {
    GetObjectCommand,
    PutObjectCommand,
    S3Client
} = require('@aws-sdk/client-s3');

dotenv.config();

const app = express();

app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: true, limit: '7mb' }));

// Vercel applies the equivalent rules at the CDN through vercel.json.
// Keep local Express routing consistent and preserve account/reset links.
app.get('/index.html', (req, res) => {
    const queryStart = req.originalUrl.indexOf('?');
    const query = queryStart === -1 ? '' : req.originalUrl.slice(queryStart);
    res.redirect(308, `/${query}`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

/*
|--------------------------------------------------------------------------
| إعدادات النظام
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3000;

const MONGO_URI =
    process.env.MONGO_URI ||
    'mongodb://127.0.0.1:27017/sumsn_db';

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_SMTP_HOST = String(process.env.EMAIL_SMTP_HOST || '').trim();
const EMAIL_SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT || 465);
const EMAIL_SMTP_SECURE =
    process.env.EMAIL_SMTP_SECURE !== 'false';

const SUPPORT_EMAIL =
    String(process.env.SUPPORT_EMAIL || 'support@sumsn.com')
        .trim()
        .toLowerCase();
const EMAIL_FROM =
    String(process.env.EMAIL_FROM || SUPPORT_EMAIL)
        .trim()
        .toLowerCase();
const RESEND_API_KEY =
    String(process.env.RESEND_API_KEY || '').trim();
const PUBLIC_BASE_URL =
    String(process.env.PUBLIC_BASE_URL || 'https://sumsn.com')
        .trim()
        .replace(/\/$/, '');
const AUTH_SECRET =
    String(process.env.AUTH_SECRET || '').trim();
const ENABLE_CUSTOMER_ACCOUNTS =
    process.env.ENABLE_CUSTOMER_ACCOUNTS === 'true';
const SESSION_COOKIE_NAME = 'sumsn_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_LOG_RETENTION_DAYS = 90;
const MONGO_STORAGE_LIMIT_BYTES =
    Number(process.env.MONGO_STORAGE_LIMIT_MB || 512) *
    1024 *
    1024;

/*
|--------------------------------------------------------------------------
| مزود الشحن - داخلي فقط
|--------------------------------------------------------------------------
*/

const SHIPPING_REFRESH_TOKEN =
    process.env.OTO_REFRESH_TOKEN ||
    process.env.OTO_API_KEY;

const SHIPPING_BASE_URL =
    'https://api.tryoto.com/rest/v2';

/*
|--------------------------------------------------------------------------
| تسعير SUMSN
|--------------------------------------------------------------------------
*/

// التسعير ثابت هنا حتى لا تتغلب عليه قيم قديمة محفوظة في Vercel.
// حتى 17 كجم: سعر الشركة + 4 ريالات.
// فوق 17 كجم: يضاف 3 ريالات لكل كيلوجرام زائد عن 17.
const SUMSN_MARKUP = 4;
const INCLUDED_WEIGHT_KG = 17;
const EXTRA_KG_PRICE = 3;

// معطل افتراضيًا، ولا يعمل إلا عند تفعيل المفتاح صراحةً في بيئة الاستضافة.
const ALLOW_LIVE_SHIPMENTS =
    process.env.ALLOW_LIVE_SHIPMENTS === 'true';

const LIVE_SHIPMENT_TEST_EMAIL =
    String(process.env.LIVE_SHIPMENT_TEST_EMAIL || '')
        .trim()
        .toLowerCase();

/*
|--------------------------------------------------------------------------
| تخزين بوالص الشحن في Cloudflare R2 - خاص وغير متاح للعامة
|--------------------------------------------------------------------------
*/

const R2_ACCESS_KEY_ID =
    String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY =
    String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_ACCOUNT_ID =
    String(process.env.R2_ACCOUNT_ID || '').trim();
const R2_BUCKET_NAME =
    String(process.env.R2_BUCKET_NAME || '').trim();
const MAX_LABEL_BYTES = 25 * 1024 * 1024;

/*
|--------------------------------------------------------------------------
| التحويل البنكي اليدوي - البيانات الحساسة تبقى في الخادم فقط
|--------------------------------------------------------------------------
*/

const BANK_TRANSFER_BANK_NAME =
    String(process.env.BANK_TRANSFER_BANK_NAME || '').trim();
const BANK_TRANSFER_BENEFICIARY_NAME =
    String(process.env.BANK_TRANSFER_BENEFICIARY_NAME || '').trim();
const BANK_TRANSFER_IBAN =
    String(process.env.BANK_TRANSFER_IBAN || '')
        .replace(/\s+/g, '')
        .toUpperCase();
const BANK_TRANSFER_ADMIN_EMAIL =
    String(process.env.BANK_TRANSFER_ADMIN_EMAIL || '')
        .trim()
        .toLowerCase();
const MAX_RECEIPT_BYTES =
    Number(process.env.MAX_RECEIPT_MB || 5) * 1024 * 1024;
const BANK_TRANSFER_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const SHIPPING_RECONCILIATION_GRACE_MS = 10 * 60 * 1000;

let shippingAccessToken = '';
let shippingAccessTokenExpiresAt = 0;
let mongoConnectionPromise = null;
let r2Client = null;

/*
|--------------------------------------------------------------------------
| MongoDB
|--------------------------------------------------------------------------
*/

async function connectToDatabase() {
    if (mongoose.connection.readyState === 1) {
        return mongoose.connection;
    }

    if (!mongoConnectionPromise) {
        mongoConnectionPromise = mongoose
            .connect(MONGO_URI, {
                serverSelectionTimeoutMS: 15000,
                autoIndex: true
            })
            .then((connection) => {
                console.log('تم الاتصال بقاعدة بيانات MongoDB بنجاح');
                return connection;
            })
            .catch((error) => {
                mongoConnectionPromise = null;
                console.error('خطأ في الاتصال بقاعدة MongoDB:', error);
                throw error;
            });
    }

    return mongoConnectionPromise;
}

/*
|--------------------------------------------------------------------------
| نموذج الشحنات الفعلية
|--------------------------------------------------------------------------
*/

const shipmentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
        default: null
    },
    customerEmail: {
        type: String,
        lowercase: true,
        trim: true,
        default: ''
    },
    contentsDescription: {
        type: String,
        default: ''
    },
    emailDeliveryStatus: {
        type: String,
        enum: ['pending', 'sent', 'failed', 'skipped'],
        default: 'pending'
    },
    emailMessageId: {
        type: String,
        default: ''
    },
    emailSentAt: Date,
    fromCity: {
        type: String,
        required: true
    },
    toCity: {
        type: String,
        required: true
    },
    weight: {
        type: Number,
        required: true
    },
    carrier: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    deliveryTime: {
        type: String,
        default: ''
    },
    otoOrderId: {
        type: String,
        index: true
    },
    otoShipmentId: String,
    trackingNumber: String,
    labelUrl: String,
    labelObjectKey: {
        type: String,
        default: ''
    },
    labelContentType: {
        type: String,
        default: 'application/pdf'
    },
    labelSize: {
        type: Number,
        default: 0
    },
    labelStoredAt: Date,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Shipment =
    mongoose.models.Shipment ||
    mongoose.model('Shipment', shipmentSchema);

/*
|--------------------------------------------------------------------------
| طلبات التحويل البنكي
|--------------------------------------------------------------------------
*/

const paymentSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true,
            default: null
        },
        customerEmail: {
            type: String,
            lowercase: true,
            trim: true,
            default: ''
        },
        requestId: {
            type: String,
            default: ''
        },
        orderNumber: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        status: {
            type: String,
            default: 'awaiting_transfer',
            index: true
        },
        amount: {
            type: Number,
            required: true
        },
        providerCost: {
            type: Number,
            required: true
        },
        carrier: {
            type: String,
            required: true
        },
        deliveryOptionId: {
            type: String,
            required: true
        },
        deliveryTime: {
            type: String,
            default: ''
        },
        shipmentPayload: {
            type: mongoose.Schema.Types.Mixed,
            select: false,
            default: null
        },
        shipmentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Shipment',
            default: null
        },
        paymentMethod: {
            type: String,
            default: 'bank_transfer'
        },
        receiptObjectKey: {
            type: String,
            default: ''
        },
        receiptContentType: {
            type: String,
            default: ''
        },
        receiptSize: {
            type: Number,
            default: 0
        },
        receiptUploadedAt: Date,
        submittedAt: Date,
        reviewedAt: Date,
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        reviewNote: {
            type: String,
            default: ''
        },
        issuanceAttempts: {
            type: Number,
            default: 0
        },
        lastIssuanceAt: Date,
        providerOrderCreatedAt: Date,
        providerShipmentRequestedAt: Date,
        providerShipmentCreatedAt: Date,
        providerShipmentId: {
            type: String,
            default: ''
        },
        providerTrackingNumber: {
            type: String,
            default: ''
        },
        providerLabelUrl: {
            type: String,
            default: ''
        },
        paidAt: Date,
        fulfilledAt: Date,
        failureReason: {
            type: String,
            default: ''
        }
    },
    {
        timestamps: true
    }
);

const Payment =
    mongoose.models.Payment ||
    mongoose.model('Payment', paymentSchema);

/*
|--------------------------------------------------------------------------
| سجل عمليات الاستعلام - هذا هو المهم للعدادات
|--------------------------------------------------------------------------
*/

const searchLogSchema = new mongoose.Schema({
    fromCity: {
        type: String,
        required: true
    },
    toCity: {
        type: String,
        required: true
    },
    weight: {
        type: Number,
        required: true
    },
    boxLength: {
        type: Number,
        required: true
    },
    boxWidth: {
        type: Number,
        required: true
    },
    boxHeight: {
        type: Number,
        required: true
    },
    prices: [
        {
            carrier: String,
            price: Number,
            deliveryTime: String
        }
    ],
    createdAt: {
        type: Date,
        default: Date.now,
        expires: SEARCH_LOG_RETENTION_DAYS * 24 * 60 * 60
    }
});

const SearchLog =
    mongoose.models.SearchLog ||
    mongoose.model('SearchLog', searchLogSchema);

const userSchema = new mongoose.Schema(
    {
        fullName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80
        },
        email: {
            type: String,
            required: true,
            unique: true,
            index: true,
            lowercase: true,
            trim: true
        },
        passwordSalt: {
            type: String,
            required: true,
            select: false
        },
        passwordHash: {
            type: String,
            required: true,
            select: false
        },
        emailVerifiedAt: {
            type: Date,
            default: null
        },
        verificationTokenHash: {
            type: String,
            select: false,
            default: ''
        },
        verificationTokenExpiresAt: {
            type: Date,
            select: false,
            default: null
        },
        resetTokenHash: {
            type: String,
            select: false,
            default: ''
        },
        resetTokenExpiresAt: {
            type: Date,
            select: false,
            default: null
        },
        sessionVersion: {
            type: Number,
            default: 0
        }
    },
    {
        timestamps: true
    }
);

const User =
    mongoose.models.User ||
    mongoose.model('User', userSchema);

const platformStatSchema = new mongoose.Schema({
    _id: {
        type: String,
        default: 'global'
    },
    totalOperations: {
        type: Number,
        default: 0
    },
    priceSum: {
        type: Number,
        default: 0
    },
    priceCount: {
        type: Number,
        default: 0
    },
    maxCost: {
        type: Number,
        default: 0
    },
    lastStorageAlertAt: Date,
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const PlatformStat =
    mongoose.models.PlatformStat ||
    mongoose.model('PlatformStat', platformStatSchema);

/*
|--------------------------------------------------------------------------
| البريد
|--------------------------------------------------------------------------
*/

const transporter =
    EMAIL_USER && EMAIL_PASS
        ? nodemailer.createTransport(
            EMAIL_SMTP_HOST
                ? {
                    host: EMAIL_SMTP_HOST,
                    port: EMAIL_SMTP_PORT,
                    secure: EMAIL_SMTP_SECURE,
                    auth: {
                        user: EMAIL_USER,
                        pass: EMAIL_PASS
                    }
                }
                : {
                    service: 'gmail',
                    auth: {
                        user: EMAIL_USER,
                        pass: EMAIL_PASS
                    }
                }
        )
        : null;

/*
|--------------------------------------------------------------------------
| أدوات مساعدة
|--------------------------------------------------------------------------
*/

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
    return Number(number(value).toFixed(2));
}

function excessWeightFee(weight) {
    return Math.max(
        0,
        number(weight) - INCLUDED_WEIGHT_KG
    ) * EXTRA_KG_PRICE;
}

function customerPrice(providerPrice, weight) {
    return roundMoney(
        number(providerPrice) +
        SUMSN_MARKUP +
        excessWeightFee(weight)
    );
}

function cleanPublicText(value) {
    if (!value) {
        return '';
    }

    return String(value)
        .replace(/OTO/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}


function customerAccountsEnabled() {
    return ENABLE_CUSTOMER_ACCOUNTS && Boolean(AUTH_SECRET);
}

function emailServiceConfigured() {
    return Boolean(RESEND_API_KEY || transporter);
}

function r2StorageConfigured() {
    return Boolean(
        R2_ACCESS_KEY_ID &&
        R2_SECRET_ACCESS_KEY &&
        R2_ACCOUNT_ID &&
        R2_BUCKET_NAME
    );
}

function bankTransferConfigured() {
    return Boolean(
        BANK_TRANSFER_BANK_NAME &&
        BANK_TRANSFER_BENEFICIARY_NAME &&
        /^SA\d{22}$/.test(BANK_TRANSFER_IBAN) &&
        validEmail(BANK_TRANSFER_ADMIN_EMAIL) &&
        r2StorageConfigured()
    );
}

function isBankTransferAdmin(user) {
    return Boolean(
        user &&
        validEmail(BANK_TRANSFER_ADMIN_EMAIL) &&
        normalizeEmail(user.email) === BANK_TRANSFER_ADMIN_EMAIL
    );
}

function formatIban(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .replace(/(.{4})/g, '$1 ')
        .trim();
}

function sameOriginRequest(req) {
    const origin = String(req.headers.origin || '').trim();

    if (!origin) {
        return true;
    }

    try {
        return new URL(origin).origin === new URL(PUBLIC_BASE_URL).origin;
    } catch {
        return false;
    }
}

function r2StorageClient() {
    if (!r2StorageConfigured()) {
        throw new Error('R2_CONFIGURATION_ERROR');
    }

    if (!r2Client) {
        r2Client = new S3Client({
            region: 'auto',
            endpoint:
                `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            forcePathStyle: true,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY
            }
        });
    }

    return r2Client;
}

function shipmentLabelObjectKey(userId, orderId) {
    const owner = String(userId || 'unassigned')
        .replace(/[^a-zA-Z0-9_-]/g, '');
    const order = String(orderId || 'shipment')
        .replace(/[^a-zA-Z0-9_-]/g, '');

    return `shipment-labels/${owner}/${order}.pdf`;
}

function transferReceiptObjectKey(userId, orderId, extension) {
    const owner = String(userId || 'unassigned')
        .replace(/[^a-zA-Z0-9_-]/g, '');
    const order = String(orderId || 'transfer')
        .replace(/[^a-zA-Z0-9_-]/g, '');
    const safeExtension = String(extension || 'bin')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();

    return `bank-transfer-receipts/${owner}/${order}.${safeExtension}`;
}

function parseReceiptDataUrl(value) {
    const match = String(value || '').match(
        /^data:(application\/pdf|image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/
    );

    if (!match) {
        throw new Error('RECEIPT_TYPE_INVALID');
    }

    const contentType = match[1];
    const content = Buffer.from(match[2], 'base64');

    if (!content.length) {
        throw new Error('RECEIPT_EMPTY');
    }

    if (content.length > MAX_RECEIPT_BYTES) {
        throw new Error('RECEIPT_TOO_LARGE');
    }

    const validMagic =
        (
            contentType === 'application/pdf' &&
            content.subarray(0, 5).toString('ascii') === '%PDF-'
        ) ||
        (
            contentType === 'image/png' &&
            content.subarray(0, 8).equals(
                Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
            )
        ) ||
        (
            contentType === 'image/jpeg' &&
            content[0] === 0xff &&
            content[1] === 0xd8 &&
            content[content.length - 2] === 0xff &&
            content[content.length - 1] === 0xd9
        );

    if (!validMagic) {
        throw new Error('RECEIPT_CONTENT_INVALID');
    }

    return {
        content,
        contentType,
        extension:
            contentType === 'application/pdf'
                ? 'pdf'
                : (contentType === 'image/png' ? 'png' : 'jpg')
    };
}

async function saveTransferReceiptToR2({
    objectKey,
    content,
    contentType
}) {
    await r2StorageClient().send(
        new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: objectKey,
            Body: content,
            ContentType: contentType,
            CacheControl: 'private, no-store'
        })
    );
}

async function readTransferReceiptFromR2(objectKey) {
    if (!objectKey || !r2StorageConfigured()) {
        return null;
    }

    try {
        const result = await r2StorageClient().send(
            new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: objectKey
            })
        );
        const content = await r2BodyBuffer(result.Body);

        if (!content.length || content.length > MAX_RECEIPT_BYTES) {
            throw new Error('RECEIPT_CONTENT_INVALID');
        }

        return {
            content,
            contentType:
                result.ContentType || 'application/octet-stream'
        };
    } catch (error) {
        if (
            error?.name === 'NoSuchKey' ||
            error?.$metadata?.httpStatusCode === 404
        ) {
            return null;
        }

        throw error;
    }
}

async function r2BodyBuffer(body) {
    if (!body) {
        return Buffer.alloc(0);
    }

    if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
    }

    const chunks = [];

    for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

async function saveLabelToR2({
    objectKey,
    content,
    contentType = 'application/pdf'
}) {
    if (!Buffer.isBuffer(content) || content.length === 0) {
        throw new Error('LABEL_CONTENT_EMPTY');
    }

    if (content.length > MAX_LABEL_BYTES) {
        throw new Error('LABEL_TOO_LARGE');
    }

    await r2StorageClient().send(
        new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: objectKey,
            Body: content,
            ContentType: contentType,
            CacheControl: 'private, no-store'
        })
    );
}

async function readLabelFromR2(objectKey) {
    if (!objectKey || !r2StorageConfigured()) {
        return null;
    }

    try {
        const result = await r2StorageClient().send(
            new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: objectKey
            })
        );
        const content = await r2BodyBuffer(result.Body);

        if (!content.length || content.length > MAX_LABEL_BYTES) {
            throw new Error(
                content.length ? 'LABEL_TOO_LARGE' : 'LABEL_CONTENT_EMPTY'
            );
        }

        return {
            content,
            contentType: result.ContentType || 'application/pdf'
        };
    } catch (error) {
        if (
            error?.name === 'NoSuchKey' ||
            error?.$metadata?.httpStatusCode === 404
        ) {
            return null;
        }

        throw error;
    }
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function passwordDigest(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            String(password),
            salt,
            64,
            {
                N: 16384,
                r: 8,
                p: 1,
                maxmem: 64 * 1024 * 1024
            },
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
        hash: await passwordDigest(password, salt)
    };
}

async function passwordMatches(password, salt, expectedHash) {
    const actualHash = await passwordDigest(password, salt);
    const actual = Buffer.from(actualHash, 'hex');
    const expected = Buffer.from(String(expectedHash || ''), 'hex');

    return (
        actual.length === expected.length &&
        crypto.timingSafeEqual(actual, expected)
    );
}

function createActionToken() {
    const token = crypto.randomBytes(32).toString('hex');

    return {
        token,
        hash: crypto
            .createHash('sha256')
            .update(token)
            .digest('hex')
    };
}

function actionTokenHash(token) {
    return crypto
        .createHash('sha256')
        .update(String(token || ''))
        .digest('hex');
}

function encodeSessionPart(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signSessionPart(encodedPayload) {
    return crypto
        .createHmac('sha256', AUTH_SECRET)
        .update(encodedPayload)
        .digest('base64url');
}

function createSessionToken(user) {
    const encodedPayload = encodeSessionPart({
        userId: String(user._id),
        version: number(user.sessionVersion),
        expiresAt: Date.now() + SESSION_MAX_AGE_MS
    });

    return `${encodedPayload}.${signSessionPart(encodedPayload)}`;
}

function parseCookies(req) {
    return String(req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separator = part.indexOf('=');

            if (separator > 0) {
                cookies[part.slice(0, separator)] =
                    decodeURIComponent(part.slice(separator + 1));
            }

            return cookies;
        }, {});
}

function readSession(req) {
    if (!customerAccountsEnabled()) {
        return null;
    }

    const token = parseCookies(req)[SESSION_COOKIE_NAME];

    if (!token) {
        return null;
    }

    const [encodedPayload, signature] = token.split('.');

    if (!encodedPayload || !signature) {
        return null;
    }

    const expected = Buffer.from(signSessionPart(encodedPayload));
    const received = Buffer.from(signature);

    if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
    ) {
        return null;
    }

    try {
        const payload = JSON.parse(
            Buffer.from(encodedPayload, 'base64url').toString('utf8')
        );

        if (
            !payload.userId ||
            number(payload.expiresAt) <= Date.now()
        ) {
            return null;
        }

        return payload;
    } catch {
        return null;
    }
}

async function authenticatedUser(req) {
    const session = readSession(req);

    if (!session) {
        return null;
    }

    await connectToDatabase();

    const user = await User.findById(session.userId);

    if (
        !user ||
        !user.emailVerifiedAt ||
        number(user.sessionVersion) !== number(session.version)
    ) {
        return null;
    }

    return user;
}

function setSessionCookie(res, user) {
    res.cookie(
        SESSION_COOKIE_NAME,
        createSessionToken(user),
        {
            httpOnly: true,
            secure:
                process.env.NODE_ENV === 'production' ||
                PUBLIC_BASE_URL.startsWith('https://'),
            sameSite: 'lax',
            maxAge: SESSION_MAX_AGE_MS,
            path: '/'
        }
    );
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure:
            process.env.NODE_ENV === 'production' ||
            PUBLIC_BASE_URL.startsWith('https://'),
        sameSite: 'lax',
        path: '/'
    });
}

function publicUser(user) {
    return {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
        emailVerified: Boolean(user.emailVerifiedAt),
        isBankTransferAdmin: isBankTransferAdmin(user)
    };
}

function brandedEmailHtml(title, bodyHtml, buttonText, buttonUrl) {
    const action = buttonUrl
        ? `<p style="margin:26px 0;text-align:center"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:13px 24px;border-radius:12px;background:#1769ff;color:#fff;text-decoration:none;font-weight:800">${escapeHtml(buttonText)}</a></p>`
        : '';

    return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f5f7fb;font-family:Tahoma,Arial,sans-serif;color:#101828"><div style="max-width:620px;margin:28px auto;padding:0 14px"><div style="padding:18px 24px;border-radius:18px 18px 0 0;background:#0b1f41;color:#fff;font-size:24px;font-weight:900;letter-spacing:1px">SUMSN</div><div style="padding:26px 24px;border:1px solid #e5eaf2;border-top:0;border-radius:0 0 18px 18px;background:#fff"><h1 style="margin:0 0 16px;font-size:22px;color:#0b1f41">${escapeHtml(title)}</h1><div style="font-size:15px;line-height:1.9;color:#475467">${bodyHtml}</div>${action}<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #eef1f5;color:#98a2b3;font-size:12px">هذه رسالة آلية من SUMSN. للرد أو المساعدة تواصل عبر ${escapeHtml(SUPPORT_EMAIL)}.</p></div></div></body></html>`;
}

async function sendBrandedEmail({
    to,
    subject,
    text,
    html,
    attachments = [],
    replyTo = SUPPORT_EMAIL
}) {
    if (!emailServiceConfigured()) {
        throw new Error('EMAIL_NOT_CONFIGURED');
    }

    const messageReference = crypto.randomUUID();

    if (RESEND_API_KEY) {
        const response = await fetch(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: `SUMSN <${EMAIL_FROM}>`,
                    to: [to],
                    reply_to: replyTo,
                    subject,
                    text,
                    html,
                    headers: {
                        'X-Entity-Ref-ID': messageReference
                    },
                    attachments: attachments.map((attachment) => ({
                        filename: attachment.filename,
                        content: Buffer
                            .from(attachment.content)
                            .toString('base64')
                    }))
                })
            }
        );

        const raw = await response.text();
        let result = {};

        try {
            result = raw ? JSON.parse(raw) : {};
        } catch {
            result = {};
        }

        if (!response.ok) {
            const error = new Error('EMAIL_SEND_ERROR');
            error.providerMessage =
                result.message ||
                result.error ||
                'تعذر إرسال البريد.';
            throw error;
        }

        return {
            id: result.id || ''
        };
    }

    const result = await transporter.sendMail({
        from: `"SUMSN" <${EMAIL_FROM}>`,
        replyTo,
        to,
        subject,
        text,
        html,
        headers: {
            'X-Entity-Ref-ID': messageReference
        },
        attachments: attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content,
            contentType:
                attachment.contentType ||
                'application/pdf'
        }))
    });

    return {
        id: result.messageId || ''
    };
}

async function sendVerificationEmail(user, token) {
    const messageCode =
        crypto.randomBytes(3).toString('hex').toUpperCase();
    const link =
        `${PUBLIC_BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;

    return sendBrandedEmail({
        to: user.email,
        subject: `تأكيد بريدك في SUMSN — ${messageCode}`,
        text:
            `مرحبًا ${user.fullName}،\n\n` +
            `أكد بريدك لبدء استخدام حساب SUMSN:\n${link}\n\n` +
            'تنتهي صلاحية الرابط خلال 24 ساعة.',
        html: brandedEmailHtml(
            'تأكيد البريد الإلكتروني',
            `<p>مرحبًا ${escapeHtml(user.fullName)}،</p><p>اضغط الزر التالي لتأكيد بريدك وبدء استخدام حساب SUMSN.</p><p>تنتهي صلاحية الرابط خلال 24 ساعة.</p>`,
            'تأكيد بريدي',
            link
        )
    });
}

async function sendPasswordResetEmail(user, token) {
    const messageCode =
        crypto.randomBytes(3).toString('hex').toUpperCase();
    const link =
        `${PUBLIC_BASE_URL}/?resetToken=${encodeURIComponent(token)}`;

    return sendBrandedEmail({
        to: user.email,
        subject: `إعادة تعيين كلمة مرور SUMSN — ${messageCode}`,
        text:
            `مرحبًا ${user.fullName}،\n\n` +
            `استخدم الرابط التالي لإعادة تعيين كلمة المرور:\n${link}\n\n` +
            'تنتهي صلاحية الرابط خلال ساعة. تجاهل الرسالة إن لم تطلب ذلك.',
        html: brandedEmailHtml(
            'إعادة تعيين كلمة المرور',
            `<p>مرحبًا ${escapeHtml(user.fullName)}،</p><p>وصلنا طلب لإعادة تعيين كلمة مرور حسابك.</p><p>تنتهي صلاحية الرابط خلال ساعة. تجاهل الرسالة إن لم تطلب ذلك.</p>`,
            'تعيين كلمة مرور جديدة',
            link
        )
    });
}

async function labelAttachment(providerLabelUrl, orderId) {
    if (!providerLabelUrl) {
        return null;
    }

    const response = await fetch(providerLabelUrl);

    if (!response.ok) {
        throw new Error('LABEL_DOWNLOAD_ERROR');
    }

    const content = Buffer.from(await response.arrayBuffer());

    if (content.length > MAX_LABEL_BYTES) {
        throw new Error('LABEL_TOO_LARGE');
    }

    return {
        filename: `${orderId}.pdf`,
        content,
        contentType:
            response.headers.get('content-type') ||
            'application/pdf'
    };
}

async function sendShipmentCreatedEmail({
    user,
    carrierName,
    orderId,
    trackingNumber,
    finalPrice,
    attachment
}) {
    const attachmentText = attachment
        ? 'ستجد بوليصة الشحن PDF مرفقة مع هذه الرسالة.'
        : 'البوليصة قيد التجهيز ويمكن فتحها من لوحة حسابك عند جاهزيتها.';

    return sendBrandedEmail({
        to: user.email,
        subject: `بوليصة شحنتك ${orderId}`,
        text:
            `مرحبًا ${user.fullName}،\n\n` +
            'تم إنشاء شحنتك بنجاح عبر SUMSN.\n' +
            `شركة الشحن: ${carrierName}\n` +
            `رقم الطلب: ${orderId}\n` +
            `رقم التتبع: ${trackingNumber || 'سيتم توفيره قريبًا'}\n` +
            `الإجمالي: ${finalPrice.toFixed(2)} ريال\n\n` +
            attachmentText,
        html: brandedEmailHtml(
            'تم إنشاء شحنتك بنجاح',
            `<p>مرحبًا ${escapeHtml(user.fullName)}،</p><p>تم إنشاء شحنتك بنجاح عبر SUMSN.</p><table style="width:100%;border-collapse:collapse;margin:18px 0"><tr><td style="padding:8px;border-bottom:1px solid #eef1f5">شركة الشحن</td><td style="padding:8px;border-bottom:1px solid #eef1f5;font-weight:700">${escapeHtml(carrierName)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eef1f5">رقم الطلب</td><td style="padding:8px;border-bottom:1px solid #eef1f5;font-weight:700">${escapeHtml(orderId)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eef1f5">رقم التتبع</td><td style="padding:8px;border-bottom:1px solid #eef1f5;font-weight:700">${escapeHtml(trackingNumber || 'سيتم توفيره قريبًا')}</td></tr><tr><td style="padding:8px">الإجمالي</td><td style="padding:8px;font-weight:700">${escapeHtml(finalPrice.toFixed(2))} ريال</td></tr></table><p>${escapeHtml(attachmentText)}</p>`,
            '',
            ''
        ),
        attachments: attachment ? [attachment] : []
    });
}

async function sendTransferSubmittedEmail(payment) {
    if (
        !emailServiceConfigured() ||
        !validEmail(BANK_TRANSFER_ADMIN_EMAIL)
    ) {
        return null;
    }

    const reviewUrl =
        `${PUBLIC_BASE_URL}/admin-transfers.html`;

    return sendBrandedEmail({
        to: BANK_TRANSFER_ADMIN_EMAIL,
        subject:
            `تحويل بنكي بانتظار المراجعة — ${payment.orderNumber}`,
        text:
            'تم رفع إيصال تحويل بنكي جديد في SUMSN.\n\n' +
            `رقم الطلب: ${payment.orderNumber}\n` +
            `البريد: ${payment.customerEmail}\n` +
            `المبلغ: ${number(payment.amount).toFixed(2)} ريال\n\n` +
            `راجع دخول المبلغ في تطبيق البنك ثم افتح لوحة المراجعة:\n${reviewUrl}`,
        html: brandedEmailHtml(
            'تحويل بنكي بانتظار المراجعة',
            `<p>رفع العميل إيصال تحويل بنكي جديد.</p><table style="width:100%;border-collapse:collapse;margin:18px 0"><tr><td style="padding:8px;border-bottom:1px solid #eef1f5">رقم الطلب</td><td style="padding:8px;border-bottom:1px solid #eef1f5;font-weight:700">${escapeHtml(payment.orderNumber)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eef1f5">البريد</td><td style="padding:8px;border-bottom:1px solid #eef1f5;font-weight:700">${escapeHtml(payment.customerEmail)}</td></tr><tr><td style="padding:8px">المبلغ</td><td style="padding:8px;font-weight:700">${escapeHtml(number(payment.amount).toFixed(2))} ريال</td></tr></table><p><strong>لا تعتمد الإيصال وحده.</strong> تأكد أولًا من دخول المبلغ فعليًا في تطبيق البنك.</p>`,
            'فتح لوحة المراجعة',
            reviewUrl
        )
    });
}

const authAttempts = new Map();

function authRateLimited(req, action, maximum, windowMs) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
    const address =
        forwarded ||
        req.socket?.remoteAddress ||
        'unknown';
    const key = `${action}:${address}`;
    const now = Date.now();
    const current = authAttempts.get(key);

    if (!current || current.resetAt <= now) {
        authAttempts.set(key, {
            count: 1,
            resetAt: now + windowMs
        });
        return false;
    }

    current.count += 1;

    return current.count > maximum;
}

async function initializePlatformStats() {
    const exists = await PlatformStat.exists({
        _id: 'global'
    });

    if (exists) {
        return;
    }

    const [totalOperations, priceStats] = await Promise.all([
        SearchLog.countDocuments(),
        SearchLog.aggregate([
            {
                $unwind: '$prices'
            },
            {
                $group: {
                    _id: null,
                    priceSum: {
                        $sum: '$prices.price'
                    },
                    priceCount: {
                        $sum: 1
                    },
                    maxCost: {
                        $max: '$prices.price'
                    }
                }
            }
        ])
    ]);
    const current = priceStats[0] || {};

    await PlatformStat.updateOne(
        {
            _id: 'global'
        },
        {
            $setOnInsert: {
                totalOperations,
                priceSum: number(current.priceSum),
                priceCount: number(current.priceCount),
                maxCost: number(current.maxCost),
                updatedAt: new Date()
            }
        },
        {
            upsert: true
        }
    );
}

async function recordSearchStatistics(rates) {
    await initializePlatformStats();

    const priceSum = rates.reduce(
        (sum, rate) => sum + number(rate.price),
        0
    );
    const maxCost = rates.reduce(
        (highest, rate) =>
            Math.max(highest, number(rate.price)),
        0
    );

    await PlatformStat.updateOne(
        {
            _id: 'global'
        },
        {
            $inc: {
                totalOperations: 1,
                priceSum,
                priceCount: rates.length
            },
            $max: {
                maxCost
            },
            $set: {
                updatedAt: new Date()
            }
        }
    );
}

let lastStorageCheckAt = 0;

async function maybeAlertDatabaseStorage() {
    const now = Date.now();

    if (
        now - lastStorageCheckAt <
        6 * 60 * 60 * 1000
    ) {
        return;
    }

    lastStorageCheckAt = now;

    try {
        const stats =
            await mongoose.connection.db.command({
                dbStats: 1
            });
        const usedBytes =
            number(stats.dataSize) +
            number(stats.indexSize);
        const usedPercent =
            MONGO_STORAGE_LIMIT_BYTES > 0
                ? (usedBytes / MONGO_STORAGE_LIMIT_BYTES) * 100
                : 0;

        if (usedPercent < 70) {
            return;
        }

        console.warn(
            `استخدام MongoDB وصل إلى ${usedPercent.toFixed(1)}%`
        );

        const platform =
            await PlatformStat.findById('global');
        const lastAlert =
            platform?.lastStorageAlertAt
                ? new Date(platform.lastStorageAlertAt).getTime()
                : 0;

        if (
            !emailServiceConfigured() ||
            now - lastAlert < 24 * 60 * 60 * 1000
        ) {
            return;
        }

        await sendBrandedEmail({
            to: SUPPORT_EMAIL,
            subject: 'تنبيه مساحة قاعدة بيانات SUMSN',
            text:
                `وصل استخدام قاعدة البيانات إلى ${usedPercent.toFixed(1)}%. راجع MongoDB Atlas قبل بلوغ الحد المجاني.`,
            html: brandedEmailHtml(
                'تنبيه مساحة قاعدة البيانات',
                `<p>وصل استخدام قاعدة بيانات SUMSN إلى <strong>${escapeHtml(usedPercent.toFixed(1))}%</strong>.</p><p>راجع MongoDB Atlas ونظّف البيانات القديمة أو قم بالترقية قبل بلوغ الحد المجاني.</p>`,
                '',
                ''
            )
        });

        await PlatformStat.updateOne(
            {
                _id: 'global'
            },
            {
                $set: {
                    lastStorageAlertAt: new Date()
                }
            },
            {
                upsert: true
            }
        );
    } catch (error) {
        console.warn(
            'تعذر فحص مساحة MongoDB:',
            error.message
        );
    }
}

function normalizeCarrierCode(value) {
    if (!value) {
        return '';
    }

    const normalized = String(value)
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, '');

    if (normalized.includes('smsa')) return 'SMSA';
    if (normalized.includes('aramex')) return 'Aramex';
    if (normalized.includes('redbox')) return 'RedBox';
    if (normalized.includes('spl') || normalized.includes('saudipost')) return 'SPL';
    if (normalized.includes('dhl')) return 'DHL';
    if (normalized.includes('naqel')) return 'ناقل';
    if (normalized.includes('imile')) return 'iMile';
    if (normalized.includes('jt') || normalized.includes('j&t')) return 'J&T Express';
    if (normalized.includes('aymakan')) return 'Aymakan';
    if (normalized.includes('ups')) return 'UPS';

    return '';
}

function looksTechnicalName(value) {
    if (!value) {
        return true;
    }

    const text = String(value).trim();

    return (
        /[A-Z].*[A-Z]/.test(text) ||
        /v\d+/i.test(text) ||
        /\d/.test(text) ||
        text.length > 45
    );
}

function getCarrierDisplayName(company) {
    const optionName = cleanPublicText(company?.deliveryOptionName);
    const optionMapped = normalizeCarrierCode(optionName);

    if (optionMapped) {
        return optionMapped;
    }

    const companyName = cleanPublicText(company?.deliveryCompanyName);
    const companyMapped = normalizeCarrierCode(companyName);

    if (companyMapped) {
        return companyMapped;
    }

    if (optionName && !looksTechnicalName(optionName)) {
        return optionName;
    }

    if (companyName && !looksTechnicalName(companyName)) {
        return companyName;
    }

    return 'شركة شحن';
}

function getDeliveryServiceLabel(company) {
    const pickingType = String(
        company?.pickingType ||
        company?.pickupType ||
        company?.collectionType ||
        ''
    )
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, '');

    const deliveryType = String(
        company?.deliveryType ||
        company?.destinationDeliveryType ||
        company?.dropOffType ||
        ''
    )
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, '');

    const descriptiveText = [
        company?.serviceName,
        company?.shippingMethod,
        company?.deliveryOptionName
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/[\s_-]/g, '');

    const serviceDetails = `${pickingType} ${deliveryType} ${descriptiveText}`;
    const destinationHasChoice =
        deliveryType.includes('tocustomerdoorsteporpickupbycustomer');
    const originFromDoor =
        pickingType.includes('pickupbydc') ||
        /doortodoor|doortobranch/.test(serviceDetails);
    const originAtBranch =
        pickingType.includes('branchdropoff') ||
        /branchtodoor|branchtobranch/.test(serviceDetails);
    const destinationAtDoor =
        !destinationHasChoice &&
        (
            deliveryType.includes('tocustomerdoorstep') ||
            /doortodoor|branchtodoor/.test(serviceDetails)
        );
    const destinationAtBranch =
        !destinationHasChoice &&
        (
            deliveryType.includes('pickupbycustomer') ||
            /doortobranch|branchtobranch/.test(serviceDetails)
        );

    if (destinationHasChoice) {
        if (originFromDoor) {
            return 'استلام من الباب، والتسليم للباب أو الاستلام من الفرع';
        }

        if (originAtBranch) {
            return 'تسليم الشحنة للفرع، والتسليم للباب أو الاستلام من الفرع';
        }

        return 'التسليم للباب أو الاستلام من الفرع';
    }

    if (originFromDoor && destinationAtDoor) {
        return 'استلام من الباب وتسليم لباب المستلم';
    }

    if (originFromDoor && destinationAtBranch) {
        return 'استلام من الباب واستلام المستلم من الفرع';
    }

    if (originAtBranch && destinationAtDoor) {
        return 'تسليم الشحنة للفرع وتوصيلها لباب المستلم';
    }

    if (originAtBranch && destinationAtBranch) {
        return 'تسليم واستلام من الفرع';
    }

    if (originFromDoor) {
        return 'استلام الشحنة من باب المرسل';
    }

    if (originAtBranch) {
        return 'تسليم الشحنة لفرع الشركة';
    }

    if (destinationAtDoor) {
        return 'توصيل الشحنة لباب المستلم';
    }

    if (destinationAtBranch) {
        return 'استلام المستلم من الفرع';
    }

    return 'تفاصيل الخدمة حسب شركة الشحن';
}

/*
|--------------------------------------------------------------------------
| Access Token
|--------------------------------------------------------------------------
*/

async function getShippingAccessToken() {
    if (
        shippingAccessToken &&
        Date.now() < shippingAccessTokenExpiresAt
    ) {
        return shippingAccessToken;
    }

    if (!SHIPPING_REFRESH_TOKEN) {
        throw new Error('SHIPPING_CONFIGURATION_ERROR');
    }

    const response = await fetch(
        `${SHIPPING_BASE_URL}/refreshToken`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                refresh_token: SHIPPING_REFRESH_TOKEN
            })
        }
    );

    const raw = await response.text();

    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = {};
    }

    const token =
        data.access_token ||
        data.accessToken ||
        data.data?.access_token ||
        data.data?.accessToken;

    if (!response.ok || !token) {
        console.error('تعذر إنشاء Access Token لمزود الشحن:', response.status);
        const providerError = new Error('SHIPPING_PROVIDER_ERROR');
        providerError.providerStatus = response.status;
        providerError.providerMessage =
            data.message ||
            data.error ||
            data.errorMsg ||
            data.otoErrorMessage ||
            raw?.slice(0, 500) ||
            '';

        throw providerError;
    }

    shippingAccessToken = token;
    shippingAccessTokenExpiresAt = Date.now() + (55 * 60 * 1000);

    return shippingAccessToken;
}

/*
|--------------------------------------------------------------------------
| طلب داخلي لمزود الشحن
|--------------------------------------------------------------------------
*/

async function shippingRequest(path, body, method = 'POST') {
    const accessToken = await getShippingAccessToken();

    const response = await fetch(
        `${SHIPPING_BASE_URL}/${path}`,
        {
            method,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body:
                method === 'GET'
                    ? undefined
                    : JSON.stringify(body)
        }
    );

    const raw = await response.text();

    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = {};
    }

    if (!response.ok || data.success === false) {
        console.error('خطأ داخلي من مزود الشحن:', {
            status: response.status,
            message:
                data.message ||
                data.error ||
                data.errorMsg ||
                raw?.slice(0, 500)
        });

        const providerError = new Error('SHIPPING_PROVIDER_ERROR');
        providerError.providerStatus = response.status;
        providerError.providerMessage =
            data.message ||
            data.error ||
            data.errorMsg ||
            data.otoErrorMessage ||
            raw?.slice(0, 500) ||
            '';
        providerError.providerData = data;

        throw providerError;
    }

    return data;
}

function getDeliveryCompanies(data) {
    const candidates = [
        data?.deliveryCompany,
        data?.deliveryCompanies,
        data?.data?.deliveryCompany,
        data?.data?.deliveryCompanies,
        data?.rates,
        data?.results,
        data?.data
    ];

    return candidates.find(Array.isArray) || [];
}

function quotePayload(
    originCity,
    destinationCity,
    weight,
    boxLength,
    boxWidth,
    boxHeight
) {
    return {
        originCity,
        destinationCity,
        originCountry: 'SA',
        destinationCountry: 'SA',
        weight: number(weight),
        length: number(boxLength),
        width: number(boxWidth),
        height: number(boxHeight),
        packageCount: 1,
        currency: 'SAR'
    };
}

function firstValue(source, names) {
    for (const name of names) {
        const value = source?.[name];

        if (value !== undefined && value !== null && String(value).trim()) {
            return value;
        }
    }

    return '';
}

function normalizeNationalAddress(result, shortCode) {
    const candidates = [
        result?.data?.addresses?.[0],
        result?.addresses?.[0],
        result?.data?.address,
        result?.address,
        result?.data,
        result
    ];
    const source = candidates.find(
        (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            !Array.isArray(candidate)
    ) || {};

    const address = {
        shortCode,
        buildingNo: String(firstValue(source, [
            'buildingName',
            'buildingNo',
            'buildingNumber',
            'BuildingNumber'
        ])).trim(),
        secondaryNumber: String(firstValue(source, [
            'secondary',
            'secondaryNumber',
            'additionalNumber',
            'SecondaryNumber'
        ])).trim(),
        street: String(firstValue(source, [
            'street',
            'streetName',
            'StreetName'
        ])).trim(),
        district: String(firstValue(source, [
            'districtName',
            'district',
            'District'
        ])).trim(),
        city: String(firstValue(source, [
            'cityName',
            'city',
            'CityName'
        ])).trim(),
        state: String(firstValue(source, [
            'stateName',
            'state',
            'region',
            'regionName'
        ])).trim(),
        postcode: String(firstValue(source, [
            'postcode',
            'postalCode',
            'zipCode',
            'ZipCode'
        ])).trim(),
        lat: firstValue(source, ['lat', 'latitude', 'Latitude']),
        lon: firstValue(source, ['lon', 'lng', 'longitude', 'Longitude'])
    };

    address.addressLine = [
        address.buildingNo,
        address.street,
        address.district,
        address.city,
        address.postcode,
        address.secondaryNumber
    ].filter(Boolean).join(', ');

    if (
        !address.addressLine ||
        !address.buildingNo ||
        !address.street ||
        !address.district ||
        !address.city ||
        !address.postcode
    ) {
        throw new Error('INVALID_NATIONAL_ADDRESS');
    }

    return address;
}

async function getNationalAddress(shortCode) {
    const result = await shippingRequest(
        'getNationalAddressFromShortCode',
        { shortAddressCode: shortCode }
    );

    return normalizeNationalAddress(result, shortCode);
}

function normalizedPhoneDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');

    if (digits.startsWith('00966')) {
        return digits.slice(2);
    }

    if (digits.startsWith('0')) {
        return `966${digits.slice(1)}`;
    }

    return digits;
}

function senderPickupLocationCode(body, senderAddress) {
    const identity = [
        senderAddress.shortCode,
        normalizedPhoneDigits(body.senderPhone),
        String(body.senderName || '').trim().toLowerCase()
    ].join('|');
    const suffix = crypto
        .createHash('sha256')
        .update(identity)
        .digest('hex')
        .slice(0, 8)
        .toUpperCase();

    return `SUMSN-${senderAddress.shortCode}-${suffix}`;
}

function pickupLocationsFromResponse(result) {
    const locations = [];
    const visited = new Set();

    function collect(value) {
        if (!value || typeof value !== 'object' || visited.has(value)) {
            return;
        }

        visited.add(value);

        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }

        const code = String(
            value.code ||
            value.pickupLocationCode ||
            value.locationCode ||
            ''
        ).trim();

        if (code) {
            locations.push(value);
        }

        [
            'data',
            'warehouses',
            'branches',
            'locations',
            'pickupLocations',
            'results',
            'items'
        ].forEach((key) => collect(value[key]));
    }

    collect(result);
    return locations;
}

function pickupLocationCode(location) {
    return String(
        location?.code ||
        location?.pickupLocationCode ||
        location?.locationCode ||
        ''
    ).trim();
}

function pickupLocationIsActive(location) {
    const activeValues = [
        location?.active,
        location?.isActive,
        location?.enabled,
        location?.isEnabled
    ].filter((value) => value !== undefined && value !== null);

    if (activeValues.some((value) =>
        value === false ||
        value === 0 ||
        ['false', '0', 'inactive', 'disabled'].includes(
            String(value).trim().toLowerCase()
        )
    )) {
        return false;
    }

    const status = String(
        location?.status ||
        location?.state ||
        location?.activationStatus ||
        ''
    ).trim().toLowerCase();

    if (!status) {
        return true;
    }

    return ![
        'inactive',
        'disabled',
        'deactivated',
        'not_active',
        'not active',
        'false',
        '0'
    ].includes(status);
}

async function getPickupLocations() {
    const result = await shippingRequest(
        'getPickupLocationList',
        undefined,
        'GET'
    );

    return pickupLocationsFromResponse(result);
}

function activePickupLocationForCode(locations, baseCode) {
    const normalizedBase = baseCode.toUpperCase();
    const matches = locations.filter((location) => {
        const code = pickupLocationCode(location).toUpperCase();

        return pickupLocationIsActive(location) && (
            code === normalizedBase ||
            code.startsWith(`${normalizedBase}-R`)
        );
    });

    // Prefer the latest replacement over the original code. OTO can leave an
    // inactive location in the list without exposing a reliable status field.
    return matches.sort((left, right) =>
        pickupLocationCode(right).localeCompare(
            pickupLocationCode(left)
        )
    )[0];
}

function senderPickupLocationPayload(body, senderAddress, code) {
    const pickupLocation = {
        type: 'warehouse',
        code,
        name: `SUMSN - ${body.senderName.trim()}`,
        mobile: body.senderPhone.trim(),
        address: senderAddress.addressLine,
        contactName: body.senderName.trim(),
        contactEmail: body.email.trim(),
        city: senderAddress.city,
        country: 'SA',
        state: senderAddress.state,
        district: senderAddress.district,
        street: senderAddress.street,
        buildingNo: senderAddress.buildingNo,
        secondaryAddressNumber: senderAddress.secondaryNumber,
        postcode: senderAddress.postcode,
        shortAddressCode: senderAddress.shortCode,
        brandName: 'SUMSN',
        status: 'active'
    };
    const lat = number(senderAddress.lat, NaN);
    const lon = number(senderAddress.lon, NaN);

    if (Number.isFinite(lat)) {
        pickupLocation.lat = lat;
    }

    if (Number.isFinite(lon)) {
        pickupLocation.lon = lon;
    }

    return pickupLocation;
}

async function ensureSenderPickupLocation(
    body,
    senderAddress,
    { forceNew = false } = {}
) {
    const baseCode = senderPickupLocationCode(body, senderAddress);
    const existingLocations = await getPickupLocations();
    const activeLocation = activePickupLocationForCode(
        existingLocations,
        baseCode
    );

    if (activeLocation && !forceNew) {
        return pickupLocationCode(activeLocation);
    }

    const exactLocationExists = existingLocations.some(
        (location) =>
            pickupLocationCode(location).toUpperCase() ===
            baseCode.toUpperCase()
    );
    const code = forceNew || exactLocationExists
        ? `${baseCode}-R${Date.now().toString(36).toUpperCase()}`
        : baseCode;
    const pickupLocation = senderPickupLocationPayload(
        body,
        senderAddress,
        code
    );

    try {
        const created = await shippingRequest(
            'createPickupLocation',
            pickupLocation
        );
        const createdCode = String(
            created.pickupLocationCode ||
            created.data?.pickupLocationCode ||
            created.code ||
            created.data?.code ||
            code
        ).trim();
        return createdCode;
    } catch (error) {
        // إذا وصل طلبان للمرسل نفسه معًا فقد ينجح الإنشاء الأول فقط.
        // نعيد قراءة المواقع حتى نستخدم الكود الذي أُنشئ بدل الفشل.
        const refreshedLocations = await getPickupLocations();
        const refreshedLocation = refreshedLocations.find(
            (location) =>
                pickupLocationIsActive(location) &&
                pickupLocationCode(location).toUpperCase() ===
                    code.toUpperCase()
        );

        if (refreshedLocation) {
            return pickupLocationCode(refreshedLocation);
        }

        throw error;
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pickupLocationProviderError(error) {
    const message = String(error?.providerMessage || '').toLowerCase();

    return message.includes('pickup location') && (
        message.includes('missing') ||
        message.includes('invalid') ||
        message.includes('not active') ||
        message.includes('not found')
    );
}

async function createShipmentAfterAssignment(
    orderId,
    deliveryOptionId,
    { retryPickupLocation = false } = {}
) {
    let lastError;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt > 0) {
            await wait(1500 * attempt);
        }

        try {
            return await shippingRequest(
                'createShipment',
                {
                    orderId,
                    deliveryOptionId: number(deliveryOptionId)
                }
            );
        } catch (error) {
            lastError = error;
            const message = String(error.providerMessage || '').toLowerCase();
            const providerCode = String(
                error.providerData?.otoErrorCode || ''
            ).toUpperCase();
            const orderIsStillPropagating =
                providerCode === 'OTO1001' ||
                message.includes('invalid or missing order id');
            const pickupLocationIsStillPropagating =
                pickupLocationProviderError(error);

            // Give the freshly updated order one brief propagation retry.
            // If OTO still rejects its pickup location, return control to the
            // repair path so it can create a replacement instead of waiting
            // through the full assignment retry window.
            if (
                pickupLocationIsStillPropagating &&
                !retryPickupLocation &&
                attempt >= 1
            ) {
                throw error;
            }

            if (
                !message.includes('not assigned yet') &&
                !orderIsStillPropagating &&
                !pickupLocationIsStillPropagating
            ) {
                throw error;
            }
        }
    }

    throw lastError;
}

async function getShipmentLabel(orderId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt > 0) {
            await wait(1200 * attempt);
        }

        try {
            const label = await shippingRequest(
                `print/${encodeURIComponent(orderId)}`,
                undefined,
                'GET'
            );
            const labelUrl =
                label.printAWBURL ||
                label.url ||
                label.data?.printAWBURL ||
                label.data?.url ||
                '';

            if (labelUrl) {
                return labelUrl;
            }
        } catch (error) {
            if (attempt === 4) {
                console.warn('تعذر جلب رابط البوليصة:', error.message);
            }
        }
    }

    return '';
}

function shippingProviderNotFound(error) {
    const message = String(error?.providerMessage || '').toLowerCase();

    return (
        error?.providerStatus === 404 ||
        message.includes('not found') ||
        message.includes('does not exist') ||
        message.includes('غير موجود')
    );
}

function providerOrderResponseMatches(source, expectedOrderId) {
    const expected = String(expectedOrderId || '').trim().toUpperCase();

    if (!expected || !source || source.success === false) {
        return false;
    }

    const returnedOrderId = findProviderValue(source, [
        'orderId',
        'order_id',
        'orderNumber',
        'order_number',
        'incrementId',
        'increment_id'
    ]);

    return String(returnedOrderId || '').trim().toUpperCase() === expected;
}

function shippingProviderStatus(error) {
    return number(
        error?.providerStatus ??
        error?.response?.status,
        0
    );
}

function shippingProviderOutcomeIsAmbiguous(error) {
    const status = shippingProviderStatus(error);

    return (
        !status ||
        status >= 500 ||
        [408, 409, 425, 429].includes(status)
    );
}

function shippingCheckpointIsPastGrace(payment) {
    const checkpointTimes = [
        payment?.providerOrderCreatedAt,
        payment?.providerShipmentRequestedAt
    ]
        .map((value) => value ? new Date(value).getTime() : 0)
        .filter((value) => Number.isFinite(value) && value > 0);

    if (!checkpointTimes.length) {
        return false;
    }

    return (
        Date.now() - Math.max(...checkpointTimes) >=
        SHIPPING_RECONCILIATION_GRACE_MS
    );
}

async function getProviderOrderDetails(orderId) {
    try {
        const response = await shippingRequest(
            `orderDetails?orderId=${encodeURIComponent(orderId)}`,
            undefined,
            'GET'
        );

        // OTO may return HTTP 200 with an empty body when an order is absent.
        // Only a response containing this exact merchant order ID proves it exists.
        return providerOrderResponseMatches(response, orderId)
            ? response
            : null;
    } catch (error) {
        if (shippingProviderNotFound(error)) {
            return null;
        }

        throw error;
    }
}

function buildProviderOrder(
    payment,
    body,
    receiverAddress,
    pickupLocationCode
) {
    return {
        orderId: payment.orderNumber,
        pickupLocationCode,
        deliveryOptionId: number(payment.deliveryOptionId),
        storeName: 'SUMSN',
        payment_method: 'paid',
        amount: payment.amount,
        amount_due: 0,
        shippingAmount: payment.providerCost,
        subtotal: payment.amount,
        currency: 'SAR',
        packageCount: 1,
        packageWeight: number(body.weight),
        boxLength: number(body.boxLength),
        boxWidth: number(body.boxWidth),
        boxHeight: number(body.boxHeight),
        shippingNotes: body.contentsDescription,
        item_description: body.contentsDescription,
        customer: {
            name: body.receiverName.trim(),
            email: body.email.trim(),
            mobile: body.receiverPhone.trim(),
            country: 'SA',
            shortAddressCode: receiverAddress.shortCode,
            buildingNo: receiverAddress.buildingNo,
            secondaryAddressNumber: receiverAddress.secondaryNumber,
            state: receiverAddress.state,
            city: receiverAddress.city,
            district: receiverAddress.district,
            street: receiverAddress.street,
            postcode: receiverAddress.postcode,
            address: receiverAddress.addressLine,
            lat: receiverAddress.lat,
            lon: receiverAddress.lon
        }
    };
}

async function waitForProviderOrder(orderId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt > 0) {
            await wait(1000 * attempt);
        }

        const order = await getProviderOrderDetails(orderId);

        if (order) {
            return order;
        }
    }

    return null;
}

function findProviderValue(source, expectedKeys, depth = 0, seen = new Set()) {
    if (
        source === null ||
        source === undefined ||
        typeof source !== 'object' ||
        depth > 7 ||
        seen.has(source)
    ) {
        return '';
    }

    seen.add(source);
    const normalizedKeys = new Set(
        expectedKeys.map((key) => String(key).toLowerCase())
    );

    for (const [key, value] of Object.entries(source)) {
        if (
            normalizedKeys.has(String(key).toLowerCase()) &&
            value !== null &&
            value !== undefined &&
            String(value).trim()
        ) {
            return String(value).trim();
        }
    }

    for (const value of Object.values(source)) {
        const nested = findProviderValue(
            value,
            expectedKeys,
            depth + 1,
            seen
        );

        if (nested) {
            return nested;
        }
    }

    return '';
}

function providerShipmentSnapshot(source) {
    return {
        shipmentId: findProviderValue(source, [
            'shipmentId',
            'otoShipmentId'
        ]),
        trackingNumber: findProviderValue(source, [
            'trackingNumber',
            'trackingNo',
            'awbNumber',
            'waybillNumber'
        ]),
        labelUrl: findProviderValue(source, [
            'printAWBURL',
            'printAwbUrl',
            'labelUrl',
            'awbUrl'
        ])
    };
}

async function assertSufficientShippingBalance(requiredAmount) {
    const accountInfo = await shippingRequest(
        'accountInfo',
        undefined,
        'GET'
    );
    const remainingCredit = number(
        accountInfo.remainingCredit ??
        accountInfo.data?.remainingCredit,
        NaN
    );
    const remainingFreeShipments = number(
        accountInfo.remainingFreeShipments ??
        accountInfo.data?.remainingFreeShipments,
        0
    );

    if (!Number.isFinite(remainingCredit)) {
        throw new Error('SHIPPING_BALANCE_UNAVAILABLE');
    }

    if (
        remainingFreeShipments <= 0 &&
        remainingCredit < number(requiredAmount)
    ) {
        throw new Error('INSUFFICIENT_SHIPPING_BALANCE');
    }
}

app.get('/api/shipment-label', async (req, res) => {
    const orderId = String(req.query.orderId || '');

    if (!/^SUMSN-[A-F0-9]{16}$/.test(orderId)) {
        return res.status(403).send('الرابط غير صالح.');
    }

    try {
        const user = await authenticatedUser(req);

        if (!user) {
            return res.status(401).send('سجّل الدخول لفتح بوليصتك.');
        }

        const shipment = await Shipment.findOne({
            otoOrderId: orderId,
            userId: user._id
        });

        if (!shipment) {
            return res.status(404).send('لم يتم العثور على البوليصة.');
        }

        let storedLabel = null;

        if (shipment.labelObjectKey) {
            try {
                storedLabel = await readLabelFromR2(
                    shipment.labelObjectKey
                );
            } catch (storageError) {
                console.warn(
                    'تعذر قراءة البوليصة من R2، ستتم محاولة استعادتها:',
                    storageError.message
                );
            }
        }

        if (!storedLabel) {
            const providerLabelUrl =
                shipment.labelUrl ||
                await getShipmentLabel(orderId);

            if (!providerLabelUrl) {
                return res.status(404).send('البوليصة غير جاهزة بعد.');
            }

            const attachment = await labelAttachment(
                providerLabelUrl,
                orderId
            );

            storedLabel = {
                content: attachment.content,
                contentType: attachment.contentType
            };

            if (r2StorageConfigured()) {
                const objectKey =
                    shipment.labelObjectKey ||
                    shipmentLabelObjectKey(user._id, orderId);

                try {
                    await saveLabelToR2({
                        objectKey,
                        content: storedLabel.content,
                        contentType: storedLabel.contentType
                    });

                    shipment.labelObjectKey = objectKey;
                    shipment.labelContentType = storedLabel.contentType;
                    shipment.labelSize = storedLabel.content.length;
                    shipment.labelStoredAt = new Date();
                    shipment.labelUrl = providerLabelUrl;
                    await shipment.save();
                } catch (storageError) {
                    console.error(
                        'تعذر حفظ البوليصة في R2:',
                        storageError.message
                    );
                }
            }
        }

        res.set({
            'Content-Type': storedLabel.contentType,
            'Content-Disposition': `inline; filename="${orderId}.pdf"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        });

        return res.send(storedLabel.content);
    } catch (error) {
        console.error('تعذر تحميل البوليصة:', error);
        return res.status(502).send('تعذر تحميل البوليصة حاليًا.');
    }
});

/*
|--------------------------------------------------------------------------
| رسائل التواصل
|--------------------------------------------------------------------------
*/

app.post('/api/contact', async (req, res) => {
    if (!emailServiceConfigured()) {
        return res.status(503).json({
            success: false,
            message: 'خدمة التواصل غير متاحة مؤقتًا.'
        });
    }

    if (
        authRateLimited(
            req,
            'contact',
            5,
            15 * 60 * 1000
        )
    ) {
        return res.status(429).json({
            success: false,
            message: 'تم إرسال رسائل كثيرة. حاول بعد 15 دقيقة.'
        });
    }

    const fullName = String(req.body.fullName || '').trim();
    const email = normalizeEmail(req.body.email);
    const message = String(req.body.message || '').trim();
    const website = String(req.body.website || '').trim();

    if (website) {
        return res.json({
            success: true,
            message: 'تم إرسال رسالتك إلى دعم SUMSN.'
        });
    }

    if (
        fullName.length < 2 ||
        fullName.length > 80
    ) {
        return res.status(400).json({
            success: false,
            message: 'أدخل اسمًا صحيحًا من حرفين على الأقل.'
        });
    }

    if (!validEmail(email)) {
        return res.status(400).json({
            success: false,
            message: 'أدخل بريدًا إلكترونيًا صحيحًا.'
        });
    }

    if (
        message.length < 5 ||
        message.length > 2000
    ) {
        return res.status(400).json({
            success: false,
            message: 'اكتب رسالة بين 5 و2000 حرف.'
        });
    }

    const messageCode =
        crypto.randomBytes(3).toString('hex').toUpperCase();
    const safeMessage = escapeHtml(message)
        .replace(/\r?\n/g, '<br>');

    try {
        await sendBrandedEmail({
            to: SUPPORT_EMAIL,
            replyTo: email,
            subject: `رسالة جديدة عبر SUMSN — ${messageCode}`,
            text:
                `الاسم: ${fullName}\n` +
                `البريد: ${email}\n\n` +
                message,
            html: brandedEmailHtml(
                'رسالة جديدة من الموقع',
                `<p><strong>الاسم:</strong> ${escapeHtml(fullName)}</p><p><strong>البريد:</strong> ${escapeHtml(email)}</p><p><strong>الرسالة:</strong><br>${safeMessage}</p>`,
                '',
                ''
            )
        });

        return res.json({
            success: true,
            message: 'تم إرسال رسالتك إلى دعم SUMSN.'
        });
    } catch (error) {
        console.error('تعذر إرسال رسالة التواصل:', error);

        return res.status(502).json({
            success: false,
            message: 'تعذر إرسال الرسالة حاليًا. حاول مرة أخرى بعد قليل.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| حسابات العملاء
|--------------------------------------------------------------------------
*/

app.get('/api/auth/config', (req, res) => {
    res.set('Cache-Control', 'no-store');

    res.json({
        success: true,
        enabled: customerAccountsEnabled(),
        emailReady: emailServiceConfigured(),
        supportEmail: SUPPORT_EMAIL
    });
});

app.get('/api/auth/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (!customerAccountsEnabled()) {
        return res.json({
            success: true,
            user: null
        });
    }

    try {
        const user = await authenticatedUser(req);

        return res.json({
            success: true,
            user: user ? publicUser(user) : null
        });
    } catch (error) {
        console.error('تعذر قراءة جلسة العميل:', error);

        return res.status(500).json({
            success: false,
            message: 'تعذر تحميل الحساب حاليًا.'
        });
    }
});

app.post('/api/auth/register', async (req, res) => {
    if (!customerAccountsEnabled()) {
        return res.status(503).json({
            success: false,
            message: 'إنشاء الحسابات غير متاح مؤقتًا حتى اكتمال إعداد البريد.'
        });
    }

    if (!emailServiceConfigured()) {
        return res.status(503).json({
            success: false,
            message: 'خدمة رسائل التحقق غير مهيأة بعد.'
        });
    }

    if (
        authRateLimited(
            req,
            'register',
            8,
            60 * 60 * 1000
        )
    ) {
        return res.status(429).json({
            success: false,
            message: 'تم تجاوز عدد المحاولات. حاول بعد ساعة.'
        });
    }

    const fullName =
        String(req.body.fullName || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (fullName.length < 2 || fullName.length > 80) {
        return res.status(400).json({
            success: false,
            message: 'أدخل اسمًا صحيحًا من حرفين على الأقل.'
        });
    }

    if (!validEmail(email)) {
        return res.status(400).json({
            success: false,
            message: 'أدخل بريدًا إلكترونيًا صحيحًا.'
        });
    }

    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({
            success: false,
            message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.'
        });
    }

    try {
        await connectToDatabase();

        const existing = await User.findOne({
            email
        }).select(
            '+passwordSalt +passwordHash +verificationTokenHash +verificationTokenExpiresAt'
        );

        if (existing?.emailVerifiedAt) {
            return res.status(409).json({
                success: false,
                message: 'هذا البريد مسجل بالفعل. استخدم تسجيل الدخول.'
            });
        }

        const passwordRecord =
            await createPasswordRecord(password);
        const verification = createActionToken();
        const verificationExpiresAt =
            new Date(Date.now() + 24 * 60 * 60 * 1000);
        let user;

        if (existing) {
            existing.fullName = fullName;
            existing.passwordSalt =
                passwordRecord.salt;
            existing.passwordHash =
                passwordRecord.hash;
            existing.verificationTokenHash =
                verification.hash;
            existing.verificationTokenExpiresAt =
                verificationExpiresAt;
            user = await existing.save();
        } else {
            user = await User.create({
                fullName,
                email,
                passwordSalt:
                    passwordRecord.salt,
                passwordHash:
                    passwordRecord.hash,
                verificationTokenHash:
                    verification.hash,
                verificationTokenExpiresAt:
                    verificationExpiresAt
            });
        }

        await sendVerificationEmail(
            user,
            verification.token
        );
        void maybeAlertDatabaseStorage();

        return res.status(201).json({
            success: true,
            message: 'تم إنشاء الحساب. افتح بريدك واضغط رابط التحقق.'
        });
    } catch (error) {
        console.error('تعذر إنشاء حساب العميل:', error);

        return res.status(502).json({
            success: false,
            message: 'تعذر إرسال رسالة التحقق حاليًا. حاول مرة أخرى بعد قليل.'
        });
    }
});

app.get('/api/auth/verify-email', async (req, res) => {
    if (!customerAccountsEnabled()) {
        return res.redirect(
            303,
            '/?account=unavailable'
        );
    }

    const token = String(req.query.token || '');

    if (!token) {
        return res.redirect(
            303,
            '/?account=invalid'
        );
    }

    try {
        await connectToDatabase();

        const user = await User.findOne({
            verificationTokenHash:
                actionTokenHash(token),
            verificationTokenExpiresAt: {
                $gt: new Date()
            }
        }).select(
            '+verificationTokenHash +verificationTokenExpiresAt'
        );

        if (!user) {
            return res.redirect(
                303,
                '/?account=invalid'
            );
        }

        user.emailVerifiedAt = new Date();
        user.verificationTokenHash = '';
        user.verificationTokenExpiresAt = null;
        await user.save();

        setSessionCookie(res, user);

        return res.redirect(
            303,
            '/?account=verified'
        );
    } catch (error) {
        console.error('تعذر تأكيد بريد العميل:', error);

        return res.redirect(
            303,
            '/?account=error'
        );
    }
});

app.post('/api/auth/login', async (req, res) => {
    if (!customerAccountsEnabled()) {
        return res.status(503).json({
            success: false,
            message: 'تسجيل الدخول غير متاح مؤقتًا.'
        });
    }

    if (
        authRateLimited(
            req,
            'login',
            12,
            15 * 60 * 1000
        )
    ) {
        return res.status(429).json({
            success: false,
            message: 'محاولات كثيرة. حاول بعد 15 دقيقة.'
        });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!validEmail(email) || !password) {
        return res.status(400).json({
            success: false,
            message: 'أدخل البريد وكلمة المرور.'
        });
    }

    try {
        await connectToDatabase();

        const user = await User.findOne({
            email
        }).select('+passwordSalt +passwordHash');

        if (
            !user ||
            !await passwordMatches(
                password,
                user.passwordSalt,
                user.passwordHash
            )
        ) {
            return res.status(401).json({
                success: false,
                message: 'البريد أو كلمة المرور غير صحيحة.'
            });
        }

        if (!user.emailVerifiedAt) {
            return res.status(403).json({
                success: false,
                message: 'أكد بريدك الإلكتروني أولًا من الرسالة المرسلة إليك.'
            });
        }

        setSessionCookie(res, user);

        return res.json({
            success: true,
            user: publicUser(user)
        });
    } catch (error) {
        console.error('تعذر تسجيل دخول العميل:', error);

        return res.status(500).json({
            success: false,
            message: 'تعذر تسجيل الدخول حاليًا.'
        });
    }
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);

    res.json({
        success: true
    });
});

app.post('/api/auth/forgot-password', async (req, res) => {
    if (
        !customerAccountsEnabled() ||
        !emailServiceConfigured()
    ) {
        return res.status(503).json({
            success: false,
            message: 'استعادة كلمة المرور غير متاحة مؤقتًا.'
        });
    }

    if (
        authRateLimited(
            req,
            'forgot',
            6,
            60 * 60 * 1000
        )
    ) {
        return res.status(429).json({
            success: false,
            message: 'تم تجاوز عدد المحاولات. حاول بعد ساعة.'
        });
    }

    const email = normalizeEmail(req.body.email);

    if (!validEmail(email)) {
        return res.status(400).json({
            success: false,
            message: 'أدخل بريدًا إلكترونيًا صحيحًا.'
        });
    }

    const genericResponse = {
        success: true,
        message: 'إذا كان البريد مسجلًا فستصلك رسالة الاستعادة خلال دقائق.'
    };

    try {
        await connectToDatabase();

        const user = await User.findOne({
            email,
            emailVerifiedAt: {
                $ne: null
            }
        }).select(
            '+resetTokenHash +resetTokenExpiresAt'
        );

        if (!user) {
            return res.json(genericResponse);
        }

        const reset = createActionToken();
        user.resetTokenHash = reset.hash;
        user.resetTokenExpiresAt =
            new Date(Date.now() + 60 * 60 * 1000);
        await user.save();

        await sendPasswordResetEmail(
            user,
            reset.token
        );

        return res.json(genericResponse);
    } catch (error) {
        console.error('تعذر إرسال استعادة كلمة المرور:', error);

        return res.status(502).json({
            success: false,
            message: 'تعذر إرسال رسالة الاستعادة حاليًا.'
        });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    if (!customerAccountsEnabled()) {
        return res.status(503).json({
            success: false,
            message: 'استعادة كلمة المرور غير متاحة مؤقتًا.'
        });
    }

    const token = String(req.body.token || '');
    const password = String(req.body.password || '');

    if (!token) {
        return res.status(400).json({
            success: false,
            message: 'رابط الاستعادة غير صالح.'
        });
    }

    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({
            success: false,
            message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.'
        });
    }

    try {
        await connectToDatabase();

        const user = await User.findOne({
            resetTokenHash:
                actionTokenHash(token),
            resetTokenExpiresAt: {
                $gt: new Date()
            }
        }).select(
            '+passwordSalt +passwordHash +resetTokenHash +resetTokenExpiresAt'
        );

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'رابط الاستعادة منتهي أو غير صالح.'
            });
        }

        const passwordRecord =
            await createPasswordRecord(password);
        user.passwordSalt = passwordRecord.salt;
        user.passwordHash = passwordRecord.hash;
        user.resetTokenHash = '';
        user.resetTokenExpiresAt = null;
        user.sessionVersion =
            number(user.sessionVersion) + 1;
        await user.save();

        setSessionCookie(res, user);

        return res.json({
            success: true,
            user: publicUser(user),
            message: 'تم تغيير كلمة المرور وتسجيل دخولك.'
        });
    } catch (error) {
        console.error('تعذر تغيير كلمة المرور:', error);

        return res.status(500).json({
            success: false,
            message: 'تعذر تغيير كلمة المرور حاليًا.'
        });
    }
});

app.get('/api/account/shipments', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');

    if (!customerAccountsEnabled()) {
        return res.status(503).json({
            success: false,
            message: 'لوحة الحساب غير متاحة مؤقتًا.'
        });
    }

    try {
        const user = await authenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'سجّل الدخول لعرض بوالصك.'
            });
        }

        const shipments = await Shipment.find({
            userId: user._id
        })
            .sort({
                createdAt: -1
            })
            .limit(100)
            .lean();

        return res.json({
            success: true,
            shipments: shipments.map((shipment) => ({
                id: String(shipment._id),
                orderId: shipment.otoOrderId || '',
                carrier: shipment.carrier,
                fromCity: shipment.fromCity,
                toCity: shipment.toCity,
                weight: shipment.weight,
                price: shipment.price,
                deliveryTime: shipment.deliveryTime,
                trackingNumber:
                    shipment.trackingNumber || '',
                emailDeliveryStatus:
                    shipment.emailDeliveryStatus || 'skipped',
                createdAt: shipment.createdAt,
                labelUrl: shipment.otoOrderId
                    ? `/api/shipment-label?orderId=${encodeURIComponent(shipment.otoOrderId)}`
                    : ''
            }))
        });
    } catch (error) {
        console.error('تعذر تحميل بوالص العميل:', error);

        return res.status(500).json({
            success: false,
            message: 'تعذر تحميل البوالص حاليًا.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| إحصائيات العدادات
|--------------------------------------------------------------------------
*/

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

        await connectToDatabase();
        await initializePlatformStats();

        const stats =
            await PlatformStat.findById('global').lean();
        const avgCost =
            number(stats?.priceCount) > 0
                ? roundMoney(
                    number(stats.priceSum) /
                    number(stats.priceCount)
                )
                : 0;
        const maxCost =
            roundMoney(stats?.maxCost || 0);

        void maybeAlertDatabaseStorage();

        res.json({
            success: true,
            totalOperations:
                number(stats?.totalOperations),
            avgCost,
            maxCost
        });
    } catch (error) {
        console.error('خطأ في جلب الإحصائيات:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر جلب الإحصائيات حاليًا.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| استعلام أسعار الشحن
|--------------------------------------------------------------------------
*/

app.post('/api/shipping-rates', async (req, res) => {
    const {
        origin_city,
        destination_city,
        weight,
        boxLength = 30,
        boxWidth = 30,
        boxHeight = 30
    } = req.body;

    if (!origin_city || !destination_city || number(weight) <= 0) {
        return res.status(400).json({
            success: false,
            message: 'أدخل مدينتي الإرسال والوصول والوزن.'
        });
    }

    if (
        number(boxLength) <= 0 ||
        number(boxWidth) <= 0 ||
        number(boxHeight) <= 0
    ) {
        return res.status(400).json({
            success: false,
            message: 'أدخل أبعاد الشحنة بشكل صحيح.'
        });
    }

    try {
        const providerResult = await shippingRequest(
            'checkOTODeliveryFee',
            quotePayload(
                origin_city.trim(),
                destination_city.trim(),
                weight,
                boxLength,
                boxWidth,
                boxHeight
            )
        );

        const companies = getDeliveryCompanies(providerResult);

        const rates = companies
            .filter(
                (company) =>
                    company.deliveryOptionId &&
                    Number.isFinite(number(company.price, NaN))
            )
            .map((company) => ({
                carrier: getCarrierDisplayName(company),
                serviceMode: getDeliveryServiceLabel(company),
                price: customerPrice(company.price, weight),
                deliveryTime: cleanPublicText(
                    company.avgDeliveryTime ||
                    company.estimatedDeliveryTime ||
                    'حسب شركة الشحن'
                ),
                deliveryOptionId: String(company.deliveryOptionId)
            }))
            .sort((first, second) => first.price - second.price);

        if (!rates.length) {
            return res.status(422).json({
                success: false,
                message: 'لا توجد شركات شحن متاحة لهذا المسار حاليًا.'
            });
        }

        try {
            await connectToDatabase();

            await recordSearchStatistics(rates);

            await SearchLog.create({
                fromCity: origin_city.trim(),
                toCity: destination_city.trim(),
                weight: number(weight),
                boxLength: number(boxLength),
                boxWidth: number(boxWidth),
                boxHeight: number(boxHeight),
                prices: rates.map((rate) => ({
                    carrier: rate.carrier,
                    price: rate.price,
                    deliveryTime: rate.deliveryTime
                }))
            });

            void maybeAlertDatabaseStorage();
        } catch (saveError) {
            console.error('تعذر حفظ سجل الاستعلام:', saveError);
        }

        res.json({
            success: true,
            rates
        });
    } catch (error) {
        console.error('خطأ أثناء جلب أسعار الشحن:', error.message);
        res.status(502).json({
            success: false,
            message: 'تعذر جلب أسعار الشحن حاليًا. حاول مرة أخرى بعد قليل.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| التحويل البنكي ثم إنشاء الشحنة
|--------------------------------------------------------------------------
*/

function bankTransferPublicState(
    payment,
    shipment = null,
    { admin = false } = {}
) {
    const state = {
        success: true,
        orderNumber: payment.orderNumber,
        status: payment.status,
        amount: payment.amount,
        carrier: payment.carrier,
        deliveryTime: payment.deliveryTime || '',
        paymentMethod: 'bank_transfer',
        bank: {
            bankName: BANK_TRANSFER_BANK_NAME,
            beneficiaryName: BANK_TRANSFER_BENEFICIARY_NAME,
            iban: formatIban(BANK_TRANSFER_IBAN)
        },
        receiptUploaded: Boolean(payment.receiptObjectKey),
        submittedAt: payment.submittedAt || null,
        reviewedAt: payment.reviewedAt || null,
        canUploadReceipt:
            ['awaiting_transfer', 'rejected'].includes(payment.status),
        shipment: shipment
            ? {
                orderId: shipment.otoOrderId,
                shipmentId: shipment.otoShipmentId,
                trackingNumber: shipment.trackingNumber,
                carrier: shipment.carrier,
                finalPrice: shipment.price,
                emailSent:
                    shipment.emailDeliveryStatus === 'sent',
                labelUrl: shipment.otoOrderId
                    ? `/api/shipment-label?orderId=${encodeURIComponent(shipment.otoOrderId)}`
                    : ''
            }
            : null
    };

    if (payment.status === 'rejected') {
        state.reviewNote = payment.reviewNote || '';
    }

    if (
        ['issuance_failed', 'paid_hold'].includes(payment.status)
    ) {
        state.failureCode = payment.failureReason || '';
    }

    if (admin) {
        state.customerEmail = payment.customerEmail;
        state.createdAt = payment.createdAt || null;
        state.reviewNote = payment.reviewNote || '';
        state.issuanceAttempts = number(payment.issuanceAttempts);
        state.receiptUrl = payment.receiptObjectKey
            ? `/api/admin/bank-transfers/${encodeURIComponent(payment.orderNumber)}/receipt`
            : '';
        state.canRetryIssuance =
            ['issuance_failed', 'paid_hold'].includes(payment.status);
    }

    return state;
}

async function createPaidShipment(payment) {
    if (payment.status === 'shipment_created') {
        return Payment.findById(payment._id);
    }

    const existingShipment = await Shipment.findOne({
        otoOrderId: payment.orderNumber
    });

    if (existingShipment) {
        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    status: 'shipment_created',
                    shipmentId: existingShipment._id,
                    fulfilledAt:
                        payment.fulfilledAt || new Date(),
                    failureReason: ''
                },
                $unset: {
                    shipmentPayload: 1
                }
            }
        );

        return Payment.findById(payment._id);
    }

    if (!ALLOW_LIVE_SHIPMENTS) {
        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    status: 'paid_hold',
                    paidAt: payment.paidAt || new Date(),
                    failureReason:
                        'LIVE_SHIPMENTS_DISABLED'
                }
            }
        );

        return Payment.findById(payment._id);
    }

    const locked = await Payment.findOneAndUpdate(
        {
            _id: payment._id,
            status: {
                $in: [
                    'pending_review',
                    'issuance_failed',
                    'paid_hold'
                ]
            }
        },
        {
            $set: {
                status: 'processing',
                paidAt: payment.paidAt || new Date(),
                lastIssuanceAt: new Date(),
                failureReason: ''
            },
            $inc: {
                issuanceAttempts: 1
            }
        },
        {
            new: true
        }
    ).select('+shipmentPayload');

    if (!locked) {
        return Payment.findById(payment._id);
    }

    try {
        const shipmentCreatedDuringLock = await Shipment.findOne({
            otoOrderId: locked.orderNumber
        });

        if (shipmentCreatedDuringLock) {
            await Payment.updateOne(
                { _id: locked._id, status: 'processing' },
                {
                    $set: {
                        status: 'shipment_created',
                        shipmentId: shipmentCreatedDuringLock._id,
                        fulfilledAt: new Date(),
                        failureReason: ''
                    },
                    $unset: {
                        shipmentPayload: 1
                    }
                }
            );

            return Payment.findById(locked._id);
        }

        const payload = locked.shipmentPayload;
        const body = payload?.body;
        const senderAddress = payload?.senderAddress;
        const receiverAddress = payload?.receiverAddress;

        if (!body || !senderAddress || !receiverAddress) {
            throw new Error('PAYMENT_PAYLOAD_MISSING');
        }

        const orderId = locked.orderNumber;
        let providerOrder = await getProviderOrderDetails(orderId);
        let providerSnapshot = providerShipmentSnapshot(providerOrder);
        const hasProviderCheckpoint = Boolean(
            locked.providerOrderCreatedAt ||
            locked.providerShipmentRequestedAt
        );

        if (!providerOrder && hasProviderCheckpoint) {
            if (!shippingCheckpointIsPastGrace(locked)) {
                throw new Error('SHIPMENT_STATUS_UNCERTAIN');
            }

            // أكّد orderDetails بعد مهلة كافية أن الطلب غير موجود لدى المزود.
            // لذلك يمكن إزالة نقاط التحقق القديمة وإعادة المحاولة دون خطر التكرار.
            await Payment.updateOne(
                { _id: locked._id, status: 'processing' },
                {
                    $unset: {
                        providerOrderCreatedAt: 1,
                        providerShipmentRequestedAt: 1,
                        providerShipmentCreatedAt: 1,
                        providerShipmentId: 1,
                        providerTrackingNumber: 1,
                        providerLabelUrl: 1
                    }
                }
            );

            locked.providerOrderCreatedAt = undefined;
            locked.providerShipmentRequestedAt = undefined;
            locked.providerShipmentCreatedAt = undefined;
            locked.providerShipmentId = '';
            locked.providerTrackingNumber = '';
            locked.providerLabelUrl = '';
            providerSnapshot = providerShipmentSnapshot(null);
        }

        let providerOrderCreated = Boolean(
            locked.providerOrderCreatedAt || providerOrder
        );
        let providerOrderPayload;

        async function currentProviderOrderPayload(forceNewPickup = false) {
            if (!providerOrderPayload || forceNewPickup) {
                const pickupLocationCode =
                    await ensureSenderPickupLocation(
                        body,
                        senderAddress,
                        { forceNew: forceNewPickup }
                    );

                providerOrderPayload = buildProviderOrder(
                    locked,
                    body,
                    receiverAddress,
                    pickupLocationCode
                );
            }

            return providerOrderPayload;
        }

        if (!providerOrderCreated) {
            await assertSufficientShippingBalance(locked.providerCost);
            const order = await currentProviderOrderPayload();

            try {
                const createdOrder = await shippingRequest(
                    'createOrder',
                    {
                        ...order,
                        createShipment: false
                    }
                );
                providerOrderCreated = true;
                providerOrder =
                    await waitForProviderOrder(orderId) ||
                    createdOrder;
            } catch (createOrderError) {
                providerOrder = await waitForProviderOrder(orderId);

                if (!providerOrder) {
                    throw createOrderError;
                }

                providerOrderCreated = true;
            }

            providerSnapshot = providerShipmentSnapshot(providerOrder);
            await Payment.updateOne(
                { _id: locked._id, status: 'processing' },
                {
                    $set: {
                        providerOrderCreatedAt: new Date(),
                        providerShipmentId:
                            providerSnapshot.shipmentId || '',
                        providerTrackingNumber:
                            providerSnapshot.trackingNumber || '',
                        providerLabelUrl:
                            providerSnapshot.labelUrl || ''
                    }
                }
            );
        }

        let providerShipmentId =
            locked.providerShipmentId || providerSnapshot.shipmentId || '';
        let trackingNumber =
            locked.providerTrackingNumber ||
            providerSnapshot.trackingNumber ||
            providerShipmentId ||
            '';
        let providerLabelUrl =
            locked.providerLabelUrl || providerSnapshot.labelUrl || '';

        if (!providerLabelUrl) {
            providerLabelUrl = await getShipmentLabel(orderId);
        }

        const providerShipmentCreated = Boolean(
            locked.providerShipmentCreatedAt ||
            providerShipmentId ||
            trackingNumber ||
            providerLabelUrl
        );

        if (!providerShipmentCreated) {
            if (locked.providerShipmentRequestedAt) {
                throw new Error('SHIPMENT_STATUS_UNCERTAIN');
            }

            await assertSufficientShippingBalance(locked.providerCost);

            // OTO permits changing the pickup location before shipment
            // creation. Refresh it here so retries repair an order that
            // still points at an inactive or deleted pickup location.
            await shippingRequest(
                'updateOrder',
                await currentProviderOrderPayload()
            );

            const shipmentRequestedAt = new Date();

            await Payment.updateOne(
                { _id: locked._id, status: 'processing' },
                {
                    $set: {
                        providerShipmentRequestedAt: shipmentRequestedAt
                    }
                }
            );

            try {
                const shipmentResult = await createShipmentAfterAssignment(
                    orderId,
                    locked.deliveryOptionId
                );
                const shipmentSnapshot = providerShipmentSnapshot(
                    shipmentResult
                );

                providerShipmentId =
                    shipmentSnapshot.shipmentId || providerShipmentId;
                trackingNumber =
                    shipmentSnapshot.trackingNumber ||
                    trackingNumber ||
                    providerShipmentId;
                providerLabelUrl =
                    shipmentSnapshot.labelUrl || providerLabelUrl;
            } catch (initialShipmentError) {
                let createShipmentError = initialShipmentError;

                // Some OTO accounts return an inactive pickup location in
                // getPickupLocationList without a dependable status flag. If
                // createShipment identifies that case, create a fresh active
                // replacement, update the same order, and retry. This never
                // creates a second order and the rejected 400 did not create
                // a successful shipment charge.
                if (pickupLocationProviderError(createShipmentError)) {
                    try {
                        await shippingRequest(
                            'updateOrder',
                            await currentProviderOrderPayload(true)
                        );

                        const repairedShipment =
                            await createShipmentAfterAssignment(
                                orderId,
                                locked.deliveryOptionId,
                                { retryPickupLocation: true }
                            );
                        const repairedSnapshot =
                            providerShipmentSnapshot(repairedShipment);

                        providerShipmentId =
                            repairedSnapshot.shipmentId ||
                            providerShipmentId;
                        trackingNumber =
                            repairedSnapshot.trackingNumber ||
                            trackingNumber ||
                            providerShipmentId;
                        providerLabelUrl =
                            repairedSnapshot.labelUrl ||
                            providerLabelUrl;
                        createShipmentError = null;
                    } catch (repairError) {
                        createShipmentError = repairError;
                    }
                }

                if (createShipmentError) {
                    const currentOrder =
                        await getProviderOrderDetails(orderId);
                    const currentSnapshot =
                        providerShipmentSnapshot(currentOrder);

                    providerShipmentId =
                        currentSnapshot.shipmentId || providerShipmentId;
                    trackingNumber =
                        currentSnapshot.trackingNumber || trackingNumber;
                    providerLabelUrl =
                        currentSnapshot.labelUrl ||
                        await getShipmentLabel(orderId);

                    if (
                        !providerShipmentId &&
                        !trackingNumber &&
                        !providerLabelUrl
                    ) {
                        if (!shippingProviderOutcomeIsAmbiguous(
                            createShipmentError
                        )) {
                            await Payment.updateOne(
                                { _id: locked._id, status: 'processing' },
                                {
                                    $unset: {
                                        providerShipmentRequestedAt: 1
                                    }
                                }
                            );
                            throw createShipmentError;
                        }

                        throw new Error('SHIPMENT_STATUS_UNCERTAIN');
                    }
                }
            }

            await Payment.updateOne(
                { _id: locked._id, status: 'processing' },
                {
                    $set: {
                        providerShipmentCreatedAt: new Date(),
                        providerShipmentId,
                        providerTrackingNumber: trackingNumber,
                        providerLabelUrl
                    }
                }
            );
        }

        if (!providerLabelUrl) {
            providerLabelUrl = await getShipmentLabel(orderId);
        }

        if (!providerLabelUrl) {
            throw new Error('SHIPMENT_LABEL_NOT_READY');
        }

        await Payment.updateOne(
            { _id: locked._id, status: 'processing' },
            {
                $set: {
                    providerOrderCreatedAt:
                        locked.providerOrderCreatedAt || new Date(),
                    providerShipmentCreatedAt:
                        locked.providerShipmentCreatedAt || new Date(),
                    providerShipmentId,
                    providerTrackingNumber: trackingNumber,
                    providerLabelUrl
                }
            }
        );
        let attachment = null;
        let labelStorage = {};

        if (providerLabelUrl) {
            try {
                attachment = await labelAttachment(
                    providerLabelUrl,
                    orderId
                );
            } catch (labelError) {
                console.warn(
                    'تعذر تجهيز ملف البوليصة:',
                    labelError.message
                );
            }
        }

        if (attachment && r2StorageConfigured()) {
            const objectKey = shipmentLabelObjectKey(
                locked.userId,
                orderId
            );

            try {
                await saveLabelToR2({
                    objectKey,
                    content: attachment.content,
                    contentType: attachment.contentType
                });

                labelStorage = {
                    labelObjectKey: objectKey,
                    labelContentType: attachment.contentType,
                    labelSize: attachment.content.length,
                    labelStoredAt: new Date()
                };
            } catch (storageError) {
                console.error(
                    'تعذر حفظ البوليصة في R2:',
                    storageError.message
                );
            }
        }

        const savedShipment = await Shipment.create({
            userId: locked.userId,
            customerEmail: locked.customerEmail,
            contentsDescription:
                String(body.contentsDescription || '').trim(),
            emailDeliveryStatus:
                emailServiceConfigured()
                    ? 'pending'
                    : 'skipped',
            fromCity: body.senderCity,
            toCity: body.receiverCity,
            weight: number(body.weight),
            carrier: locked.carrier,
            price: locked.amount,
            deliveryTime: locked.deliveryTime,
            otoOrderId: orderId,
            otoShipmentId: providerShipmentId,
            trackingNumber,
            labelUrl: providerLabelUrl,
            ...labelStorage
        });

        if (emailServiceConfigured()) {
            try {
                const emailResult = await sendShipmentCreatedEmail({
                    user: {
                        email: locked.customerEmail,
                        fullName:
                            String(body.receiverName || 'عميل SUMSN')
                                .trim()
                    },
                    carrierName: locked.carrier,
                    orderId,
                    trackingNumber,
                    finalPrice: locked.amount,
                    attachment
                });

                savedShipment.emailDeliveryStatus = 'sent';
                savedShipment.emailMessageId = emailResult.id || '';
                savedShipment.emailSentAt = new Date();
                await savedShipment.save();
            } catch (emailError) {
                console.error(
                    'تعذر إرسال بريد البوليصة:',
                    emailError.message
                );
                savedShipment.emailDeliveryStatus = 'failed';
                await savedShipment.save();
            }
        }

        await Payment.updateOne(
            {
                _id: locked._id,
                status: 'processing'
            },
            {
                $set: {
                    status: 'shipment_created',
                    shipmentId: savedShipment._id,
                    fulfilledAt: new Date(),
                    failureReason: ''
                },
                $unset: {
                    shipmentPayload: 1
                }
            }
        );

        void maybeAlertDatabaseStorage();

        return Payment.findById(locked._id);
    } catch (error) {
        console.error('تعذر إصدار شحنة التحويل المعتمد:', error);

        await Payment.updateOne(
            {
                _id: locked._id,
                status: 'processing'
            },
            {
                $set: {
                    status: 'issuance_failed',
                    failureReason:
                        String(error.message || 'FULFILLMENT_ERROR')
                            .slice(0, 200)
                }
            }
        );

        throw error;
    }
}

async function currentShipmentForPayment(payment) {
    if (!payment.shipmentId) {
        return null;
    }

    return Shipment.findById(payment.shipmentId);
}

app.post('/api/national-address', async (req, res) => {
    if (!customerAccountsEnabled()) {
        return res.status(503).json({
            success: false,
            message: 'خدمة حسابات العملاء غير مفعّلة حاليًا.'
        });
    }

    let user = null;

    try {
        user = await authenticatedUser(req);
    } catch (error) {
        console.error('تعذر التحقق من جلسة العميل:', error);

        return res.status(500).json({
            success: false,
            message: 'تعذر التحقق من الحساب حاليًا.'
        });
    }

    if (!user) {
        return res.status(401).json({
            success: false,
            message: 'سجّل الدخول أولًا للتحقق من العنوان المختصر.'
        });
    }

    if (
        authRateLimited(
            req,
            'national-address',
            20,
            15 * 60 * 1000
        )
    ) {
        return res.status(429).json({
            success: false,
            message: 'تم تجاوز عدد محاولات التحقق. حاول بعد قليل.'
        });
    }

    const shortCode = String(
        req.body?.shortCode || ''
    ).trim().toUpperCase();

    if (!/^[A-Z]{4}[0-9]{4}$/.test(shortCode)) {
        return res.status(400).json({
            success: false,
            message: 'صيغة العنوان المختصر غير صحيحة.'
        });
    }

    try {
        const address = await getNationalAddress(shortCode);

        return res.json({
            success: true,
            address: {
                shortCode: address.shortCode,
                city: address.city,
                district: address.district,
                street: address.street,
                buildingNo: address.buildingNo,
                secondaryNumber: address.secondaryNumber,
                postcode: address.postcode
            }
        });
    } catch (error) {
        if (error.message === 'INVALID_NATIONAL_ADDRESS') {
            return res.status(400).json({
                success: false,
                message: 'تعذر العثور على عنوان وطني مكتمل لهذا الرمز.'
            });
        }

        console.error('تعذر التحقق من العنوان المختصر:', error);

        return res.status(502).json({
            success: false,
            message: 'تعذر التحقق من العنوان المختصر حاليًا.'
        });
    }
});

app.post('/api/create-shipment', async (req, res) => {
    let shipmentUser = null;

    if (customerAccountsEnabled()) {
        try {
            shipmentUser = await authenticatedUser(req);
        } catch (error) {
            console.error('تعذر التحقق من جلسة العميل:', error);

            return res.status(500).json({
                success: false,
                message: 'تعذر التحقق من الحساب حاليًا.'
            });
        }

        if (!shipmentUser) {
            return res.status(401).json({
                success: false,
                message: 'سجّل الدخول أولًا لإنشاء طلب التحويل وحفظ بوليصتك.'
            });
        }

        req.body.email = shipmentUser.email;
    }

    const required = [
        'email',
        'contentsDescription',
        'senderName',
        'senderCity',
        'senderPhone',
        'senderShortAddressCode',
        'receiverName',
        'receiverCity',
        'receiverPhone',
        'receiverShortAddressCode',
        'deliveryOptionId',
        'weight',
        'boxLength',
        'boxWidth',
        'boxHeight',
        'requestId'
    ];
    const missing = required.filter((field) => !req.body[field]);

    if (missing.length) {
        return res.status(400).json({
            success: false,
            message: 'يرجى تعبئة جميع بيانات الشحنة المطلوبة.'
        });
    }

    if (!ALLOW_LIVE_SHIPMENTS) {
        return res.status(403).json({
            success: false,
            message: 'إنشاء طلبات الشحن غير متاح مؤقتًا أثناء الاختبار.'
        });
    }

    if (!bankTransferConfigured()) {
        return res.status(503).json({
            success: false,
            message: 'إعدادات التحويل البنكي غير مكتملة حاليًا.'
        });
    }

    if (
        LIVE_SHIPMENT_TEST_EMAIL &&
        normalizeEmail(req.body.email) !==
            LIVE_SHIPMENT_TEST_EMAIL
    ) {
        return res.status(403).json({
            success: false,
            message: 'إنشاء طلبات الشحن متاح حاليًا لحساب الاختبار فقط.'
        });
    }

    const body = {
        ...req.body,
        email: normalizeEmail(req.body.email),
        contentsDescription:
            String(req.body.contentsDescription || '').trim(),
        senderName: String(req.body.senderName || '').trim(),
        senderCity: String(req.body.senderCity || '').trim(),
        senderPhone: String(req.body.senderPhone || '').trim(),
        senderShortAddressCode:
            String(req.body.senderShortAddressCode || '')
                .trim()
                .toUpperCase(),
        receiverName: String(req.body.receiverName || '').trim(),
        receiverCity: String(req.body.receiverCity || '').trim(),
        receiverPhone: String(req.body.receiverPhone || '').trim(),
        receiverShortAddressCode:
            String(req.body.receiverShortAddressCode || '')
                .trim()
                .toUpperCase(),
        requestId:
            String(req.body.requestId || '')
                .replace(/[^A-Za-z0-9-]/g, '')
                .slice(0, 64),
        weight: number(req.body.weight),
        boxLength: number(req.body.boxLength),
        boxWidth: number(req.body.boxWidth),
        boxHeight: number(req.body.boxHeight)
    };
    const shortAddressPattern = /^[A-Z]{4}[0-9]{4}$/;

    if (
        !validEmail(body.email) ||
        !shortAddressPattern.test(body.senderShortAddressCode) ||
        !shortAddressPattern.test(body.receiverShortAddressCode) ||
        body.weight <= 0 ||
        body.boxLength <= 0 ||
        body.boxWidth <= 0 ||
        body.boxHeight <= 0 ||
        !body.requestId
    ) {
        return res.status(400).json({
            success: false,
            message: 'تحقق من البريد والعنوانين المختصرين والوزن والأبعاد.'
        });
    }

    const identity =
        shipmentUser?._id ||
        body.email;
    const orderSuffix = crypto
        .createHash('sha256')
        .update(`${identity}:${body.requestId}`)
        .digest('hex')
        .slice(0, 16)
        .toUpperCase();
    const orderNumber = `SUMSN-${orderSuffix}`;

    try {
        await connectToDatabase();

        const existing = await Payment.findOne({
            orderNumber,
            userId: shipmentUser?._id || null
        });

        if (existing) {
            if (existing.status === 'shipment_created') {
                const shipment =
                    await currentShipmentForPayment(existing);

                return res.json(
                    bankTransferPublicState(existing, shipment)
                );
            }

            if (
                ['creating', 'pending', 'failed', 'canceled', 'manual_review']
                    .includes(existing.status)
            ) {
                existing.status = 'awaiting_transfer';
                existing.paymentMethod = 'bank_transfer';
                existing.failureReason = '';
                await existing.save();
            }

            if (
                [
                    'awaiting_transfer',
                    'rejected',
                    'pending_review',
                    'processing',
                    'issuance_failed',
                    'paid_hold'
                ].includes(existing.status)
            ) {
                return res.json({
                    ...bankTransferPublicState(existing),
                    bankTransferRequired: true,
                    bankTransferUrl:
                        `/bank-transfer.html?orderNumber=${encodeURIComponent(existing.orderNumber)}`
                });
            }

            return res.status(409).json({
                success: false,
                message: 'هذه المحاولة مستخدمة سابقًا. افتح لوحة حسابك لمراجعة حالتها.'
            });
        }

        const [senderAddress, receiverAddress] =
            await Promise.all([
                getNationalAddress(
                    body.senderShortAddressCode
                ),
                getNationalAddress(
                    body.receiverShortAddressCode
                )
            ]);
        body.senderCity = senderAddress.city;
        body.receiverCity = receiverAddress.city;

        const quote = await shippingRequest(
            'checkOTODeliveryFee',
            quotePayload(
                body.senderCity,
                body.receiverCity,
                body.weight,
                body.boxLength,
                body.boxWidth,
                body.boxHeight
            )
        );
        const selected = getDeliveryCompanies(quote).find(
            (company) =>
                String(company.deliveryOptionId) ===
                String(body.deliveryOptionId)
        );

        if (!selected) {
            return res.status(409).json({
                success: false,
                message: 'خيار الشحن تغير. أعد جلب الأسعار واختر من جديد.'
            });
        }

        const providerCost = number(selected.price);
        const finalPrice =
            customerPrice(providerCost, body.weight);
        const carrierName = getCarrierDisplayName(selected);
        const deliveryTime = cleanPublicText(
            selected.avgDeliveryTime ||
            selected.estimatedDeliveryTime ||
            ''
        );
        await assertSufficientShippingBalance(providerCost);

        const payment = await Payment.create({
            userId: shipmentUser?._id || null,
            customerEmail: body.email,
            requestId: body.requestId,
            orderNumber,
            status: 'awaiting_transfer',
            amount: finalPrice,
            providerCost,
            carrier: carrierName,
            deliveryOptionId:
                String(body.deliveryOptionId),
            deliveryTime,
            paymentMethod: 'bank_transfer',
            shipmentPayload: {
                body,
                senderAddress,
                receiverAddress
            }
        });

        res.json({
            ...bankTransferPublicState(payment),
            bankTransferRequired: true,
            bankTransferUrl:
                `/bank-transfer.html?orderNumber=${encodeURIComponent(orderNumber)}`
        });
    } catch (error) {
        console.error('تعذر إنشاء طلب التحويل:', error);

        let message = 'تعذر إنشاء طلب التحويل حاليًا. حاول مرة أخرى.';

        if (error.message === 'INVALID_NATIONAL_ADDRESS') {
            message = 'تعذر التحقق من أحد العنوانين المختصرين.';
        } else if (
            error.message === 'INSUFFICIENT_SHIPPING_BALANCE'
        ) {
            message = 'رصيد حساب الشحن غير كافٍ لإصدار البوليصة.';
        } else if (
            error.message === 'SHIPPING_BALANCE_UNAVAILABLE'
        ) {
            message = 'تعذر التحقق من رصيد حساب الشحن حاليًا؛ لم يُنشأ طلب تحويل.';
        } else if (error.message === 'R2_CONFIGURATION_ERROR') {
            message = 'خدمة حفظ الإيصالات غير جاهزة حاليًا.';
        }

        res.status(502).json({
            success: false,
            message
        });
    }
});

app.get('/api/bank-transfers/:orderNumber', async (req, res) => {
    try {
        const user = await authenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'سجّل الدخول لعرض طلب التحويل.'
            });
        }

        await connectToDatabase();

        const payment = await Payment.findOne({
            orderNumber:
                String(req.params.orderNumber || '').trim(),
            userId: user._id
        });

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'لم يتم العثور على طلب التحويل.'
            });
        }

        const shipment =
            await currentShipmentForPayment(payment);

        res.json(bankTransferPublicState(payment, shipment));
    } catch (error) {
        console.error('تعذر جلب طلب التحويل:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر جلب طلب التحويل حاليًا.'
        });
    }
});

app.post('/api/bank-transfers/:orderNumber/receipt', async (req, res) => {
    if (!sameOriginRequest(req)) {
        return res.status(403).json({
            success: false,
            message: 'تعذر التحقق من مصدر الطلب.'
        });
    }

    try {
        const user = await authenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'سجّل الدخول أولًا لرفع الإيصال.'
            });
        }

        if (authRateLimited(req, 'bank-receipt', 10, 60 * 60 * 1000)) {
            return res.status(429).json({
                success: false,
                message: 'تم تجاوز عدد محاولات الرفع. حاول لاحقًا.'
            });
        }

        await connectToDatabase();

        const orderNumber =
            String(req.params.orderNumber || '').trim();
        const payment = await Payment.findOne({
            orderNumber,
            userId: user._id,
            status: { $in: ['awaiting_transfer', 'rejected'] }
        });

        if (!payment) {
            return res.status(409).json({
                success: false,
                message: 'لا يمكن رفع إيصال لهذا الطلب في حالته الحالية.'
            });
        }

        const receipt = parseReceiptDataUrl(req.body?.receiptDataUrl);
        const objectKey = transferReceiptObjectKey(
            user._id,
            orderNumber,
            receipt.extension
        );

        await saveTransferReceiptToR2({
            objectKey,
            content: receipt.content,
            contentType: receipt.contentType
        });

        const updated = await Payment.findOneAndUpdate(
            {
                _id: payment._id,
                userId: user._id,
                status: { $in: ['awaiting_transfer', 'rejected'] }
            },
            {
                $set: {
                    status: 'pending_review',
                    paymentMethod: 'bank_transfer',
                    receiptObjectKey: objectKey,
                    receiptContentType: receipt.contentType,
                    receiptSize: receipt.content.length,
                    receiptUploadedAt: new Date(),
                    submittedAt: new Date(),
                    reviewNote: '',
                    failureReason: ''
                },
                $unset: {
                    reviewedAt: 1,
                    reviewedBy: 1,
                    paidAt: 1
                }
            },
            { new: true }
        );

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: 'تغيرت حالة الطلب. حدّث الصفحة قبل المحاولة.'
            });
        }

        try {
            await sendTransferSubmittedEmail(updated);
        } catch (emailError) {
            console.error(
                'تعذر إرسال تنبيه التحويل للإدارة:',
                emailError.message
            );
        }

        res.json(bankTransferPublicState(updated));
    } catch (error) {
        console.error('تعذر رفع إيصال التحويل:', error);

        let message = 'تعذر رفع الإيصال حاليًا.';

        if (error.message === 'RECEIPT_TYPE_INVALID') {
            message = 'ارفع الإيصال بصيغة PDF أو PNG أو JPG فقط.';
        } else if (error.message === 'RECEIPT_TOO_LARGE') {
            message = 'حجم الإيصال أكبر من الحد المسموح.';
        } else if (
            ['RECEIPT_EMPTY', 'RECEIPT_CONTENT_INVALID'].includes(error.message)
        ) {
            message = 'ملف الإيصال غير صالح.';
        }

        res.status(400).json({ success: false, message });
    }
});

app.get('/api/admin/bank-transfers', async (req, res) => {
    try {
        const user = await authenticatedUser(req);

        if (!isBankTransferAdmin(user)) {
            return res.status(403).json({
                success: false,
                message: 'هذه الصفحة مخصصة للإدارة.'
            });
        }

        await connectToDatabase();

        const payments = await Payment.find({
            paymentMethod: 'bank_transfer',
            status: {
                $in: [
                    'awaiting_transfer',
                    'pending_review',
                    'rejected',
                    'processing',
                    'issuance_failed',
                    'paid_hold',
                    'shipment_created'
                ]
            }
        })
            .sort({ updatedAt: -1 })
            .limit(100);

        const items = await Promise.all(
            payments.map(async (payment) => {
                const shipment = await currentShipmentForPayment(payment);
                return bankTransferPublicState(
                    payment,
                    shipment,
                    { admin: true }
                );
            })
        );

        res.json({ success: true, items });
    } catch (error) {
        console.error('تعذر جلب تحويلات الإدارة:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر جلب طلبات التحويل حاليًا.'
        });
    }
});

app.get('/api/admin/bank-transfers/:orderNumber/receipt', async (req, res) => {
    try {
        const user = await authenticatedUser(req);

        if (!isBankTransferAdmin(user)) {
            return res.status(403).json({
                success: false,
                message: 'هذه الصفحة مخصصة للإدارة.'
            });
        }

        await connectToDatabase();

        const payment = await Payment.findOne({
            orderNumber: String(req.params.orderNumber || '').trim(),
            paymentMethod: 'bank_transfer'
        });

        if (!payment?.receiptObjectKey) {
            return res.status(404).json({
                success: false,
                message: 'لم يتم العثور على الإيصال.'
            });
        }

        const receipt = await readTransferReceiptFromR2(
            payment.receiptObjectKey
        );

        if (!receipt) {
            return res.status(404).json({
                success: false,
                message: 'لم يتم العثور على الإيصال.'
            });
        }

        const extension =
            receipt.contentType === 'application/pdf'
                ? 'pdf'
                : (receipt.contentType === 'image/png' ? 'png' : 'jpg');

        res.set({
            'Content-Type': receipt.contentType,
            'Content-Length': String(receipt.content.length),
            'Content-Disposition':
                `inline; filename="receipt-${payment.orderNumber}.${extension}"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.send(receipt.content);
    } catch (error) {
        console.error('تعذر فتح إيصال التحويل:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر فتح الإيصال حاليًا.'
        });
    }
});

app.post('/api/admin/bank-transfers/:orderNumber/approve', async (req, res) => {
    if (!sameOriginRequest(req)) {
        return res.status(403).json({
            success: false,
            message: 'تعذر التحقق من مصدر الطلب.'
        });
    }

    if (req.body?.bankDepositConfirmed !== true) {
        return res.status(400).json({
            success: false,
            message:
                'يجب تأكيد وصول المبلغ إلى الحساب البنكي قبل إصدار البوليصة.'
        });
    }

    let payment = null;

    try {
        const user = await authenticatedUser(req);

        if (!isBankTransferAdmin(user)) {
            return res.status(403).json({
                success: false,
                message: 'هذه العملية مخصصة للإدارة.'
            });
        }

        await connectToDatabase();

        const orderNumber =
            String(req.params.orderNumber || '').trim();
        payment = await Payment.findOne({
            orderNumber,
            paymentMethod: 'bank_transfer'
        }).select('+shipmentPayload');

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'لم يتم العثور على الطلب.'
            });
        }

        if (payment.status === 'shipment_created') {
            const shipment = await currentShipmentForPayment(payment);
            return res.json(
                bankTransferPublicState(payment, shipment, { admin: true })
            );
        }

        if (payment.status === 'processing') {
            const lastIssuanceAt = payment.lastIssuanceAt
                ? new Date(payment.lastIssuanceAt).getTime()
                : 0;
            const processingIsFresh =
                lastIssuanceAt > 0 &&
                Date.now() - lastIssuanceAt <
                    BANK_TRANSFER_PROCESSING_TIMEOUT_MS;

            if (processingIsFresh) {
                return res.status(409).json({
                    success: false,
                    message: 'إصدار البوليصة جارٍ بالفعل.'
                });
            }

            const recoveredPayment = await Payment.findOneAndUpdate(
                {
                    _id: payment._id,
                    status: 'processing',
                    lastIssuanceAt: payment.lastIssuanceAt || null
                },
                {
                    $set: {
                        status: 'issuance_failed',
                        failureReason: 'PROCESSING_INTERRUPTED'
                    }
                },
                { new: true }
            ).select('+shipmentPayload');

            if (!recoveredPayment) {
                return res.status(409).json({
                    success: false,
                    message: 'تغيرت حالة الطلب. حدّث الصفحة ثم حاول مجددًا.'
                });
            }

            payment = recoveredPayment;
        }

        if (
            !['pending_review', 'issuance_failed', 'paid_hold']
                .includes(payment.status)
        ) {
            return res.status(409).json({
                success: false,
                message: 'لا يمكن اعتماد الطلب في حالته الحالية.'
            });
        }

        if (payment.status === 'pending_review' && !payment.receiptObjectKey) {
            return res.status(409).json({
                success: false,
                message: 'لا يوجد إيصال مرفوع لهذا الطلب.'
            });
        }

        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    reviewedAt: new Date(),
                    reviewedBy: user._id,
                    reviewNote: '',
                    paidAt: payment.paidAt || new Date()
                }
            }
        );

        payment = await Payment.findById(payment._id)
            .select('+shipmentPayload');
        const result = await createPaidShipment(payment);
        const shipment = await currentShipmentForPayment(result);

        if (result.status !== 'shipment_created') {
            return res.status(409).json({
                ...bankTransferPublicState(result, shipment, { admin: true }),
                success: false,
                message: 'لم تصدر البوليصة بعد. راجع حالة الطلب.'
            });
        }

        res.json(
            bankTransferPublicState(result, shipment, { admin: true })
        );
    } catch (error) {
        console.error('تعذر اعتماد التحويل وإصدار البوليصة:', error);

        let message = 'تم حفظ الاعتماد، لكن تعذر إصدار البوليصة. يمكنك إعادة المحاولة.';

        if (error.message === 'INSUFFICIENT_SHIPPING_BALANCE') {
            message = 'رصيد OTO غير كافٍ. لم تصدر البوليصة؛ اشحن الرصيد ثم أعد المحاولة.';
        } else if (error.message === 'SHIPPING_BALANCE_UNAVAILABLE') {
            message = 'تعذر التحقق من رصيد OTO حاليًا. لم تصدر البوليصة؛ أعد المحاولة لاحقًا.';
        } else if (error.message === 'SHIPMENT_LABEL_NOT_READY') {
            message = 'أنشئت الشحنة لدى شركة الشحن لكن ملف البوليصة لم يجهز بعد. انتظر قليلًا ثم أعد المحاولة؛ لن تُنشأ شحنة مكررة.';
        } else if (error.message === 'SHIPMENT_STATUS_UNCERTAIN') {
            message = 'تم إرسال طلب الإصدار إلى OTO لكن تعذر تأكيد نتيجته. لن يكرر الموقع الطلب تلقائيًا لحمايتك من الخصم المزدوج. راجع الطلب في OTO ثم أعد التحقق.';
        } else if (error.message === 'SHIPPING_PROVIDER_ERROR') {
            const providerStatus = shippingProviderStatus(error);
            const providerMessage = cleanPublicText(error.providerMessage)
                .slice(0, 240);
            const statusText = providerStatus
                ? ` (رمز ${providerStatus})`
                : '';
            const details = providerMessage
                ? `: ${providerMessage}`
                : '.';

            message = `رفض مزود الشحن طلب الإصدار${statusText}${details} لم يُخصم رصيد إصدار ناجح؛ صحح السبب ثم أعد المحاولة.`;
        } else if (!ALLOW_LIVE_SHIPMENTS) {
            message = 'إصدار الشحنات الفعلية متوقف حاليًا. لم تصدر البوليصة.';
        }

        let state = null;

        if (payment?._id) {
            try {
                const latest = await Payment.findById(payment._id);
                const shipment = latest
                    ? await currentShipmentForPayment(latest)
                    : null;
                state = latest
                    ? bankTransferPublicState(latest, shipment, { admin: true })
                    : null;
            } catch (stateError) {
                console.error(
                    'تعذر قراءة حالة التحويل بعد فشل الإصدار:',
                    stateError
                );
            }
        }

        res.status(502).json({
            ...(state || {}),
            success: false,
            message
        });
    }
});

app.post('/api/admin/bank-transfers/:orderNumber/reject', async (req, res) => {
    if (!sameOriginRequest(req)) {
        return res.status(403).json({
            success: false,
            message: 'تعذر التحقق من مصدر الطلب.'
        });
    }

    try {
        const user = await authenticatedUser(req);

        if (!isBankTransferAdmin(user)) {
            return res.status(403).json({
                success: false,
                message: 'هذه العملية مخصصة للإدارة.'
            });
        }

        await connectToDatabase();

        const reviewNote =
            String(req.body?.note || 'تعذر مطابقة التحويل مع الحساب البنكي.')
                .trim()
                .slice(0, 300);
        const payment = await Payment.findOneAndUpdate(
            {
                orderNumber: String(req.params.orderNumber || '').trim(),
                paymentMethod: 'bank_transfer',
                status: 'pending_review'
            },
            {
                $set: {
                    status: 'rejected',
                    reviewedAt: new Date(),
                    reviewedBy: user._id,
                    reviewNote,
                    failureReason: ''
                },
                $unset: { paidAt: 1 }
            },
            { new: true }
        );

        if (!payment) {
            return res.status(409).json({
                success: false,
                message: 'لا يمكن رفض الطلب في حالته الحالية.'
            });
        }

        res.json(bankTransferPublicState(payment, null, { admin: true }));
    } catch (error) {
        console.error('تعذر رفض التحويل:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر تحديث الطلب حاليًا.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| تشغيل السيرفر
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
    console.log(`السيرفر يعمل على http://localhost:${PORT}`);
});
