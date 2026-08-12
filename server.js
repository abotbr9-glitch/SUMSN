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
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sumsn_db';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
// القيمة التي توفرها لوحة OTO هي Refresh Token، وليست Access Token مباشرة.
// ندعم الاسم القديم مؤقتًا حتى لا يحتاج المستخدم لتغيير ملف .env الآن.
const OTO_REFRESH_TOKEN = process.env.OTO_REFRESH_TOKEN || process.env.OTO_API_KEY;
const OTO_BASE_URL = 'https://api.tryoto.com/rest/v2';
const SUMSN_MARKUP = Number(process.env.SUMSN_MARKUP || 10);
const INCLUDED_WEIGHT_KG = Number(process.env.INCLUDED_WEIGHT_KG || 15);
const EXTRA_KG_PRICE = Number(process.env.EXTRA_KG_PRICE || 2);
const ALLOW_LIVE_SHIPMENTS = process.env.ALLOW_LIVE_SHIPMENTS === 'true';
let otoAccessToken = '';
let otoAccessTokenExpiresAt = 0;

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000, autoIndex: true })
    .then(() => console.log('تم الاتصال بقاعدة بيانات MongoDB بنجاح'))
    .catch((error) => console.error('خطأ في الاتصال بقاعدة MongoDB:', error));

const shipmentSchema = new mongoose.Schema({
    fromCity: { type: String, required: true },
    toCity: { type: String, required: true },
    weight: { type: Number, required: true },
    carrier: { type: String, required: true },
    price: { type: Number, required: true },
    deliveryTime: { type: String, default: '' },
    otoOrderId: String,
    otoShipmentId: String,
    trackingNumber: String,
    labelUrl: String,
    createdAt: { type: Date, default: Date.now }
});
const Shipment = mongoose.model('Shipment', shipmentSchema);

const transporter = EMAIL_USER && EMAIL_PASS
    ? nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } })
    : null;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function excessWeightFee(weight) {
    return Math.max(0, number(weight) - INCLUDED_WEIGHT_KG) * EXTRA_KG_PRICE;
}

function customerPrice(otoPrice, weight) {
    return Number((number(otoPrice) + SUMSN_MARKUP + excessWeightFee(weight)).toFixed(2));
}

async function getOtoAccessToken() {
    if (otoAccessToken && Date.now() < otoAccessTokenExpiresAt) {
        return otoAccessToken;
    }

    if (!OTO_REFRESH_TOKEN) {
        throw new Error('لم يتم العثور على OTO_REFRESH_TOKEN في ملف .env');
    }

    const response = await fetch(`${OTO_BASE_URL}/refreshToken`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: OTO_REFRESH_TOKEN })
    });
    const raw = await response.text();
    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { message: raw };
    }
    const token = data.access_token || data.accessToken || data.data?.access_token || data.data?.accessToken;
    if (!response.ok || !token) {
        throw new Error(data.message || data.error || 'فشل OTO في إنشاء Access Token');
    }

    otoAccessToken = token;
    // رمز الوصول صالح ساعة بحسب OTO، لذلك نُجدّده قبل خمس دقائق من انتهائه.
    otoAccessTokenExpiresAt = Date.now() + (55 * 60 * 1000);
    return otoAccessToken;
}

async function otoRequest(path, body, method = 'POST') {
    const accessToken = await getOtoAccessToken();

    const response = await fetch(`${OTO_BASE_URL}/${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: method === 'GET' ? undefined : JSON.stringify(body)
    });

    const raw = await response.text();
    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { message: raw };
    }

    if (!response.ok || data.success === false) {
        const details = data.message
            || data.error
            || data.errorMsg
            || data.otoErrorMessage
            || data.otoErrorCode
            || (raw ? raw.slice(0, 1000) : '');
        const message = details || `OTO API returned ${response.status}`;
        throw new Error(message);
    }
    return data;
}

function getDeliveryCompanies(data) {
    const options = data.deliveryCompany || data.deliveryCompanies || data.data || [];
    return Array.isArray(options) ? options : [];
}

function quotePayload(originCity, destinationCity, weight, boxLength, boxWidth, boxHeight) {
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

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const shipments = await Shipment.find().sort({ createdAt: -1 });
        const prices = shipments.map((shipment) => number(shipment.price));
        const total = prices.reduce((sum, price) => sum + price, 0);
        res.json({
            success: true,
            totalOperations: shipments.length,
            avgCost: shipments.length ? Math.round(total / shipments.length) : 0,
            maxCost: prices.length ? Math.max(...prices) : 0,
            shipments
        });
    } catch (error) {
        console.error('خطأ في جلب الإحصائيات:', error);
        res.status(500).json({ success: false, message: 'تعذر جلب الإحصائيات.' });
    }
});

// أسعار حقيقية من OTO. لا تنشئ هذه العملية شحنة ولا تخصم من رصيدك.
app.post('/api/shipping-rates', async (req, res) => {
    const { origin_city, destination_city, weight, boxLength = 30, boxWidth = 30, boxHeight = 30 } = req.body;
    if (!origin_city || !destination_city || number(weight) <= 0) {
        return res.status(400).json({ success: false, message: 'أدخل مدينتي الإرسال والوصول والوزن.' });
    }

    try {
        const oto = await otoRequest('checkOTODeliveryFee', quotePayload(
            origin_city.trim(), destination_city.trim(), weight, boxLength, boxWidth, boxHeight
        ));
        const companies = getDeliveryCompanies(oto);
        const rates = companies
            .filter((company) => company.deliveryOptionId && Number.isFinite(number(company.price, NaN)))
            .map((company) => ({
                carrier: company.deliveryCompanyName || company.deliveryOptionName || 'شركة شحن OTO',
                price: number(company.price), // السعر الحقيقي من OTO قبل ربح SUMSN
                deliveryTime: company.avgDeliveryTime || company.estimatedDeliveryTime || 'حسب شركة الشحن',
                deliveryOptionId: String(company.deliveryOptionId)
            }));

        if (!rates.length) {
            return res.status(422).json({ success: false, message: 'لم تُرجع OTO شركات متاحة لهذا المسار.' });
        }
        res.json({ success: true, rates });
    } catch (error) {
        console.error('خطأ OTO عند جلب الأسعار:', error.message);
        res.status(502).json({ success: false, message: `تعذر جلب أسعار OTO: ${error.message}` });
    }
});

// إنشاء شحنة حقيقية: محمي بمتغير ALLOW_LIVE_SHIPMENTS حتى لا تُخصم أي مبالغ أثناء اختبار الأسعار.
app.post('/api/create-shipment', async (req, res) => {
    const required = [
        'email', 'contentsDescription', 'senderName', 'senderCity', 'senderPhone', 'senderAddress',
        'receiverName', 'receiverCity', 'receiverPhone', 'receiverAddress', 'deliveryOptionId', 'weight',
        'boxLength', 'boxWidth', 'boxHeight'
    ];
    const missing = required.filter((field) => !req.body[field]);
    if (missing.length) {
        return res.status(400).json({ success: false, message: `بيانات ناقصة: ${missing.join(', ')}` });
    }
    if (!ALLOW_LIVE_SHIPMENTS) {
        return res.status(403).json({
            success: false,
            message: 'إنشاء الشحنات الحقيقية مغلق مؤقتًا. اختبر الأسعار أولًا، ثم فعّله قبل اختبار شحنة واحدة.'
        });
    }

    const body = req.body;
    try {
        // نعيد التسعير من OTO لحماية الربط من أي قيمة معدّلة في المتصفح.
        const quote = await otoRequest('checkOTODeliveryFee', quotePayload(
            body.senderCity.trim(), body.receiverCity.trim(), body.weight,
            body.boxLength, body.boxWidth, body.boxHeight
        ));
        const selected = getDeliveryCompanies(quote).find(
            (company) => String(company.deliveryOptionId) === String(body.deliveryOptionId)
        );
        if (!selected) {
            return res.status(409).json({ success: false, message: 'الخيار المحدد لم يعد متاحًا. أعد جلب الأسعار واختر خيارًا جديدًا.' });
        }

        const otoCost = number(selected.price);
        const finalPrice = customerPrice(otoCost, body.weight);
        const orderId = `SUMSN-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const order = {
            orderId,
            createShipment: false,
            deliveryOptionId: number(body.deliveryOptionId),
            storeName: 'SUMSN',
            payment_method: 'paid',
            amount: finalPrice,
            amount_due: 0,
            shippingAmount: otoCost,
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
                senderFullName: body.senderName,
                senderMobile: body.senderPhone,
                senderCountry: 'SA',
                senderCity: body.senderCity,
                senderAddressLine: body.senderAddress,
                senderShortAddressCode: body.senderAddress
            },
            customer: {
                name: body.receiverName,
                email: body.email,
                mobile: body.receiverPhone,
                address: body.receiverAddress,
                city: body.receiverCity,
                country: 'SA'
            }
        };

        const createdOrder = await otoRequest('createOrder', order);
        const shipmentResult = await otoRequest('createShipment', {
            orderId,
            deliveryOptionId: number(body.deliveryOptionId)
        });

        let labelUrl = '';
        try {
            const label = await otoRequest(`print/${encodeURIComponent(orderId)}`, undefined, 'GET');
            labelUrl = label.printAWBURL || label.url || label.data?.printAWBURL || '';
        } catch (labelError) {
            console.warn('تعذر جلب رابط البوليصة:', labelError.message);
        }

        const savedShipment = await Shipment.create({
            fromCity: body.senderCity,
            toCity: body.receiverCity,
            weight: number(body.weight),
            carrier: selected.deliveryCompanyName || body.carrier || 'شركة شحن OTO',
            price: finalPrice,
            deliveryTime: selected.avgDeliveryTime || '',
            otoOrderId: orderId,
            otoShipmentId: shipmentResult.shipmentId || shipmentResult.otoId || '',
            trackingNumber: shipmentResult.trackingNumber || shipmentResult.shipmentId || '',
            labelUrl
        });

        if (transporter) {
            await transporter.sendMail({
                from: `"SUMSN" <${EMAIL_USER}>`,
                to: body.email,
                subject: 'تم إنشاء شحنتك عبر SUMSN',
                text: `تم إنشاء شحنتك بنجاح. رقم الطلب: ${orderId}\nرقم التتبع: ${savedShipment.trackingNumber || 'سيظهر في OTO قريبًا'}\n${labelUrl ? `رابط البوليصة: ${labelUrl}` : ''}`
            });
        }

        res.json({ success: true, orderId, shipmentId: savedShipment.otoShipmentId, trackingNumber: savedShipment.trackingNumber, labelUrl, finalPrice });
    } catch (error) {
        console.error('خطأ OTO عند إنشاء الشحنة:', error.message);
        res.status(502).json({ success: false, message: `تعذر إنشاء الشحنة لدى OTO: ${error.message}` });
    }
});

app.post('/api/send-policy', async (req, res) => {
    const { email, senderName, carrier, price } = req.body;
    if (!email || !senderName || !carrier) {
        return res.status(400).json({ success: false, message: 'البيانات المطلوبة غير مكتملة.' });
    }
    if (!transporter) {
        return res.status(500).json({ success: false, message: 'إعدادات البريد غير مكتملة في .env.' });
    }
    try {
        await transporter.sendMail({
            from: `"SUMSN" <${EMAIL_USER}>`,
            to: email,
            subject: 'تم إصدار بوليصة الشحن',
            text: `أهلًا ${senderName}، تم إصدار بوليصتك عبر ${carrier} بقيمة ${price} ريال.`
        });
        res.json({ success: true, message: 'تم إرسال البوليصة إلى البريد.' });
    } catch (error) {
        console.error('خطأ إرسال البريد:', error);
        res.status(500).json({ success: false, message: 'فشل إرسال البريد.' });
    }
});

app.listen(PORT, () => console.log(`السيرفر يعمل على http://localhost:${PORT}`));
