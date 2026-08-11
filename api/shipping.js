const { MongoClient } = require('mongodb');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }

    const { originCity, destinationCity, weight } = req.body;

    try {
        const client = await MongoClient.connect(process.env.MONGODB_URI);
        const db = client.db('shipping_db');
        
        const otoResponse = await fetch('https://api.tryoto.com/rest/v2/checkOTODeliveryFee', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${process.env.OTO_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ originCity, destinationCity, weight })
        });

        const otoData = await otoResponse.json();

        await db.collection('orders').insertOne({
            originCity,
            destinationCity,
            weight,
            otoData,
            createdAt: new Date()
        });

        client.close();

        res.status(200).json({ success: true, rates: otoData });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}