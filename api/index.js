const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-partner-key']
}));
app.use(express.json());

// Configs
const APPLE_FARM_API_URL = process.env.APPLE_FARM_API_URL || 'https://api-duztzw2gwa-uc.a.run.app/api/hubcoin/transfer-reward';
const PARTNER_SECRET_KEY = process.env.PARTNER_SECRET_KEY || 'hubcoin-apple-farm-secret-2026';

// Health Check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Hubcoin Backend (Vercel Serverless)',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Transfer Reward / Claim Mission Handler (Proxy to Apple Farm Backend)
app.post(['/api/transfer-reward', '/api/claim-mission'], async (req, res) => {
    try {
        const { userId, username, userName, amount, rewardAmount, type, txId } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, ok: false, error: 'User ID is required' });
        }

        const finalAmount = Number(amount || rewardAmount) || 50;
        const rewardType = (type || 'apple').toLowerCase();
        const generatedTxId = txId || ('TXHUB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase());
        const farmerName = userName || username || 'Farmer';

        console.log(`[Transfer/Claim Request] User: ${userId} (${farmerName}), Amount: ${finalAmount} ${rewardType}, TX: ${generatedTxId}`);

        // Server-to-Server Request to Apple Farm Backend
        const response = await fetch(APPLE_FARM_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-partner-key': PARTNER_SECRET_KEY
            },
            body: JSON.stringify({
                userId: String(userId),
                userName: farmerName,
                amount: finalAmount,
                type: rewardType,
                txId: generatedTxId,
                source: 'hubcoin',
                timestamp: Date.now()
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || (!data.ok && !data.success)) {
            console.warn('[Apple Farm Error]:', response.status, data);
            return res.status(response.status || 500).json({
                success: false,
                ok: false,
                error: data.error || data.message || 'Failed to transfer to Apple Farm'
            });
        }

        return res.json({
            success: true,
            ok: true,
            message: data.message || `Successfully transferred ${finalAmount} ${rewardType} to Apple Farm!`,
            userId,
            amount: finalAmount,
            type: rewardType,
            txId: generatedTxId,
            appleFarmData: data
        });

    } catch (err) {
        console.error('[Transfer Error]:', err);
        return res.status(500).json({ success: false, ok: false, error: 'Internal server error while processing transfer' });
    }
});

// For local development listening
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Hubcoin backend running locally on http://localhost:${PORT}`);
    });
}

// Export for Vercel Serverless Function
module.exports = app;
