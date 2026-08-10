require('dotenv').config(); // تفعيل قراءة ملف البيئة .env
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// 1. الاتصال بقاعدة بيانات MongoDB Atlas عبر الرابط الموجود في ملف .env
mongoose.connect(process.env.MONGO_URI)
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

// إعداد خدمة البريد باستخدام البيانات المأخوذة من ملف .env
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
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
        from: `"منصة SUMSN للشحن" <${process.env.EMAIL_USER}>`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل على http://localhost:${PORT}`));