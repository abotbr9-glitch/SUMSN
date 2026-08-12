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
| إعداد مزود الشحن - داخلي فقط
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

const SUMSN_MARKUP =
    Number(process.env.SUMSN_MARKUP || 10);

const INCLUDED_WEIGHT_KG =
    Number(process.env.INCLUDED_WEIGHT_KG || 15);

const EXTRA_KG_PRICE =
    Number(process.env.EXTRA_KG_PRICE || 2);

const ALLOW_LIVE_SHIPMENTS =
    process.env.ALLOW_LIVE_SHIPMENTS === 'true';

let shippingAccessToken = '';
let shippingAccessTokenExpiresAt = 0;

/*
|--------------------------------------------------------------------------
| MongoDB
|--------------------------------------------------------------------------
*/

mongoose
    .connect(MONGO_URI, {
        serverSelectionTimeoutMS: 15000,
        autoIndex: true
    })
    .then(() => {
        console.log('تم الاتصال بقاعدة بيانات MongoDB بنجاح');
    })
    .catch((error) => {
        console.error('خطأ في الاتصال بقاعدة MongoDB:', error);
    });

/*
|--------------------------------------------------------------------------
| نموذج الشحنة
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

    return Number.isFinite(parsed)
        ? parsed
        : fallback;
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

/*
|--------------------------------------------------------------------------
| أسماء شركات الشحن
|--------------------------------------------------------------------------
*/

function normalizeCarrierCode(value) {
    if (!value) {
        return '';
    }

    const normalized =
        String(value)
            .trim()
            .toLowerCase()
            .replace(/[\s_-]/g, '');

    if (normalized.includes('smsa')) {
        return 'SMSA';
    }

    if (normalized.includes('aramex')) {
        return 'Aramex';
    }

    if (normalized.includes('redbox')) {
        return 'RedBox';
    }

    if (
        normalized.includes('spl') ||
        normalized.includes('saudipost')
    ) {
        return 'SPL';
    }

    if (normalized.includes('dhl')) {
        return 'DHL';
    }

    if (normalized.includes('naqel')) {
        return 'ناقل';
    }

    if (normalized.includes('imile')) {
        return 'iMile';
    }

    if (
        normalized.includes('jt') ||
        normalized.includes('j&t')
    ) {
        return 'J&T Express';
    }

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
    const optionName =
        cleanPublicText(company?.deliveryOptionName);

    const optionMapped =
        normalizeCarrierCode(optionName);

    if (optionMapped) {
        return optionMapped;
    }

    const companyName =
        cleanPublicText(company?.deliveryCompanyName);

    const companyMapped =
        normalizeCarrierCode(companyName);

    if (companyMapped) {
        return companyMapped;
    }

    if (
        optionName &&
        !looksTechnicalName(optionName)
    ) {
        return optionName;
    }

    if (
        companyName &&
        !looksTechnicalName(companyName)
    ) {
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

    const response =
        await fetch(
            `${SHIPPING_BASE_URL}/refreshToken`,
            {
                method: 'POST',

                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify({
                    refresh_token:
                        SHIPPING_REFRESH_TOKEN
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
        console.error(
            'تعذر إنشاء Access Token لمزود الشحن:',
            response.status
        );

        throw new Error('SHIPPING_PROVIDER_ERROR');
    }

    shippingAccessToken = token;

    shippingAccessTokenExpiresAt =
        Date.now() + (55 * 60 * 1000);

    return shippingAccessToken;
}

/*
|--------------------------------------------------------------------------
| طلب داخلي لمزود الشحن
|--------------------------------------------------------------------------
*/

async function shippingRequest(
    path,
    body,
    method = 'POST'
) {
    const accessToken =
        await getShippingAccessToken();

    const response =
        await fetch(
            `${SHIPPING_BASE_URL}/${path}`,
            {
                method,

                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,

                    Accept:
                        'application/json',

                    'Content-Type':
                        'application/json'
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

    if (
        !response.ok ||
        data.success === false
    ) {
        console.error(
            'خطأ داخلي من مزود الشحن:',
            {
                status: response.status,

                message:
                    data.message ||
                    data.error ||
                    data.errorMsg ||
                    raw?.slice(0, 500)
            }
        );

        throw new Error('SHIPPING_PROVIDER_ERROR');
    }

    return data;
}

function getDeliveryCompanies(data) {
    const options =
        data.deliveryCompany ||
        data.deliveryCompanies ||
        data.data ||
        [];

    return Array.isArray(options)
        ? options
        : [];
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

/*
|--------------------------------------------------------------------------
| إحصائيات عامة
|--------------------------------------------------------------------------
|
| لا نرسل بيانات العملاء أو أرقام التتبع أو روابط البوالص.
|
|--------------------------------------------------------------------------
*/

app.get(
    '/api/dashboard-stats',
    async (req, res) => {
        try {
            const stats =
                await Shipment.aggregate([
                    {
                        $group: {
                            _id: null,

                            totalOperations: {
                                $sum: 1
                            },

                            avgCost: {
                                $avg: '$price'
                            },

                            maxCost: {
                                $max: '$price'
                            }
                        }
                    }
                ]);

            const result =
                stats[0] || {
                    totalOperations: 0,
                    avgCost: 0,
                    maxCost: 0
                };

            res.json({
                success: true,

                totalOperations:
                    number(result.totalOperations),

                avgCost:
                    roundMoney(result.avgCost),

                maxCost:
                    roundMoney(result.maxCost)
            });

        } catch (error) {
            console.error(
                'خطأ في جلب الإحصائيات:',
                error
            );

            res
                .status(500)
                .json({
                    success: false,
                    message:
                        'تعذر جلب الإحصائيات حاليًا.'
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| استعلام أسعار الشحن
|--------------------------------------------------------------------------
|
| المهم:
| العميل يستلم السعر النهائي فقط.
| التكلفة الأصلية لا يتم إرسالها للمتصفح.
|
|--------------------------------------------------------------------------
*/

app.post(
    '/api/shipping-rates',
    async (req, res) => {
        const {
            origin_city,
            destination_city,
            weight,

            boxLength = 30,
            boxWidth = 30,
            boxHeight = 30

        } = req.body;

        if (
            !origin_city ||
            !destination_city ||
            number(weight) <= 0
        ) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        'أدخل مدينتي الإرسال والوصول والوزن.'
                });
        }

        if (
            number(boxLength) <= 0 ||
            number(boxWidth) <= 0 ||
            number(boxHeight) <= 0
        ) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        'أدخل أبعاد الشحنة بشكل صحيح.'
                });
        }

        try {
            const providerResult =
                await shippingRequest(
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

            const companies =
                getDeliveryCompanies(
                    providerResult
                );

            const rates =
                companies

                    .filter(
                        (company) =>
                            company.deliveryOptionId &&
                            Number.isFinite(
                                number(
                                    company.price,
                                    NaN
                                )
                            )
                    )

                    .map(
                        (company) => ({
                            carrier:
                                getCarrierDisplayName(
                                    company
                                ),

                            /*
                            | السعر النهائي فقط
                            */

                            price:
                                customerPrice(
                                    company.price,
                                    weight
                                ),

                            deliveryTime:
                                cleanPublicText(
                                    company.avgDeliveryTime ||
                                    company.estimatedDeliveryTime ||
                                    'حسب شركة الشحن'
                                ),

                            deliveryOptionId:
                                String(
                                    company.deliveryOptionId
                                )
                        })
                    );

            if (!rates.length) {
                return res
                    .status(422)
                    .json({
                        success: false,
                        message:
                            'لا توجد شركات شحن متاحة لهذا المسار حاليًا.'
                    });
            }

            res.json({
                success: true,
                rates
            });

        } catch (error) {
            console.error(
                'خطأ أثناء جلب أسعار الشحن:',
                error.message
            );

            res
                .status(502)
                .json({
                    success: false,
                    message:
                        'تعذر جلب أسعار الشحن حاليًا. حاول مرة أخرى بعد قليل.'
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| إنشاء شحنة حقيقية
|--------------------------------------------------------------------------
*/

app.post(
    '/api/create-shipment',
    async (req, res) => {
        const required = [
            'email',
            'contentsDescription',

            'senderName',
            'senderCity',
            'senderPhone',
            'senderAddress',

            'receiverName',
            'receiverCity',
            'receiverPhone',
            'receiverAddress',

            'deliveryOptionId',

            'weight',

            'boxLength',
            'boxWidth',
            'boxHeight'
        ];

        const missing =
            required.filter(
                (field) =>
                    !req.body[field]
            );

        if (missing.length) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        'يرجى تعبئة جميع بيانات الشحنة المطلوبة.'
                });
        }

        if (!ALLOW_LIVE_SHIPMENTS) {
            return res
                .status(403)
                .json({
                    success: false,
                    message:
                        'إصدار الشحنات غير متاح مؤقتًا أثناء مرحلة الاختبار.'
                });
        }

        const body = req.body;

        try {
            /*
            |--------------------------------------------------------------------------
            | إعادة التسعير من المصدر
            |--------------------------------------------------------------------------
            */

            const quote =
                await shippingRequest(
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

            const selected =
                getDeliveryCompanies(
                    quote
                ).find(
                    (company) =>
                        String(
                            company.deliveryOptionId
                        ) ===
                        String(
                            body.deliveryOptionId
                        )
                );

            if (!selected) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            'خيار الشحن المحدد لم يعد متاحًا. أعد جلب الأسعار واختر خيارًا جديدًا.'
                    });
            }

            const providerCost =
                number(selected.price);

            const finalPrice =
                customerPrice(
                    providerCost,
                    body.weight
                );

            const carrierName =
                getCarrierDisplayName(
                    selected
                );

            const orderId =
                `SUMSN-${Date.now()}-${crypto
                    .randomBytes(3)
                    .toString('hex')
                    .toUpperCase()}`;

            const order = {
                orderId,

                createShipment: false,

                deliveryOptionId:
                    number(
                        body.deliveryOptionId
                    ),

                storeName:
                    'SUMSN',

                payment_method:
                    'paid',

                amount:
                    finalPrice,

                amount_due:
                    0,

                shippingAmount:
                    providerCost,

                subtotal:
                    finalPrice,

                currency:
                    'SAR',

                packageCount:
                    1,

                packageWeight:
                    number(
                        body.weight
                    ),

                boxLength:
                    number(
                        body.boxLength
                    ),

                boxWidth:
                    number(
                        body.boxWidth
                    ),

                boxHeight:
                    number(
                        body.boxHeight
                    ),

                shippingNotes:
                    body.contentsDescription,

                item_description:
                    body.contentsDescription,

                senderInformation: {
                    senderFullName:
                        body.senderName,

                    senderMobile:
                        body.senderPhone,

                    senderCountry:
                        'SA',

                    senderCity:
                        body.senderCity,

                    senderAddressLine:
                        body.senderAddress,

                    senderShortAddressCode:
                        body.senderAddress
                },

                customer: {
                    name:
                        body.receiverName,

                    email:
                        body.email,

                    mobile:
                        body.receiverPhone,

                    address:
                        body.receiverAddress,

                    city:
                        body.receiverCity,

                    country:
                        'SA'
                }
            };

            await shippingRequest(
                'createOrder',
                order
            );

            const shipmentResult =
                await shippingRequest(
                    'createShipment',
                    {
                        orderId,

                        deliveryOptionId:
                            number(
                                body.deliveryOptionId
                            )
                    }
                );

            let labelUrl = '';

            try {
                const label =
                    await shippingRequest(
                        `print/${encodeURIComponent(
                            orderId
                        )}`,
                        undefined,
                        'GET'
                    );

                labelUrl =
                    label.printAWBURL ||
                    label.url ||
                    label.data?.printAWBURL ||
                    '';

            } catch (labelError) {
                console.warn(
                    'تعذر جلب رابط البوليصة:',
                    labelError.message
                );
            }

            const savedShipment =
                await Shipment.create({
                    fromCity:
                        body.senderCity,

                    toCity:
                        body.receiverCity,

                    weight:
                        number(
                            body.weight
                        ),

                    carrier:
                        carrierName,

                    price:
                        finalPrice,

                    deliveryTime:
                        cleanPublicText(
                            selected.avgDeliveryTime ||
                            selected.estimatedDeliveryTime ||
                            ''
                        ),

                    otoOrderId:
                        orderId,

                    otoShipmentId:
                        shipmentResult.shipmentId ||
                        shipmentResult.otoId ||
                        '',

                    trackingNumber:
                        shipmentResult.trackingNumber ||
                        shipmentResult.shipmentId ||
                        '',

                    labelUrl
                });

            if (transporter) {
                await transporter.sendMail({
                    from:
                        `"SUMSN" <${EMAIL_USER}>`,

                    to:
                        body.email,

                    subject:
                        'تم إنشاء شحنتك عبر SUMSN',

                    text:
                        `تم إنشاء شحنتك بنجاح عبر SUMSN.\n\n` +
                        `شركة الشحن: ${carrierName}\n` +
                        `رقم الطلب: ${orderId}\n` +
                        `رقم التتبع: ${
                            savedShipment.trackingNumber ||
                            'سيتم توفيره قريبًا'
                        }\n` +
                        `الإجمالي: ${finalPrice.toFixed(2)} ريال\n` +
                        (
                            labelUrl
                                ? `رابط البوليصة: ${labelUrl}`
                                : ''
                        )
                });
            }

            res.json({
                success: true,

                orderId,

                carrier:
                    carrierName,

                shipmentId:
                    savedShipment.otoShipmentId,

                trackingNumber:
                    savedShipment.trackingNumber,

                labelUrl,

                finalPrice
            });

        } catch (error) {
            console.error(
                'خطأ أثناء إنشاء الشحنة:',
                error
            );

            res
                .status(502)
                .json({
                    success: false,
                    message:
                        'تعذر إنشاء الشحنة حاليًا. حاول مرة أخرى أو تواصل مع الدعم.'
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| تشغيل السيرفر
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    () => {
        console.log(
            `السيرفر يعمل على http://localhost:${PORT}`
        );
    }
);