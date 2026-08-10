const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// 1. الاتصال بقاعدة بيانات MongoDB (يمكنك استبدال الرابط برابط حسابك على MongoDB Atlas أو استخدام قاعدة محلية)
const MONGO_URI = 'mongodb://127.0.0.1:27017/sumsn_db'; // قاعدة بيانات محلية باسم sumsn_db

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح'))
    .catch(err => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// 2. تصميم شكل البيانات (Schema) في قاعدة البيانات
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

// إعداد خدمة البريد
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'YOUR_EMAIL@gmail.com',
        pass: 'YOUR_APP_PASSWORD'
    }
});

// API: جلب الإحصائيات والعمليات المسجلة من قاعدة البيانات مباشرة
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

        res.json({
            success: true,
            totalOperations,
            avgCost,
            maxCost,
            shipments
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في جلب البيانات' });
    }
});

// API: حساب أسعار الشحن وحفظها تلقائياً في MongoDB
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
        // حفظ كل شركة مقترحة في قاعدة البيانات كعملية جديدة
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
        console.error(error);
        res.status(500).json({ success: false, message: 'فشل حفظ العمليات في قاعدة البيانات' });
    }
});

// API: إرسال البوليصة عبر الإيميل
app.post('/api/send-policy', async (req, res) => {
    const { email, senderName, carrier, price } = req.body;

    const mailOptions = {
        from: '"منصة SUMSN للشحن" <YOUR_EMAIL@gmail.com>',
        to: email,
        subject: 'تم إصدار بوليصة الشحن الخاصة بك',
        text: `أهلاً ${senderName}، تم إصدار بوليصتك بنجاح عبر شركة ${carrier} بقيمة ${price} ريال.`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'تم إرسال البوليصة للإيميل بنجاح!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'فشل إرسال الإيميل' });
    }
});

app.listen(3000, () => console.log('السيرفر يعمل على http://localhost:3000'));