const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const crypto = require('crypto');

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
// حتى 30 كجم: سعر الشركة + 10 ريالات.
// فوق 30 كجم: يضاف 3 ريالات لكل كيلوجرام زائد عن 30.
const SUMSN_MARKUP = 10;
const INCLUDED_WEIGHT_KG = 30;
const EXTRA_KG_PRICE = 3;

// معطل افتراضيًا، ولا يعمل إلا عند تفعيل المفتاح صراحةً في بيئة الاستضافة.
const ALLOW_LIVE_SHIPMENTS =
    process.env.ALLOW_LIVE_SHIPMENTS === 'true';

const LIVE_SHIPMENT_TEST_EMAIL =
    String(process.env.LIVE_SHIPMENT_TEST_EMAIL || '')
        .trim()
        .toLowerCase();

let shippingAccessToken = '';
let shippingAccessTokenExpiresAt = 0;
let mongoConnectionPromise = null;

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
        default: Date.now
    }
});

const SearchLog =
    mongoose.models.SearchLog ||
    mongoose.model('SearchLog', searchLogSchema);

/*
|--------------------------------------------------------------------------
| البريد
|--------------------------------------------------------------------------
*/

const transporter =
    EMAIL_USER && EMAIL_PASS
        ? nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: EMAIL_USER,
                pass: EMAIL_PASS
            }
        })
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

/*
|--------------------------------------------------------------------------
| إحصائيات العدادات
|--------------------------------------------------------------------------
*/

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

        await connectToDatabase();

        const [totalOperations, priceStats] = await Promise.all([
            SearchLog.countDocuments(),
            SearchLog.aggregate([
                { $unwind: '$prices' },
                {
                    $group: {
                        _id: null,
                        avgCost: { $avg: '$prices.price' },
                        maxCost: { $max: '$prices.price' }
                    }
                }
            ])
        ]);

        const avgCost = roundMoney(priceStats[0]?.avgCost || 0);
        const maxCost = roundMoney(priceStats[0]?.maxCost || 0);

        res.json({
            success: true,
            totalOperations,
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
| إنشاء شحنة حقيقية
|--------------------------------------------------------------------------
*/

app.post('/api/create-shipment', async (req, res) => {
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
        'boxHeight'
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
            message: 'إصدار الشحنات غير متاح مؤقتًا أثناء مرحلة الاختبار.'
        });
    }

    if (
        LIVE_SHIPMENT_TEST_EMAIL &&
        String(req.body.email).trim().toLowerCase() !==
            LIVE_SHIPMENT_TEST_EMAIL
    ) {
        return res.status(403).json({
            success: false,
            message: 'إصدار الشحنات متاح حاليًا لحساب الاختبار فقط.'
        });
    }

    const body = req.body;
    const shortAddressPattern = /^[A-Z]{4}[0-9]{4}$/;
    const senderShortAddressCode =
        String(body.senderShortAddressCode).trim().toUpperCase();
    const receiverShortAddressCode =
        String(body.receiverShortAddressCode).trim().toUpperCase();

    if (
        !shortAddressPattern.test(senderShortAddressCode) ||
        !shortAddressPattern.test(receiverShortAddressCode)
    ) {
        return res.status(400).json({
            success: false,
            message: 'أدخل عنوانًا مختصرًا صحيحًا من 4 أحرف إنجليزية و4 أرقام.'
        });
    }

    body.senderShortAddressCode = senderShortAddressCode;
    body.receiverShortAddressCode = receiverShortAddressCode;

    try {
        const [senderAddress, receiverAddress] = await Promise.all([
            getNationalAddress(body.senderShortAddressCode),
            getNationalAddress(body.receiverShortAddressCode)
        ]);

        const quote = await shippingRequest(
            'checkOTODeliveryFee',
            quotePayload(
                body.senderCity.trim(),
                body.receiverCity.trim(),
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
                message: 'خيار الشحن المحدد لم يعد متاحًا. أعد جلب الأسعار واختر خيارًا جديدًا.'
            });
        }

        const providerCost = number(selected.price);
        const finalPrice = customerPrice(providerCost, body.weight);
        const carrierName = getCarrierDisplayName(selected);

        const requestId = String(body.requestId || '')
            .replace(/[^A-Za-z0-9-]/g, '')
            .slice(0, 64);
        const orderSuffix = requestId
            ? crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 12)
            : crypto.randomBytes(6).toString('hex');
        const orderId = `SUMSN-${orderSuffix.toUpperCase()}`;

        const order = {
            orderId,
            createShipment: false,
            deliveryOptionId: number(body.deliveryOptionId),
            storeName: 'SUMSN',
            payment_method: 'paid',
            amount: finalPrice,
            amount_due: 0,
            shippingAmount: providerCost,
            subtotal: finalPrice,
            currency: 'SAR',
            packageCount: 1,
            packageWeight: number(body.weight),
            boxLength: number(body.boxLength),
            boxWidth: number(body.boxWidth),
            boxHeight: number(body.boxHeight),
            shippingNotes: body.contentsDescription,
            item_description: body.contentsDescription,
            senderInformation: {
                senderFullName: body.senderName.trim(),
                senderMobile: body.senderPhone.trim(),
                senderCountry: 'SA',
                senderShortAddressCode: senderAddress.shortCode,
                senderBuildingNo: senderAddress.buildingNo,
                sendersecondaryAddressNumber: senderAddress.secondaryNumber,
                senderState: senderAddress.state,
                senderCity: senderAddress.city,
                senderDistrict: senderAddress.district,
                senderStreet: senderAddress.street,
                senderPostcode: senderAddress.postcode,
                senderAddressLine: senderAddress.addressLine,
                lat: senderAddress.lat,
                lon: senderAddress.lon
            },
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

        await shippingRequest('createOrder', order);

        const shipmentResult = await createShipmentAfterAssignment(
            orderId,
            body.deliveryOptionId
        );

        const shipmentId =
            shipmentResult.shipmentId ||
            shipmentResult.data?.shipmentId ||
            shipmentResult.otoId ||
            '';

        const trackingNumber =
            shipmentResult.trackingNumber ||
            shipmentResult.data?.trackingNumber ||
            shipmentId ||
            '';

        let labelUrl = '';

        try {
            const label = await shippingRequest(
                `print/${encodeURIComponent(orderId)}`,
                undefined,
                'GET'
            );

            labelUrl =
                label.printAWBURL ||
                label.url ||
                label.data?.printAWBURL ||
                '';
        } catch (labelError) {
            console.warn('تعذر جلب رابط البوليصة:', labelError.message);
        }

        await connectToDatabase();

        const savedShipment = await Shipment.create({
            fromCity: body.senderCity,
            toCity: body.receiverCity,
            weight: number(body.weight),
            carrier: carrierName,
            price: finalPrice,
            deliveryTime: cleanPublicText(
                selected.avgDeliveryTime ||
                selected.estimatedDeliveryTime ||
                ''
            ),
            otoOrderId: orderId,
            otoShipmentId: shipmentId,
            trackingNumber,
            labelUrl
        });

        if (transporter) {
            await transporter.sendMail({
                from: `"SUMSN" <${EMAIL_USER}>`,
                to: body.email,
                subject: 'تم إنشاء شحنتك عبر SUMSN',
                text:
                    `تم إنشاء شحنتك بنجاح عبر SUMSN.\n\n` +
                    `شركة الشحن: ${carrierName}\n` +
                    `رقم الطلب: ${orderId}\n` +
                    `رقم التتبع: ${savedShipment.trackingNumber || 'سيتم توفيره قريبًا'}\n` +
                    `الإجمالي: ${finalPrice.toFixed(2)} ريال\n` +
                    (labelUrl ? `رابط البوليصة: ${labelUrl}` : '')
            });
        }

        res.json({
            success: true,
            orderId,
            carrier: carrierName,
            shipmentId: savedShipment.otoShipmentId,
            trackingNumber: savedShipment.trackingNumber,
            labelUrl,
            finalPrice
        });
    } catch (error) {
        console.error('خطأ أثناء إنشاء الشحنة:', error);

        const providerMessage = String(error.providerMessage || '').toLowerCase();
        let message = 'تعذر إنشاء الشحنة حاليًا. حاول مرة أخرى أو تواصل مع الدعم.';

        if (error.message === 'INVALID_NATIONAL_ADDRESS') {
            message = 'تعذر التحقق من أحد العنوانين المختصرين. تأكد من صحتهما وحاول مجددًا.';
        } else if (
            providerMessage.includes('credit') ||
            providerMessage.includes('balance') ||
            providerMessage.includes('رصيد')
        ) {
            message = 'رصيد حساب الشحن غير كافٍ لإصدار البوليصة.';
        } else if (providerMessage.includes('not assigned yet')) {
            message = 'تم إنشاء الطلب لكن OTO لم يعيّنه لشركة الشحن بعد. لا تعِد المحاولة وتواصل مع الدعم.';
        }

        res.status(502).json({
            success: false,
            message
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
