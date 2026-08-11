require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static('public')); // تشغيل تصميم موقعك الأساسي من مجلد public

// 1. الاتصال بقاعدة البيانات
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح'))
    .catch(err => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// 2. نموذج البيانات
const shipmentSchema = new mongoose.Schema({
    fromCity: String,
    toCity: String,
    weight: Number,
    carrier: String,
    price: Number,
    deliveryTime: String,
    createdAt: { type: Date, default: Date.now }
});

const Shipment = mongoose.model('Shipment', shipmentSchema);

// 3. إعداد خدمة البريد
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ==========================================
// 🏠 صفحات نتيجة الدفع (النجاح والإلغاء)
// ==========================================
app.get('/payment-success', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>تم الدفع بنجاح</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background-color: #f8f9fa; }
                .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); display: inline-block; }
                h1 { color: #28a745; }
                a { display: inline-block; margin-top: 20px; padding: 10px 25px; background: #007bff; color: white; text-decoration: none; border-radius: 6px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🎉 تم الدفع بنجاح!</h1>
                <p>شكراً لك، تم استلام المبلغ وإصدار البوليصة بنجاح.</p>
                <a href="/">العودة للموقع الرئيسي</a>
            </div>
        </body>
        </html>
    `);
});

app.get('/payment-cancel', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>تم إلغاء الدفع</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background-color: #f8f9fa; }
                .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); display: inline-block; }
                h1 { color: #dc3545; }
                a { display: inline-block; margin-top: 20px; padding: 10px 25px; background: #6c757d; color: white; text-decoration: none; border-radius: 6px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>❌ تم إلغاء عملية الدفع</h1>
                <p>لم يتم خصم أي مبلغ.</p>
                <a href="/">العودة للموقع الرئيسي</a>
            </div>
        </body>
        </html>
    `);
});

// ==========================================
// 🔌 APIs النظام
// ==========================================

// جلب الإحصائيات
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const shipments = await Shipment.find();
        const totalOperations = shipments.length;
        let totalPrice = 0;
        let maxCost = 0;

        shipments.forEach(item => {
            totalPrice += item.price;
            if (item.price > maxCost) maxCost = item.price;
        });

        const avgCost = totalOperations > 0 ? Math.round(totalPrice / totalOperations) : 0;

        res.json({ success: true, totalOperations, avgCost, maxCost, shipments });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في جلب البيانات' });
    }
});

// حساب أسعار الشحن
app.post('/api/shipping-rates', async (req, res) => {
    const { origin_city, destination_city, weight } = req.body;
    let baseProviderCost = 24; 
    let additionalWeightFee = 0;
    const maxBaseWeight = 15;
    const parsedWeight = parseFloat(weight) || 1;
    
    if (parsedWeight > maxBaseWeight) {
        additionalWeightFee = (parsedWeight - maxBaseWeight) * 2;
    }

    const profitMargin = 10;
    let calculatedBasePrice = baseProviderCost + profitMargin + additionalWeightFee;

    const rates = [
        { carrier: 'أرامكس (Aramex)', price: calculatedBasePrice, deliveryTime: '2-3 أيام عمل' },
        { carrier: 'سمسا (SMSA)', price: calculatedBasePrice + 5, deliveryTime: 'يوم - يومين' },
        { carrier: 'دي إتش إل (DHL)', price: calculatedBasePrice + 25, deliveryTime: 'يوم واحد' }
    ];

    try {
        for (let rate of rates) {
            const newShipment = new Shipment({
                fromCity: origin_city,
                toCity: destination_city,
                weight: parsedWeight,
                carrier: rate.carrier,
                price: rate.price,
                deliveryTime: rate.deliveryTime
            });
            await newShipment.save();
        }
        res.json({ success: true, rates });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل حفظ العمليات في قاعدة البيانات' });
    }
});

// إنشاء فاتورة PayLink
app.post('/api/create-paylink-invoice', async (req, res) => {
    try {
        const { amount, customerName, customerEmail, customerPhone, carrier } = req.body;

        const authResponse = await axios.post('https://restapi.paylink.sa/api/auth', {
            apiId: process.env.PAYLINK_API_ID,
            secretKey: process.env.PAYLINK_SECRET_KEY,
            persistToken: false
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        const token = authResponse.data?.id_token;

        if (!token) {
            return res.status(401).json({ success: false, message: 'فشل جلب توكن المصادقة من بيلينك' });
        }

        const paylinkData = {
            orderNumber: "INV-" + Date.now(),
            amount: parseFloat(amount),
            callBackUrl: "http://localhost:3000/payment-success",
            cancelUrl: "http://localhost:3000/payment-cancel",
            clientName: customerName || "عميلنا العزيز",
            clientEmail: customerEmail,
            clientMobile: customerPhone || "0500000000",
            products: [{ title: `بوليصة شحن عبر ${carrier || 'شركة الشحن'}`, price: parseFloat(amount), qty: 1 }],
            meta: { carrier, email: customerEmail, name: customerName }
        };

        const invoiceResponse = await axios.post('https://restapi.paylink.sa/api/addInvoice', paylinkData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (invoiceResponse.data && (invoiceResponse.data.url || invoiceResponse.data.invoiceUrl)) {
            res.json({ success: true, paymentUrl: invoiceResponse.data.url || invoiceResponse.data.invoiceUrl });
        } else {
            res.status(400).json({ success: false, message: 'فشل في إنشاء فاتورة الدفع من بيلينك' });
        }

    } catch (error) {
        console.error('❌ تفاصيل خطأ PayLink:', error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            message: 'حدث خطأ أثناء الاتصال ببوابة الدفع: ' + (error.response?.data?.message || error.message) 
        });
    }
});

// إرسال البوليصة يدوياً
app.post('/api/send-policy', async (req, res) => {
    const { email, senderName, carrier, price } = req.body;

    const mailOptions = {
        from: `"منصة SUMSN للشحن" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'تم إصدار بوليصة الشحن الخاصة بك',
        text: `أهلاً ${senderName}، تم إصدار بوليصتك بنجاح عبر شركة ${carrier} بقيمة ${price} ريال.`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'تم إرسال البوليصة للإيميل بنجاح!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل إرسال الإيميل' });
    }
});

// Webhook الخاص بـ Moyasar (مستقر ومحتفظ به)
app.post('/api/moyasar-webhook', async (req, res) => {
    try {
        const paymentData = req.body;

        if (paymentData && paymentData.type === 'payment.paid') {
            const payment = paymentData.data;
            const customerEmail = payment.metadata?.email;
            const customerName = payment.metadata?.name || 'عميلنا العزيز';
            const carrier = payment.metadata?.carrier || 'شركة الشحن المختارة';
            const price = payment.amount / 100;

            if (customerEmail) {
                const mailOptions = {
                    from: `"منصة SUMSN للشحن" <${process.env.EMAIL_USER}>`,
                    to: customerEmail,
                    subject: 'تم تأكيد الدفع وإصدار بوليصة الشحن الخاصة بك',
                    text: `أهلاً ${customerName}، تم استلام مبلغ ${price} ريال بنجاح، وتم إصدار بوليصتك عبر شركة ${carrier}.`
                };

                await transporter.sendMail(mailOptions);
                console.log(`✅ تم إرسال البوليصة تلقائياً إلى: ${customerEmail}`);
            }
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('❌ خطأ في معالجة الـ Webhook:', error);
        res.status(500).json({ received: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل على http://localhost:${PORT}`));