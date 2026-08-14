const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const crypto = require('crypto');
const {
    GetObjectCommand,
    PutObjectCommand,
    S3Client
} = require('@aws-sdk/client-s3');

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.redirect('/index.html');
});

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
| بوابة الدفع Paylink - الأسرار تبقى في الخادم فقط
|--------------------------------------------------------------------------
*/

const PAYLINK_API_ID =
    String(process.env.PAYLINK_API_ID || '').trim();
const PAYLINK_SECRET_KEY =
    String(process.env.PAYLINK_SECRET_KEY || '').trim();
const PAYLINK_ENVIRONMENT =
    String(process.env.PAYLINK_ENVIRONMENT || 'pilot')
        .trim()
        .toLowerCase() === 'production'
        ? 'production'
        : 'pilot';
const PAYLINK_BASE_URL =
    PAYLINK_ENVIRONMENT === 'production'
        ? 'https://restapi.paylink.sa'
        : 'https://restpilot.paylink.sa';
const PAYLINK_WEBHOOK_SECRET =
    String(process.env.PAYLINK_WEBHOOK_SECRET || '').trim();

let shippingAccessToken = '';
let shippingAccessTokenExpiresAt = 0;
let paylinkAccessToken = '';
let paylinkAccessTokenExpiresAt = 0;
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
    otoOrderId: String,
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
| مدفوعات Paylink
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
        transactionNo: {
            type: String,
            default: '',
            index: true
        },
        status: {
            type: String,
            default: 'creating',
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
        paymentUrl: {
            type: String,
            default: ''
        },
        checkUrl: {
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

function paymentGatewayConfigured() {
    return Boolean(PAYLINK_API_ID && PAYLINK_SECRET_KEY);
}

function r2StorageConfigured() {
    return Boolean(
        R2_ACCESS_KEY_ID &&
        R2_SECRET_ACCESS_KEY &&
        R2_ACCOUNT_ID &&
        R2_BUCKET_NAME
    );
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
        emailVerified: Boolean(user.emailVerifiedAt)
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
        `${PUBLIC_BASE_URL}/index.html?resetToken=${encodeURIComponent(token)}`;

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

        throw new Error('SHIPPING_PROVIDER_ERROR');
    }

    return data;
}

/*
|--------------------------------------------------------------------------
| طلبات Paylink - خادم إلى خادم فقط
|--------------------------------------------------------------------------
*/

async function getPaylinkAccessToken(forceRefresh = false) {
    if (
        !forceRefresh &&
        paylinkAccessToken &&
        Date.now() < paylinkAccessTokenExpiresAt
    ) {
        return paylinkAccessToken;
    }

    if (!paymentGatewayConfigured()) {
        throw new Error('PAYMENT_CONFIGURATION_ERROR');
    }

    const response = await fetch(`${PAYLINK_BASE_URL}/api/auth`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            apiId: PAYLINK_API_ID,
            secretKey: PAYLINK_SECRET_KEY,
            persistToken: false
        })
    });
    const raw = await response.text();
    let data = {};

    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = {};
    }

    if (!response.ok || !data.id_token) {
        const error = new Error('PAYMENT_PROVIDER_ERROR');
        error.providerStatus = response.status;
        error.providerMessage =
            data.detail ||
            data.message ||
            data.title ||
            raw.slice(0, 500);
        throw error;
    }

    paylinkAccessToken = data.id_token;
    paylinkAccessTokenExpiresAt = Date.now() + (25 * 60 * 1000);

    return paylinkAccessToken;
}

async function paylinkRequest(path, { method = 'GET', body } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await getPaylinkAccessToken(attempt > 0);
        const response = await fetch(
            `${PAYLINK_BASE_URL}/api/${path.replace(/^\//, '')}`,
            {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
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
        let data = {};

        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {};
        }

        if (response.status === 401 && attempt === 0) {
            paylinkAccessToken = '';
            paylinkAccessTokenExpiresAt = 0;
            continue;
        }

        if (!response.ok || data.success === false) {
            const error = new Error('PAYMENT_PROVIDER_ERROR');
            error.providerStatus = response.status;
            error.providerMessage =
                data.detail ||
                data.message ||
                data.title ||
                raw.slice(0, 500);
            throw error;
        }

        return data;
    }

    throw new Error('PAYMENT_PROVIDER_ERROR');
}

function paylinkWebhookAuthorized(req) {
    if (!PAYLINK_WEBHOOK_SECRET) {
        return true;
    }

    const expected = Buffer.from(
        `Bearer ${PAYLINK_WEBHOOK_SECRET}`
    );
    const received = Buffer.from(
        String(req.headers.authorization || '')
    );

    return (
        expected.length === received.length &&
        crypto.timingSafeEqual(expected, received)
    );
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
            'buildingNo',
            'buildingNumber',
            'BuildingNumber'
        ])).trim(),
        secondaryNumber: String(firstValue(source, [
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
            'district',
            'districtName',
            'District'
        ])).trim(),
        city: String(firstValue(source, [
            'city',
            'cityName',
            'CityName'
        ])).trim(),
        state: String(firstValue(source, [
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
    try {
        const result = await shippingRequest(
            `getNationalAddressFromShortCode?shortCode=${encodeURIComponent(shortCode)}`,
            undefined,
            'GET'
        );

        return normalizeNationalAddress(result, shortCode);
    } catch (error) {
        if (error.message === 'INVALID_NATIONAL_ADDRESS') {
            throw error;
        }

        const result = await shippingRequest(
            'getNationalAddressFromShortCode',
            { shortCode }
        );

        return normalizeNationalAddress(result, shortCode);
    }
}

const pickupLocationCodeCache = new Set();

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
    const sources = [result, result?.data];

    return sources.flatMap((source) => [
        ...(Array.isArray(source?.warehouses)
            ? source.warehouses
            : []),
        ...(Array.isArray(source?.branches)
            ? source.branches
            : [])
    ]);
}

async function pickupLocationExists(code) {
    const result = await shippingRequest(
        'getPickupLocationList',
        undefined,
        'GET'
    );

    return pickupLocationsFromResponse(result).some(
        (location) =>
            String(location?.code || location?.pickupLocationCode || '')
                .trim()
                .toUpperCase() === code.toUpperCase()
    );
}

async function ensureSenderPickupLocation(body, senderAddress) {
    const code = senderPickupLocationCode(body, senderAddress);

    if (pickupLocationCodeCache.has(code)) {
        return code;
    }

    if (await pickupLocationExists(code)) {
        pickupLocationCodeCache.add(code);
        return code;
    }

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

    try {
        const created = await shippingRequest(
            'createPickupLocation',
            pickupLocation
        );
        const createdCode = String(
            created.pickupLocationCode ||
            created.data?.pickupLocationCode ||
            code
        ).trim();

        pickupLocationCodeCache.add(createdCode);
        return createdCode;
    } catch (error) {
        // إذا وصل طلبان للمرسل نفسه معًا فقد ينجح الإنشاء الأول فقط.
        // نعيد قراءة المواقع حتى نستخدم الكود الذي أُنشئ بدل الفشل.
        if (await pickupLocationExists(code)) {
            pickupLocationCodeCache.add(code);
            return code;
        }

        throw error;
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createShipmentAfterAssignment(orderId, deliveryOptionId) {
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

            if (!message.includes('not assigned yet')) {
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
| الدفع ثم إنشاء الشحنة
|--------------------------------------------------------------------------
*/

function paymentRedirectUrl(state, orderNumber = '') {
    const url = new URL('/index.html', PUBLIC_BASE_URL);
    url.searchParams.set('payment', state);

    if (orderNumber) {
        url.searchParams.set('orderNumber', orderNumber);
    }

    return url.toString();
}

function paymentPublicState(payment, shipment = null) {
    return {
        success: true,
        orderNumber: payment.orderNumber,
        status: payment.status,
        amount: payment.amount,
        carrier: payment.carrier,
        transactionNo: payment.transactionNo,
        paymentMethod: payment.paymentMethod || '',
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
}

async function createPaidShipment(payment) {
    if (payment.status === 'shipment_created') {
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
                $in: ['creating', 'pending', 'paid']
            }
        },
        {
            $set: {
                status: 'processing',
                paidAt: payment.paidAt || new Date(),
                failureReason: ''
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
        const payload = locked.shipmentPayload;
        const body = payload?.body;
        const senderAddress = payload?.senderAddress;
        const receiverAddress = payload?.receiverAddress;

        if (!body || !senderAddress || !receiverAddress) {
            throw new Error('PAYMENT_PAYLOAD_MISSING');
        }

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

        if (
            Number.isFinite(remainingCredit) &&
            remainingFreeShipments <= 0 &&
            remainingCredit < locked.providerCost
        ) {
            throw new Error('INSUFFICIENT_SHIPPING_BALANCE');
        }

        const orderId = locked.orderNumber;
        const pickupLocationCode = await ensureSenderPickupLocation(
            body,
            senderAddress
        );
        const order = {
            orderId,
            pickupLocationCode,
            createShipment: false,
            deliveryOptionId: number(locked.deliveryOptionId),
            storeName: 'SUMSN',
            payment_method: 'paid',
            amount: locked.amount,
            amount_due: 0,
            shippingAmount: locked.providerCost,
            subtotal: locked.amount,
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
                secondaryAddressNumber:
                    receiverAddress.secondaryNumber,
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

        await shippingRequest('createOrder', order);

        const shipmentResult = await createShipmentAfterAssignment(
            orderId,
            locked.deliveryOptionId
        );
        const providerShipmentId =
            shipmentResult.shipmentId ||
            shipmentResult.data?.shipmentId ||
            shipmentResult.otoId ||
            '';
        const trackingNumber =
            shipmentResult.trackingNumber ||
            shipmentResult.data?.trackingNumber ||
            providerShipmentId ||
            '';
        const providerLabelUrl = await getShipmentLabel(orderId);
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
        console.error(
            'دفعت العملية لكن تعذر إنشاء الشحنة:',
            error
        );

        await Payment.updateOne(
            {
                _id: locked._id,
                status: 'processing'
            },
            {
                $set: {
                    status: 'manual_review',
                    failureReason:
                        String(error.message || 'FULFILLMENT_ERROR')
                            .slice(0, 200)
                }
            }
        );

        throw error;
    }
}

async function verifyPaylinkPayment({
    orderNumber,
    transactionNo
}) {
    await connectToDatabase();

    const payment = await Payment.findOne({
        ...(orderNumber ? { orderNumber } : {}),
        ...(transactionNo ? { transactionNo } : {})
    });

    if (!payment) {
        throw new Error('PAYMENT_NOT_FOUND');
    }

    const effectiveTransactionNo =
        transactionNo || payment.transactionNo;

    if (
        !effectiveTransactionNo ||
        (
            payment.transactionNo &&
            String(payment.transactionNo) !==
                String(effectiveTransactionNo)
        )
    ) {
        throw new Error('PAYMENT_TRANSACTION_MISMATCH');
    }

    const invoice = await paylinkRequest(
        `getInvoice/${encodeURIComponent(effectiveTransactionNo)}`
    );
    const invoiceOrderNumber =
        invoice.gatewayOrderRequest?.orderNumber ||
        invoice.orderNumber ||
        '';
    const invoiceAmount = roundMoney(invoice.amount);
    const status =
        String(invoice.orderStatus || '').trim().toLowerCase();

    if (
        invoiceOrderNumber &&
        String(invoiceOrderNumber) !== payment.orderNumber
    ) {
        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    status: 'manual_review',
                    failureReason: 'PAYMENT_ORDER_MISMATCH'
                }
            }
        );
        throw new Error('PAYMENT_ORDER_MISMATCH');
    }

    if (
        Math.round(invoiceAmount * 100) !==
        Math.round(payment.amount * 100)
    ) {
        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    status: 'manual_review',
                    failureReason: 'PAYMENT_AMOUNT_MISMATCH'
                }
            }
        );
        throw new Error('PAYMENT_AMOUNT_MISMATCH');
    }

    if (status === 'paid') {
        if (
            ![
                'shipment_created',
                'processing',
                'manual_review',
                'paid_hold'
            ].includes(payment.status)
        ) {
            payment.status = 'paid';
        }

        payment.paidAt = payment.paidAt || new Date();
        payment.paymentMethod =
            invoice.paymentReceipt?.paymentMethod ||
            invoice.paymentType ||
            payment.paymentMethod ||
            '';
        await payment.save();

        const completed = await createPaidShipment(payment);

        return {
            state:
                completed.status === 'shipment_created'
                    ? 'success'
                    : (
                        completed.status === 'paid_hold'
                            ? 'review'
                            : completed.status
                    ),
            payment: completed
        };
    }

    if (status === 'canceled') {
        payment.status = 'canceled';
        await payment.save();

        return {
            state: 'canceled',
            payment
        };
    }

    if (
        !['shipment_created', 'processing', 'manual_review']
            .includes(payment.status)
    ) {
        payment.status = 'pending';
        await payment.save();
    }

    return {
        state: payment.status === 'manual_review'
            ? 'review'
            : 'pending',
        payment
    };
}

async function currentShipmentForPayment(payment) {
    if (!payment.shipmentId) {
        return null;
    }

    return Shipment.findById(payment.shipmentId);
}

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
                message: 'سجّل الدخول أولًا لإتمام الدفع وحفظ بوليصتك.'
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
            message: 'الدفع وإصدار الشحنات غير متاحين مؤقتًا أثناء الاختبار.'
        });
    }

    if (!paymentGatewayConfigured()) {
        return res.status(503).json({
            success: false,
            message: 'بوابة الدفع غير جاهزة حاليًا.'
        });
    }

    if (
        LIVE_SHIPMENT_TEST_EMAIL &&
        normalizeEmail(req.body.email) !==
            LIVE_SHIPMENT_TEST_EMAIL
    ) {
        return res.status(403).json({
            success: false,
            message: 'الدفع وإصدار الشحنات متاحان حاليًا لحساب الاختبار فقط.'
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
            if (
                existing.paymentUrl &&
                ['creating', 'pending'].includes(existing.status)
            ) {
                return res.json({
                    success: true,
                    paymentRequired: true,
                    paymentUrl: existing.paymentUrl,
                    orderNumber: existing.orderNumber,
                    amount: existing.amount
                });
            }

            if (existing.status === 'shipment_created') {
                const shipment =
                    await currentShipmentForPayment(existing);

                return res.json(
                    paymentPublicState(existing, shipment)
                );
            }

            return res.status(409).json({
                success: false,
                message: 'هذه المحاولة مستخدمة سابقًا. أغلق النافذة واختر العرض مرة أخرى.'
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

        if (
            Number.isFinite(remainingCredit) &&
            remainingFreeShipments <= 0 &&
            remainingCredit < providerCost
        ) {
            throw new Error('INSUFFICIENT_SHIPPING_BALANCE');
        }

        const payment = await Payment.create({
            userId: shipmentUser?._id || null,
            customerEmail: body.email,
            requestId: body.requestId,
            orderNumber,
            status: 'creating',
            amount: finalPrice,
            providerCost,
            carrier: carrierName,
            deliveryOptionId:
                String(body.deliveryOptionId),
            deliveryTime,
            shipmentPayload: {
                body,
                senderAddress,
                receiverAddress
            }
        });
        const callbackUrl = new URL(
            '/api/payments/paylink/callback',
            PUBLIC_BASE_URL
        ).toString();
        const cancelUrl = new URL(
            '/api/payments/paylink/cancel',
            PUBLIC_BASE_URL
        ).toString();
        const invoice = await paylinkRequest(
            'addInvoice',
            {
                method: 'POST',
                body: {
                    orderNumber,
                    amount: finalPrice,
                    callBackUrl: callbackUrl,
                    cancelUrl,
                    clientName: body.senderName,
                    clientEmail: body.email,
                    clientMobile: body.senderPhone,
                    currency: 'SAR',
                    note: `خدمة شحن SUMSN - ${carrierName}`,
                    products: [
                        {
                            title: 'خدمة شحن',
                            price: finalPrice,
                            qty: 1,
                            description:
                                `${body.senderCity} إلى ${body.receiverCity}`,
                            isDigital: false
                        }
                    ]
                }
            }
        );
        const transactionNo =
            String(invoice.transactionNo || '');
        const paymentUrl =
            invoice.url || invoice.mobileUrl || '';

        if (!transactionNo || !paymentUrl) {
            throw new Error('PAYMENT_INVOICE_INVALID');
        }

        payment.transactionNo = transactionNo;
        payment.paymentUrl = paymentUrl;
        payment.checkUrl = invoice.checkUrl || '';
        payment.status = 'pending';
        await payment.save();

        res.json({
            success: true,
            paymentRequired: true,
            paymentUrl,
            orderNumber,
            amount: finalPrice
        });
    } catch (error) {
        console.error('تعذر بدء الدفع:', error);

        await Payment.updateOne(
            {
                orderNumber,
                status: 'creating'
            },
            {
                $set: {
                    status: 'failed',
                    failureReason:
                        String(error.message || 'PAYMENT_START_ERROR')
                            .slice(0, 200)
                }
            }
        ).catch(() => {});

        let message = 'تعذر فتح صفحة الدفع حاليًا. حاول مرة أخرى.';

        if (error.message === 'INVALID_NATIONAL_ADDRESS') {
            message = 'تعذر التحقق من أحد العنوانين المختصرين.';
        } else if (
            error.message === 'INSUFFICIENT_SHIPPING_BALANCE'
        ) {
            message = 'رصيد حساب الشحن غير كافٍ لإصدار البوليصة.';
        } else if (
            error.message === 'PAYMENT_CONFIGURATION_ERROR'
        ) {
            message = 'بوابة الدفع غير جاهزة حاليًا.';
        }

        res.status(502).json({
            success: false,
            message
        });
    }
});

app.get('/api/payments/paylink/callback', async (req, res) => {
    const orderNumber =
        String(req.query.orderNumber || '').trim();
    const transactionNo =
        String(req.query.transactionNo || '').trim();

    try {
        const result = await verifyPaylinkPayment({
            orderNumber,
            transactionNo
        });

        res.redirect(
            303,
            paymentRedirectUrl(
                result.state,
                result.payment.orderNumber
            )
        );
    } catch (error) {
        console.error('تعذر تأكيد دفعة Paylink:', error);
        res.redirect(
            303,
            paymentRedirectUrl('review', orderNumber)
        );
    }
});

app.get('/api/payments/paylink/cancel', async (req, res) => {
    const orderNumber =
        String(req.query.orderNumber || '').trim();
    const transactionNo =
        String(req.query.transactionNo || '').trim();

    if (orderNumber || transactionNo) {
        try {
            await verifyPaylinkPayment({
                orderNumber,
                transactionNo
            });
        } catch (error) {
            console.warn(
                'تعذر تحديث حالة الفاتورة الملغاة:',
                error.message
            );
        }
    }

    res.redirect(
        303,
        paymentRedirectUrl('canceled', orderNumber)
    );
});

app.post('/api/payments/paylink/webhook', async (req, res) => {
    if (!paylinkWebhookAuthorized(req)) {
        return res.status(401).json({
            success: false
        });
    }

    const orderNumber =
        String(
            req.body.merchantOrderNumber ||
            req.body.orderNumber ||
            ''
        ).trim();
    const transactionNo =
        String(req.body.transactionNo || '').trim();

    const isSumsnOrder =
        /^SUMSN-[A-F0-9]{16}$/.test(orderNumber);

    // Paylink's portal sends a connectivity test without a real SUMSN
    // invoice. Acknowledge that test, but never fulfill a shipment from it.
    if (
        (!orderNumber && !transactionNo) ||
        (orderNumber && !isSumsnOrder)
    ) {
        return res.status(200).json({
            success: true,
            test: true
        });
    }

    try {
        const result = await verifyPaylinkPayment({
            orderNumber,
            transactionNo
        });

        res.status(200).json({
            success: true,
            status: result.payment.status
        });
    } catch (error) {
        console.error('خطأ إشعار Paylink:', error);
        res.status(500).json({
            success: false
        });
    }
});

app.get('/api/payments/:orderNumber', async (req, res) => {
    try {
        const user = await authenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'سجّل الدخول لعرض حالة العملية.'
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
                message: 'لم يتم العثور على عملية الدفع.'
            });
        }

        const shipment =
            await currentShipmentForPayment(payment);

        res.json(paymentPublicState(payment, shipment));
    } catch (error) {
        console.error('تعذر جلب حالة الدفع:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر جلب حالة العملية حاليًا.'
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
