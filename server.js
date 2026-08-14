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
| Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù†Ø¸Ø§Ù…
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
| Ù…Ø²ÙˆØ¯ Ø§Ù„Ø´Ø­Ù† - Ø¯Ø§Ø®Ù„ÙŠ ÙÙ‚Ø·
|--------------------------------------------------------------------------
*/

const SHIPPING_REFRESH_TOKEN =
    process.env.OTO_REFRESH_TOKEN ||
    process.env.OTO_API_KEY;

const SHIPPING_BASE_URL =
    'https://api.tryoto.com/rest/v2';

/*
|--------------------------------------------------------------------------
| ØªØ³Ø¹ÙŠØ± SUMSN
|--------------------------------------------------------------------------
*/

// Ø§Ù„ØªØ³Ø¹ÙŠØ± Ø«Ø§Ø¨Øª Ù‡Ù†Ø§ Ø­ØªÙ‰ Ù„Ø§ ØªØªØºÙ„Ø¨ Ø¹Ù„ÙŠÙ‡ Ù‚ÙŠÙ… Ù‚Ø¯ÙŠÙ…Ø© Ù…Ø­ÙÙˆØ¸Ø© ÙÙŠ Vercel.
// Ø­ØªÙ‰ 17 ÙƒØ¬Ù…: Ø³Ø¹Ø± Ø§Ù„Ø´Ø±ÙƒØ© + 4 Ø±ÙŠØ§Ù„Ø§Øª.
// ÙÙˆÙ‚ 17 ÙƒØ¬Ù…: ÙŠØ¶Ø§Ù 3 Ø±ÙŠØ§Ù„Ø§Øª Ù„ÙƒÙ„ ÙƒÙŠÙ„ÙˆØ¬Ø±Ø§Ù… Ø²Ø§Ø¦Ø¯ Ø¹Ù† 17.
const SUMSN_MARKUP = 4;
const INCLUDED_WEIGHT_KG = 17;
const EXTRA_KG_PRICE = 3;

// Ù…Ø¹Ø·Ù„ Ø§ÙØªØ±Ø§Ø¶ÙŠÙ‹Ø§ØŒ ÙˆÙ„Ø§ ÙŠØ¹Ù…Ù„ Ø¥Ù„Ø§ Ø¹Ù†Ø¯ ØªÙØ¹ÙŠÙ„ Ø§Ù„Ù…ÙØªØ§Ø­ ØµØ±Ø§Ø­Ø©Ù‹ ÙÙŠ Ø¨ÙŠØ¦Ø© Ø§Ù„Ø§Ø³ØªØ¶Ø§ÙØ©.
const ALLOW_LIVE_SHIPMENTS =
    process.env.ALLOW_LIVE_SHIPMENTS === 'true';

const LIVE_SHIPMENT_TEST_EMAIL =
    String(process.env.LIVE_SHIPMENT_TEST_EMAIL || '')
        .trim()
        .toLowerCase();

/*
|--------------------------------------------------------------------------
| ØªØ®Ø²ÙŠÙ† Ø¨ÙˆØ§Ù„Øµ Ø§Ù„Ø´Ø­Ù† ÙÙŠ Cloudflare R2 - Ø®Ø§Øµ ÙˆØºÙŠØ± Ù…ØªØ§Ø­ Ù„Ù„Ø¹Ø§Ù…Ø©
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
| Ø¨ÙˆØ§Ø¨Ø© Ø§Ù„Ø¯ÙØ¹ Paylink - Ø§Ù„Ø£Ø³Ø±Ø§Ø± ØªØ¨Ù‚Ù‰ ÙÙŠ Ø§Ù„Ø®Ø§Ø¯Ù… ÙÙ‚Ø·
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
                console.log('ØªÙ… Ø§Ù„Ø§ØªØµØ§Ù„ Ø¨Ù‚Ø§Ø¹Ø¯Ø© Ø¨ÙŠØ§Ù†Ø§Øª MongoDB Ø¨Ù†Ø¬Ø§Ø­');
                return connection;
            })
            .catch((error) => {
                mongoConnectionPromise = null;
                console.error('Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø§ØªØµØ§Ù„ Ø¨Ù‚Ø§Ø¹Ø¯Ø© MongoDB:', error);
                throw error;
            });
    }

    return mongoConnectionPromise;
}

/*
|--------------------------------------------------------------------------
| Ù†Ù…ÙˆØ°Ø¬ Ø§Ù„Ø´Ø­Ù†Ø§Øª Ø§Ù„ÙØ¹Ù„ÙŠØ©
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
| Ù…Ø¯ÙÙˆØ¹Ø§Øª Paylink
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
| Ø³Ø¬Ù„ Ø¹Ù…Ù„ÙŠØ§Øª Ø§Ù„Ø§Ø³ØªØ¹Ù„Ø§Ù… - Ù‡Ø°Ø§ Ù‡Ùˆ Ø§Ù„Ù…Ù‡Ù… Ù„Ù„Ø¹Ø¯Ø§Ø¯Ø§Øª
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
| Ø§Ù„Ø¨Ø±ÙŠØ¯
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
| Ø£Ø¯ÙˆØ§Øª Ù…Ø³Ø§Ø¹Ø¯Ø©
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


function customerAccountsÛ½½òÚ$z{-®éÜj×w6VæFW$6—G’rÀĞ¢w6VæFW%†öæRrÀĞ¢w6VæFW%6†÷'DFG&W746öFRrÀĞ¢w&V6V—fW$æÖRrÀĞ¢w&V6V—fW$6—G’rÀĞ¢w&V6V—fW%†öæRrÀĞ¢w&V6V—fW%6†÷'DFG&W746öFRrÀĞ¢vFVÆ—fW'”÷F–öä–BrÀĞ¢wvV–v‡BrÀĞ¢v&÷„ÆVæwF‚rÀĞ¢v&÷…v–GF‚rÀĞ¢v&÷„†V–v‡BrÀĞ¢w&WVW7D–BpĞ¢Ó°Ğ¢6öç7BÖ—76–ærÒ&WV—&VBæf–ÇFW"‚†f–VÆB’Óâ&Wæ&öG•¶f–VÆEÒ“°Ğ Ğ¢–b†Ö—76–æræÆVæwF‚’°Ğ¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}˜­‹ŠÍ˜’Š­‹ŠŠmŠ’ŠÍ˜]˜­‹’Š˜­Š}˜mŠ}Š¢Š}˜M‹MŠİ˜mŠ’Š}˜M˜]‹}˜M˜ŠŠ’âpĞ¢Ò“°Ğ¢ĞĞ Ğ¢–b‚ÄÄõuôÄ•dUõ4„•ÔTåE2’°Ğ¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Š}˜MŠı˜‹’˜Š]‹]ŠıŠ}‹Š}˜M‹MŠİ˜mŠ}Š¢‹­˜­‹˜]Š­Š}Šİ˜­˜b˜]ŠM˜-Š­˜½ŠrŠ=Š½˜mŠ}ŠŠ}˜MŠ}ŠíŠ­ŠŠ}‹âpĞ¢Ò“°Ğ¢ĞĞ Ğ¢–b‚–ÖVçDvFWv”6öæf–wW&VB‚’’°Ğ¢&WGW&â&W2ç7FGW2ƒS2’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Š˜Š}ŠŠ’Š}˜MŠı˜‹’‹­˜­‹ŠÍŠ}˜}‹-Š’ŠİŠ}˜M˜­˜½ŠrâpĞ¢Ò“°Ğ¢ĞĞ Ğ¢–b€Ğ¢Ä•dUõ4„•ÔTåEõDU5EôTÔ”Âb`Ğ¢æ÷&ÖÆ—¦TVÖ–Â‡&Wæ&öG’æVÖ–Â’ÓĞĞ¢Ä•dUõ4„•ÔTåEõDU5EôTÔ”ÀĞ¢’°Ğ¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Š}˜MŠı˜‹’˜Š]‹]ŠıŠ}‹Š}˜M‹MŠİ˜mŠ}Š¢˜]Š­Š}ŠİŠ}˜bŠİŠ}˜M˜­˜½Šr˜MŠİ‹=Š}Š‚Š}˜MŠ}ŠíŠ­ŠŠ}‹˜˜-‹râpĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B&öG’Ò°Ğ¢ââç&Wæ&öG’ÀĞ¢VÖ–Ã¢æ÷&ÖÆ—¦TVÖ–Â‡&Wæ&öG’æVÖ–Â’ÀĞ¢6öçFVçG4FW67&—F–öã Ğ¢7G&–ær‡&Wæ&öG’æ6öçFVçG4FW67&—F–öâÇÂrr’çG&–Ò‚’ÀĞ¢6VæFW$æÖS¢7G&–ær‡&Wæ&öG’ç6VæFW$æÖRÇÂrr’çG&–Ò‚’ÀĞ¢6VæFW$6—G“¢7G&–ær‡&Wæ&öG’ç6VæFW$6—G’ÇÂrr’çG&–Ò‚’ÀĞ¢6VæFW%†öæS¢7G&–ær‡&Wæ&öG’ç6VæFW%†öæRÇÂrr’çG&–Ò‚’ÀĞ¢6VæFW%6†÷'DFG&W746öFS Ğ¢7G&–ær‡&Wæ&öG’ç6VæFW%6†÷'DFG&W746öFRÇÂrrĞ¢çG&–Ò‚Ğ¢çFõWW$66R‚’ÀĞ¢&V6V—fW$æÖS¢7G&–ær‡&Wæ&öG’ç&V6V—fW$æÖRÇÂrr’çG&–Ò‚’ÀĞ¢&V6V—fW$6—G“¢7G&–ær‡&Wæ&öG’ç&V6V—fW$6—G’ÇÂrr’çG&–Ò‚’ÀĞ¢&V6V—fW%†öæS¢7G&–ær‡&Wæ&öG’ç&V6V—fW%†öæRÇÂrr’çG&–Ò‚’ÀĞ¢&V6V—fW%6†÷'DFG&W746öFS Ğ¢7G&–ær‡&Wæ&öG’ç&V6V—fW%6†÷'DFG&W746öFRÇÂrrĞ¢çG&–Ò‚Ğ¢çFõWW$66R‚’ÀĞ¢&WVW7D–C Ğ¢7G&–ær‡&Wæ&öG’ç&WVW7D–BÇÂrrĞ¢ç&WÆ6R‚õµäÕ¦×£Ó’ÕÒörÂrrĞ¢ç6Æ–6RƒÂcB’ÀĞ¢vV–v‡C¢çVÖ&W"‡&Wæ&öG’çvV–v‡B’ÀĞ¢&÷„ÆVæwFƒ¢çVÖ&W"‡&Wæ&öG’æ&÷„ÆVæwF‚’ÀĞ¢&÷…v–GFƒ¢çVÖ&W"‡&Wæ&öG’æ&÷…v–GF‚’ÀĞ¢&÷„†V–v‡C¢çVÖ&W"‡&Wæ&öG’æ&÷„†V–v‡BĞ¢Ó°Ğ¢6öç7B6†÷'DFG&W75GFW&âÒõå´Õ¥×³GÕ³Ó•×³GÒBó°Ğ Ğ¢–b€Ğ¢fÆ–DVÖ–Â†&öG’æVÖ–Â’ÇÀĞ¢6†÷'DFG&W75GFW&âçFW7B†&öG’ç6VæFW%6†÷'DFG&W746öFR’ÇÀĞ¢6†÷'DFG&W75GFW&âçFW7B†&öG’ç&V6V—fW%6†÷'DFG&W746öFR’ÇÀĞ¢&öG’çvV–v‡BÃÒÇÀĞ¢&öG’æ&÷„ÆVæwF‚ÃÒÇÀĞ¢&öG’æ&÷…v–GF‚ÃÒÇÀĞ¢&öG’æ&÷„†V–v‡BÃÒÇÀĞ¢&öG’ç&WVW7D–@Ğ¢’°Ğ¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Š­Šİ˜-˜"˜]˜bŠ}˜MŠ‹˜­Šò˜Š}˜M‹˜m˜Š}˜m˜­˜bŠ}˜M˜]ŠíŠ­‹]‹˜­˜b˜Š}˜M˜‹-˜b˜Š}˜MŠ=Š‹Š}ŠòâpĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B–FVçF—G’ĞĞ¢6†—ÖVçEW6W#òåö–BÇÀĞ¢&öG’æVÖ–Ã°Ğ¢6öç7B÷&FW%7Vff—‚Ò7'—FğĞ¢æ7&VFT†6‚‚w6†#SbrĞ¢çWFFR†G¶–FVçF—G—Ó¢G¶&öG’ç&WVW7D–GÖĞ¢æF–vW7B‚v†W‚rĞ¢ç6Æ–6RƒÂbĞ¢çFõWW$66R‚“°Ğ¢6öç7B÷&FW$çVÖ&W"Ò5TÕ4âÒG¶÷&FW%7Vff—‡Ö°Ğ Ğ¢G'’°Ğ¢v—B6öææV7EFôFF&6R‚“°Ğ Ğ¢6öç7BW†—7F–ærÒv—B–ÖVçBæf–æDöæR‡°Ğ¢÷&FW$çVÖ&W"ÀĞ¢W6W$–C¢6†—ÖVçEW6W#òåö–BÇÂçVÆÀĞ¢Ò“°Ğ Ğ¢–b†W†—7F–ær’°Ğ¢–b€Ğ¢W†—7F–ærç–ÖVçEW&Âb`Ğ¢²v7&VF–ærrÂwVæF–æruÒæ–æ6ÇVFW2†W†—7F–ærç7FGW2Ğ¢’°Ğ¢&WGW&â&W2æ§6öâ‡°Ğ¢7V66W73¢G'VRÀĞ¢–ÖVçE&WV—&VC¢G'VRÀĞ¢–ÖVçEW&Ã¢W†—7F–ærç–ÖVçEW&ÂÀĞ¢÷&FW$çVÖ&W#¢W†—7F–æræ÷&FW$çVÖ&W"ÀĞ¢Ö÷VçC¢W†—7F–æræÖ÷Vç@Ğ¢Ò“°Ğ¢ĞĞ Ğ¢–b†W†—7F–ærç7FGW2ÓÓÒw6†—ÖVçEö7&VFVBr’°Ğ¢6öç7B6†—ÖVçBĞĞ¢v—B7W'&VçE6†—ÖVçDf÷%–ÖVçB†W†—7F–ær“°Ğ Ğ¢&WGW&â&W2æ§6öâ€Ğ¢–ÖVçEV&Æ–57FFR†W†—7F–ærÂ6†—ÖVçBĞ¢“°Ğ¢ĞĞ Ğ¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}˜}‹˜rŠ}˜M˜]ŠİŠ}˜˜MŠ’˜]‹=Š­ŠíŠı˜]Š’‹=Š}Š˜-˜½ŠrâŠ=‹­˜M˜"Š}˜M˜mŠ}˜‹Š’˜Š}ŠíŠ­‹Š}˜M‹‹‹b˜]‹Š’Š=Ší‹˜’âpĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B·6VæFW$FG&W72Â&V6V—fW$FG&W75ÒĞĞ¢v—B&öÖ—6RæÆÂ…°Ğ¢vWDæF–öæÄFG&W72€Ğ¢&öG’ç6VæFW%6†÷'DFG&W746öFPĞ¢’ÀĞ¢vWDæF–öæÄFG&W72€Ğ¢&öG’ç&V6V—fW%6†÷'DFG&W746öFPĞ¢Ğ¢Ò“°Ğ¢6öç7BV÷FRÒv—B6†—–æu&WVW7B€Ğ¢v6†V6´õDôFVÆ—fW'”fVRrÀĞ¢V÷FU–ÆöB€Ğ¢&öG’ç6VæFW$6—G’ÀĞ¢&öG’ç&V6V—fW$6—G’ÀĞ¢&öG’çvV–v‡BÀĞ¢&öG’æ&÷„ÆVæwF‚ÀĞ¢&öG’æ&÷…v–GF‚ÀĞ¢&öG’æ&÷„†V–v‡@Ğ¢Ğ¢“°Ğ¢6öç7B6VÆV7FVBÒvWDFVÆ—fW'”6ö×æ–W2‡V÷FR’æf–æB€Ğ¢†6ö×ç’’ÓàĞ¢7G&–ær†6ö×ç’æFVÆ—fW'”÷F–öä–B’ÓÓĞĞ¢7G&–ær†&öG’æFVÆ—fW'”÷F–öä–BĞ¢“°Ğ Ğ¢–b‚6VÆV7FVB’°Ğ¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Ší˜­Š}‹Š}˜M‹MŠİ˜bŠ­‹­˜­‹âŠ=‹ŠòŠÍ˜MŠ‚Š}˜MŠ=‹=‹Š}‹˜Š}ŠíŠ­‹˜]˜bŠÍŠı˜­ŠòâpĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B&÷f–FW$6÷7BÒçVÖ&W"‡6VÆV7FVBç&–6R“°Ğ¢6öç7Bf–æÅ&–6RĞĞ¢7W7FöÖW%&–6R‡&÷f–FW$6÷7BÂ&öG’çvV–v‡B“°Ğ¢6öç7B6'&–W$æÖRÒvWD6'&–W$F—7Æ”æÖR‡6VÆV7FVB“°Ğ¢6öç7BFVÆ—fW'•F–ÖRÒ6ÆVåV&Æ–5FW‡B€Ğ¢6VÆV7FVBæftFVÆ—fW'•F–ÖRÇÀĞ¢6VÆV7FVBæW7F–ÖFVDFVÆ—fW'•F–ÖRÇÀĞ¢rpĞ¢“°Ğ¢6öç7B66÷VçD–æfòÒv—B6†—–æu&WVW7B€Ğ¢v66÷VçD–æfòrÀĞ¢VæFVf–æVBÀĞ¢ttUBpĞ¢“°Ğ¢6öç7B&VÖ–æ–æt7&VF—BÒçVÖ&W"€Ğ¢66÷VçD–æfòç&VÖ–æ–æt7&VF—BóğĞ¢66÷VçD–æfòæFFòç&VÖ–æ–æt7&VF—BÀĞ¢æàĞ¢“°Ğ¢6öç7B&VÖ–æ–ætg&VU6†—ÖVçG2ÒçVÖ&W"€Ğ¢66÷VçD–æfòç&VÖ–æ–ætg&VU6†—ÖVçG2óğĞ¢66÷VçD–æfòæFFòç&VÖ–æ–ætg&VU6†—ÖVçG2ÀĞ¢ Ğ¢“°Ğ Ğ¢–b€Ğ¢çVÖ&W"æ—4f–æ—FR‡&VÖ–æ–æt7&VF—B’b`Ğ¢&VÖ–æ–ætg&VU6†—ÖVçG2ÃÒb`Ğ¢&VÖ–æ–æt7&VF—BÂ&÷f–FW$6÷7@Ğ¢’°Ğ¢F‡&÷ræWrW'&÷"‚t”å5Tdd”4”TåEõ4„•”äuô$Ää4Rr“°Ğ¢ĞĞ Ğ¢6öç7B–ÖVçBÒv—B–ÖVçBæ7&VFR‡°Ğ¢W6W$–C¢6†—ÖVçEW6W#òåö–BÇÂçVÆÂÀĞ¢7W7FöÖW$VÖ–Ã¢&öG’æVÖ–ÂÀĞ¢&WVW7D–C¢&öG’ç&WVW7D–BÀĞ¢÷&FW$çVÖ&W"ÀĞ¢7FGW3¢v7&VF–ærrÀĞ¢Ö÷VçC¢f–æÅ&–6RÀĞ¢&÷f–FW$6÷7BÀĞ¢6'&–W#¢6'&–W$æÖRÀĞ¢FVÆ—fW'”÷F–öä–C Ğ¢7G&–ær†&öG’æFVÆ—fW'”÷F–öä–B’ÀĞ¢FVÆ—fW'•F–ÖRÀĞ¢6†—ÖVçE–ÆöC¢°Ğ¢&öG’ÀĞ¢6VæFW$FG&W72ÀĞ¢&V6V—fW$FG&W70Ğ¢ĞĞ¢Ò“°Ğ¢6öç7B6ÆÆ&6µW&ÂÒæWrU$Â€Ğ¢rö’÷–ÖVçG2÷–Æ–æ²ö6ÆÆ&6²rÀĞ¢T$Ä”5ô$4UõU$ÀĞ¢’çFõ7G&–ær‚“°Ğ¢6öç7B6æ6VÅW&ÂÒæWrU$Â€Ğ¢rö’÷–ÖVçG2÷–Æ–æ²ö6æ6VÂrÀĞ¢T$Ä”5ô$4UõU$ÀĞ¢’çFõ7G&–ær‚“°Ğ¢6öç7B–çfö–6RÒv—B–Æ–æµ&WVW7B€Ğ¢vFD–çfö–6RrÀĞ¢°Ğ¢ÖWF†öC¢uõ5BrÀĞ¢&öG“¢°Ğ¢÷&FW$çVÖ&W"ÀĞ¢Ö÷VçC¢f–æÅ&–6RÀĞ¢6ÆÄ&6µW&Ã¢6ÆÆ&6µW&ÂÀĞ¢6æ6VÅW&ÂÀĞ¢6Æ–VçDæÖS¢&öG’ç6VæFW$æÖRÀĞ¢6Æ–VçDVÖ–Ã¢&öG’æVÖ–ÂÀĞ¢6Æ–VçDÖö&–ÆS¢&öG’ç6VæFW%†öæRÀĞ¢7W'&Væ7“¢u4"rÀĞ¢æ÷FS¢ŠíŠı˜]Š’‹MŠİ˜b5TÕ4âÒG¶6'&–W$æÖWÖÀĞ¢&öGV7G3¢°Ğ¢°Ğ¢F—FÆS¢}ŠíŠı˜]Š’‹MŠİ˜brÀĞ¢&–6S¢f–æÅ&–6RÀĞ¢G“¢ÀĞ¢FW67&—F–öã Ğ¢G¶&öG’ç6VæFW$6—G—ÒŠ]˜M˜’G¶&öG’ç&V6V—fW$6—G—ÖÀĞ¢—4F–v—FÃ¢fÇ6PĞ¢ĞĞ¢ĞĞ¢ĞĞ¢ĞĞ¢“°Ğ¢6öç7BG&ç67F–öäæòĞĞ¢7G&–ær†–çfö–6RçG&ç67F–öäæòÇÂrr“°Ğ¢6öç7B–ÖVçEW&ÂĞĞ¢–çfö–6RçW&ÂÇÂ–çfö–6RæÖö&–ÆUW&ÂÇÂrs°Ğ Ğ¢–b‚G&ç67F–öäæòÇÂ–ÖVçEW&Â’°Ğ¢F‡&÷ræWrW'&÷"‚u”ÔTåEô”ådô”4Uô”ådÄ”Br“°Ğ¢ĞĞ Ğ¢–ÖVçBçG&ç67F–öäæòÒG&ç67F–öäæó°Ğ¢–ÖVçBç–ÖVçEW&ÂÒ–ÖVçEW&Ã°Ğ¢–ÖVçBæ6†V6µW&ÂÒ–çfö–6Ræ6†V6µW&ÂÇÂrs°Ğ¢–ÖVçBç7FGW2ÒwVæF–ærs°Ğ¢v—B–ÖVçBç6fR‚“°Ğ Ğ¢&W2æ§6öâ‡°Ğ¢7V66W73¢G'VRÀĞ¢–ÖVçE&WV—&VC¢G'VRÀĞ¢–ÖVçEW&ÂÀĞ¢÷&FW$çVÖ&W"ÀĞ¢Ö÷VçC¢f–æÅ&–6PĞ¢Ò“°Ğ¢Ò6F6‚†W'&÷"’°Ğ¢6öç6öÆRæW'&÷"‚}Š­‹‹‹ŠŠıŠŠ}˜MŠı˜‹“¢rÂW'&÷"“°Ğ Ğ¢v—B–ÖVçBçWFFTöæR€Ğ¢°Ğ¢÷&FW$çVÖ&W"ÀĞ¢7FGW3¢v7&VF–ærpĞ¢ÒÀĞ¢°Ğ¢G6WC¢°Ğ¢7FGW3¢vf–ÆVBrÀĞ¢f–ÇW&U&V6öã Ğ¢7G&–ær†W'&÷"æÖW76vRÇÂu”ÔTåEõ5D%EôU%$õ"rĞ¢ç6Æ–6RƒÂ#Ğ¢ĞĞ¢ĞĞ¢’æ6F6‚‚‚’Óâ·Ò“°Ğ Ğ¢ÆWBÖW76vRÒ}Š­‹‹‹˜Š­ŠÒ‹]˜ŠİŠ’Š}˜MŠı˜‹’ŠİŠ}˜M˜­˜½ŠrâŠİŠ}˜˜B˜]‹Š’Š=Ší‹˜’âs°Ğ Ğ¢–b†W'&÷"æÖW76vRÓÓÒt”ådÄ”EôäD”ôäÅôDE$U52r’°Ğ¢ÖW76vRÒ}Š­‹‹‹Š}˜MŠ­Šİ˜-˜"˜]˜bŠ=ŠİŠòŠ}˜M‹˜m˜Š}˜m˜­˜bŠ}˜M˜]ŠíŠ­‹]‹˜­˜bâs°Ğ¢ÒVÇ6R–b€Ğ¢W'&÷"æÖW76vRÓÓÒt”å5Tdd”4”TåEõ4„•”äuô$Ää4RpĞ¢’°Ğ¢ÖW76vRÒ}‹‹]˜­ŠòŠİ‹=Š}Š‚Š}˜M‹MŠİ˜b‹­˜­‹˜=Š}˜˜Ò˜MŠ]‹]ŠıŠ}‹Š}˜MŠ˜˜M˜­‹]Š’âs°Ğ¢ÒVÇ6R–b€Ğ¢W'&÷"æÖW76vRÓÓÒu”ÔTåEô4ôäd”uU$D”ôåôU%$õ"pĞ¢’°Ğ¢ÖW76vRÒ}Š˜Š}ŠŠ’Š}˜MŠı˜‹’‹­˜­‹ŠÍŠ}˜}‹-Š’ŠİŠ}˜M˜­˜½Šrâs°Ğ¢ĞĞ Ğ¢&W2ç7FGW2ƒS"’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vPĞ¢Ò“°Ğ¢ĞĞ§Ò“°Ğ Ğ¦ævWB‚rö’÷–ÖVçG2÷–Æ–æ²ö6ÆÆ&6²rÂ7–æ2‡&WÂ&W2’Óâ°Ğ¢6öç7B÷&FW$çVÖ&W"ĞĞ¢7G&–ær‡&WçVW'’æ÷&FW$çVÖ&W"ÇÂrr’çG&–Ò‚“°Ğ¢6öç7BG&ç67F–öäæòĞĞ¢7G&–ær‡&WçVW'’çG&ç67F–öäæòÇÂrr’çG&–Ò‚“°Ğ Ğ¢G'’°Ğ¢6öç7B&W7VÇBÒv—BfW&–g•–Æ–æµ–ÖVçB‡°Ğ¢÷&FW$çVÖ&W"ÀĞ¢G&ç67F–öäæğĞ¢Ò“°Ğ Ğ¢&W2ç&VF—&V7B€Ğ¢32ÀĞ¢–ÖVçE&VF—&V7EW&Â€Ğ¢&W7VÇBç7FFRÀĞ¢&W7VÇBç–ÖVçBæ÷&FW$çVÖ&W Ğ¢Ğ¢“°Ğ¢Ò6F6‚†W'&÷"’°Ğ¢6öç6öÆRæW'&÷"‚}Š­‹‹‹Š­Š=˜=˜­ŠòŠı˜‹Š’–Æ–æ³¢rÂW'&÷"“°Ğ¢&W2ç&VF—&V7B€Ğ¢32ÀĞ¢–ÖVçE&VF—&V7EW&Â‚w&Wf–WrrÂ÷&FW$çVÖ&W"Ğ¢“°Ğ¢ĞĞ§Ò“°Ğ Ğ¦ævWB‚rö’÷–ÖVçG2÷–Æ–æ²ö6æ6VÂrÂ7–æ2‡&WÂ&W2’Óâ°Ğ¢6öç7B÷&FW$çVÖ&W"ĞĞ¢7G&–ær‡&WçVW'’æ÷&FW$çVÖ&W"ÇÂrr’çG&–Ò‚“°Ğ¢6öç7BG&ç67F–öäæòĞĞ¢7G&–ær‡&WçVW'’çG&ç67F–öäæòÇÂrr’çG&–Ò‚“°Ğ Ğ¢–b†÷&FW$çVÖ&W"ÇÂG&ç67F–öäæò’°Ğ¢G'’°Ğ¢v—BfW&–g•–Æ–æµ–ÖVçB‡°Ğ¢÷&FW$çVÖ&W"ÀĞ¢G&ç67F–öäæğĞ¢Ò“°Ğ¢Ò6F6‚†W'&÷"’°Ğ¢6öç6öÆRçv&â€Ğ¢}Š­‹‹‹Š­ŠİŠı˜­Š²ŠİŠ}˜MŠ’Š}˜M˜Š}Š­˜‹Š’Š}˜M˜]˜M‹­Š}Š“¢rÀĞ¢W'&÷"æÖW76vPĞ¢“°Ğ¢ĞĞ¢ĞĞ Ğ¢&W2ç&VF—&V7B€Ğ¢32ÀĞ¢–ÖVçE&VF—&V7EW&Â‚v6æ6VÆVBrÂ÷&FW$çVÖ&W"Ğ¢“°Ğ§Ò“°Ğ Ğ¦ç÷7B‚rö’÷–ÖVçG2÷–Æ–æ²÷vV&†öö²rÂ7–æ2‡&WÂ&W2’Óâ°Ğ¢–b‚–Æ–æµvV&†öö´WF†÷&—¦VB‡&W’’°Ğ¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°Ğ¢7V66W73¢fÇ6PĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B÷&FW$çVÖ&W"ĞĞ¢7G&–ær€Ğ¢&Wæ&öG’æÖW&6†çD÷&FW$çVÖ&W"ÇÀĞ¢&Wæ&öG’æ÷&FW$çVÖ&W"ÇÀĞ¢rpĞ¢’çG&–Ò‚“°Ğ¢6öç7BG&ç67F–öäæòĞĞ¢7G&–ær‡&Wæ&öG’çG&ç67F–öäæòÇÂrr’çG&–Ò‚“°Ğ Ğ¢6öç7B—57V×6ä÷&FW"ĞĞ¢õå5TÕ4âÕ´ÔcÓ•×³gÒBòçFW7B†÷&FW$çVÖ&W"“°Ğ Ğ¢òò–Æ–æ²w2÷'FÂ6VæG26öææV7F—f—G’FW7Bv—F†÷WB&VÂ5TÕ4àĞ¢òò–çfö–6Râ6¶æ÷vÆVFvRF†BFW7BÂ'WBæWfW"gVÆf–ÆÂ6†—ÖVçBg&öÒ—BàĞ¢–b€Ğ¢‚÷&FW$çVÖ&W"bbG&ç67F–öäæò’ÇÀĞ¢†÷&FW$çVÖ&W"bb—57V×6ä÷&FW"Ğ¢’°Ğ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°Ğ¢7V66W73¢G'VRÀĞ¢FW7C¢G'VPĞ¢Ò“°Ğ¢ĞĞ Ğ¢G'’°Ğ¢6öç7B&W7VÇBÒv—BfW&–g•–Æ–æµ–ÖVçB‡°Ğ¢÷&FW$çVÖ&W"ÀĞ¢G&ç67F–öäæğĞ¢Ò“°Ğ Ğ¢&W2ç7FGW2ƒ#’æ§6öâ‡°Ğ¢7V66W73¢G'VRÀĞ¢7FGW3¢&W7VÇBç–ÖVçBç7FGW0Ğ¢Ò“°Ğ¢Ò6F6‚†W'&÷"’°Ğ¢6öç6öÆRæW'&÷"‚}Ší‹}Š2Š]‹M‹Š}‹–Æ–æ³¢rÂW'&÷"“°Ğ¢&W2ç7FGW2ƒS’æ§6öâ‡°Ğ¢7V66W73¢fÇ6PĞ¢Ò“°Ğ¢ĞĞ§Ò“°Ğ Ğ¦ævWB‚rö’÷–ÖVçG2ó¦÷&FW$çVÖ&W"rÂ7–æ2‡&WÂ&W2’Óâ°Ğ¢G'’°Ğ¢6öç7BW6W"Òv—BWF†VçF–6FVEW6W"‡&W“°Ğ Ğ¢–b‚W6W"’°Ğ¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}‹=ŠÍ™˜BŠ}˜MŠıŠí˜˜B˜M‹‹‹bŠİŠ}˜MŠ’Š}˜M‹˜]˜M˜­Š’âpĞ¢Ò“°Ğ¢ĞĞ Ğ¢v—B6öææV7EFôFF&6R‚“°Ğ Ğ¢6öç7B–ÖVçBÒv—B–ÖVçBæf–æDöæR‡°Ğ¢÷&FW$çVÖ&W# Ğ¢7G&–ær‡&Wç&×2æ÷&FW$çVÖ&W"ÇÂrr’çG&–Ò‚’ÀĞ¢W6W$–C¢W6W"åö–@Ğ¢Ò“°Ğ Ğ¢–b‚–ÖVçB’°Ğ¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}˜M˜R˜­Š­˜RŠ}˜M‹Š½˜‹‹˜M˜’‹˜]˜M˜­Š’Š}˜MŠı˜‹’âpĞ¢Ò“°Ğ¢ĞĞ Ğ¢6öç7B6†—ÖVçBĞĞ¢v—B7W'&VçE6†—ÖVçDf÷%–ÖVçB‡–ÖVçB“°Ğ Ğ¢&W2æ§6öâ‡–ÖVçEV&Æ–57FFR‡–ÖVçBÂ6†—ÖVçB’“°Ğ¢Ò6F6‚†W'&÷"’°Ğ¢6öç6öÆRæW'&÷"‚}Š­‹‹‹ŠÍ˜MŠ‚ŠİŠ}˜MŠ’Š}˜MŠı˜‹“¢rÂW'&÷"“°Ğ¢&W2ç7FGW2ƒS’æ§6öâ‡°Ğ¢7V66W73¢fÇ6RÀĞ¢ÖW76vS¢}Š­‹‹‹ŠÍ˜MŠ‚ŠİŠ}˜MŠ’Š}˜M‹˜]˜M˜­Š’ŠİŠ}˜M˜­˜½ŠrâpĞ¢Ò“°Ğ¢ĞĞ§Ò“°Ğ Ğ¢ò Ğ§ÂÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ§ÂŠ­‹M‹­˜­˜BŠ}˜M‹=˜­‹˜‹Ğ§ÂÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢¢ğĞ Ğ¦æÆ—7FVâ…õ%BÂ‚’Óâ°Ğ¢6öç6öÆRæÆör†Š}˜M‹=˜­‹˜‹˜­‹˜]˜B‹˜M˜’‡GG¢òöÆö6Æ†÷7C¢Gµõ%GÖ“°Ğ§Ò“°Ğ 