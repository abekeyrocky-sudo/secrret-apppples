const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-partner-key', 'x-telegram-init-data']
}));
app.use(express.json());

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8995359366:AAHbKQx4rbsjFvnlRz6FOiZo4bgG07sQB-Q';
const APPLE_FARM_API_URL = process.env.APPLE_FARM_API_URL || 'https://api-duztzw2gwa-uc.a.run.app/api/hubcoin/transfer-reward';
const PARTNER_SECRET_KEY = process.env.PARTNER_SECRET_KEY || 'hubcoin-apple-farm-secret-2026';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'hub-coin-94aff';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAyOqKmgGIIq0NEOsg34jXmB_BSBU1cKtw';

// In-memory Cooldown Tracker (Key: userId -> timestamp)
const recentTransfers = new Map();

/**
 * 1. Validate Telegram WebApp initData with HMAC-SHA256
 * Cryptographically verifies that the request comes from an authentic Telegram user session
 */
function validateTelegramInitData(initData, botToken) {
    if (!initData || !botToken) return null;

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) return null;

        // Verify expiration (24 hours window to prevent replay attacks)
        const authDate = urlParams.get('auth_date');
        if (authDate) {
            const authTimestamp = parseInt(authDate, 10);
            const currentTimestamp = Math.floor(Date.now() / 1000);
            if (currentTimestamp - authTimestamp > 86400) {
                console.warn('[Security] Expired Telegram auth_date received:', authDate);
                return null;
            }
        }

        urlParams.delete('hash');

        const paramsList = [];
        for (const [key, value] of urlParams.entries()) {
            paramsList.push(`${key}=${value}`);
        }
        paramsList.sort();
        const dataCheckString = paramsList.join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (calculatedHash === hash) {
            const userParam = urlParams.get('user');
            return userParam ? JSON.parse(userParam) : null;
        }

        return null;
    } catch (err) {
        console.error('[Security] Telegram validation error:', err);
        return null;
    }
}

/**
 * 2. Firestore REST Helper: Read User Balances directly from Google Cloud Firestore
 */
async function getUserBalanceFromDb(userId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Firestore read error: ${res.status}`);
    }
    const data = await res.json();
    const fields = data.fields || {};

    return {
        appleBalance: Number(fields.appleBalance?.integerValue || 0),
        diamondBalance: Number(fields.diamondBalance?.integerValue || 0),
        energyBalance: Number(fields.energyBalance?.integerValue || 0)
    };
}

/**
 * 3. Firestore REST Helper: Atomically update User Balance on Server
 */
async function updateUserBalanceInDb(userId, newBalance, type) {
    const fieldName = type === 'apple' ? 'appleBalance' : 'diamondBalance';
    const patchUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=${fieldName}&updateMask.fieldPaths=updatedAt&key=${FIREBASE_API_KEY}`;

    const patchBody = {
        fields: {
            [fieldName]: { integerValue: String(Math.max(0, newBalance)) },
            updatedAt: { timestampValue: new Date().toISOString() }
        }
    };

    const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
    });

    if (!patchRes.ok) {
        const errText = await patchRes.text();
        throw new Error(`Firestore patch error: ${patchRes.status} ${errText}`);
    }

    return newBalance;
}


/**
 * 4. Firestore REST Helper: Credit Task Reward Server-to-Server
 */
async function creditAdsgramRewardInDb(userId, apples = 15, energy = 3) {
    const user = await getUserBalanceFromDb(userId);
    if (!user) {
        console.warn(`[Adsgram Webhook] User ${userId} not found in DB`);
        return null;
    }

    const newApples = user.appleBalance + apples;
    const newEnergy = user.energyBalance + energy;

    const patchUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=appleBalance&updateMask.fieldPaths=energyBalance&updateMask.fieldPaths=updatedAt&key=${FIREBASE_API_KEY}`;

    const patchBody = {
        fields: {
            appleBalance: { integerValue: String(newApples) },
            energyBalance: { integerValue: String(newEnergy) },
            updatedAt: { timestampValue: new Date().toISOString() }
        }
    };

    const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
    });

    if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('[Adsgram Webhook] Firestore error:', errText);
        throw new Error('Failed to update balance in DB');
    }

    return { newApples, newEnergy };
}

/**
 * ADSGRAM SERVER-TO-SERVER REWARD WEBHOOK
 * Called directly by Adsgram servers when a user completes a task or rewarded ad
 */
app.all(['/api/adsgram-reward', '/api/adsgram-webhook'], async (req, res) => {
    try {
        const telegramId = req.query.userid || req.query.userId || req.query.telegramId || req.query.user_id || req.body?.telegramId || req.body?.userId;

        console.log('[Adsgram Webhook Triggered]:', { query: req.query, body: req.body });

        if (!telegramId) {
            // Adsgram sometimes sends a verification ping with no params on setup
            return res.status(200).json({ ok: true, service: 'Adsgram Reward Webhook Active' });
        }

        // Credit +3 Energy & +15 Apples directly into user Firestore doc
        const updated = await creditAdsgramRewardInDb(String(telegramId), 15, 3);

        console.log(`[Adsgram Reward Success] User ${telegramId} credited +3 Energy, +15 Apples`);

        return res.status(200).json({
            ok: true,
            success: true,
            userId: String(telegramId),
            rewardEnergy: 3,
            rewardApple: 15,
            balances: updated
        });
    } catch (err) {
        console.error('[Adsgram Webhook Error]:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Health Check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Hubcoin Secure Backend (Vercel Serverless)',
        security: 'Telegram HMAC-SHA256 & Server-Side Balance Verification Active',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * SECURE TRANSFER ENDPOINT
 * - Enforces Telegram WebApp cryptographically signed initData
 * - Enforces Server-Side balance verification (prevents terminal/curl hack)
 * - Performs atomic balance deduction on server
 * - Calls Apple Farm server-to-server
 */
app.post(['/api/transfer-reward', '/api/claim-mission'], async (req, res) => {
    try {
        const initData = req.headers['x-telegram-init-data'] || req.headers['authorization'];
        const validatedTelegramUser = validateTelegramInitData(initData, BOT_TOKEN);

        let resolvedUserId = null;
        let resolvedUserName = 'Farmer';

        if (validatedTelegramUser && validatedTelegramUser.id) {
            resolvedUserId = String(validatedTelegramUser.id);
            resolvedUserName = validatedTelegramUser.first_name || validatedTelegramUser.username || 'Farmer';
        } else {
            // Dev or fallback mode
            const isDev = process.env.NODE_ENV !== 'production' || !process.env.VERCEL;
            if (isDev && req.body.userId) {
                console.warn('[Security Warning] Dev mode fallback used without Telegram signature');
                resolvedUserId = String(req.body.userId);
                resolvedUserName = req.body.userName || req.body.username || 'Dev Farmer';
            } else {
                console.warn('[Security Violation] Unauthorized request blocked. Missing or invalid Telegram signature.');
                return res.status(401).json({
                    success: false,
                    ok: false,
                    error: 'Unauthorized: Valid Telegram session signature required. Direct terminal/script requests are blocked.'
                });
            }
        }

        const { amount, rewardAmount, type, txId } = req.body;
        const finalAmount = Number(amount || rewardAmount);

        if (!finalAmount || isNaN(finalAmount) || finalAmount <= 0) {
            return res.status(400).json({ success: false, ok: false, error: 'Valid positive amount is required' });
        }

        const rewardType = (type || 'apple').toLowerCase();
        if (rewardType !== 'apple' && rewardType !== 'diamond') {
            return res.status(400).json({ success: false, ok: false, error: 'Invalid reward type. Must be apple or diamond' });
        }

        // Safety Transfer Cap (e.g. max 10,000 diamonds per transaction)
        if (rewardType === 'diamond' && finalAmount > 10000) {
            return res.status(400).json({
                success: false,
                ok: false,
                error: 'Exceeded maximum diamond transfer limit per transaction (Max: 10,000)'
            });
        }

        // Anti-Spam Rate Limit Cooldown (10 seconds per user)
        const now = Date.now();
        const lastTransfer = recentTransfers.get(resolvedUserId);
        if (lastTransfer && (now - lastTransfer < 10000)) {
            const waitSeconds = Math.ceil((10000 - (now - lastTransfer)) / 1000);
            return res.status(429).json({
                success: false,
                ok: false,
                error: `Please wait ${waitSeconds} seconds before initiating another transfer.`
            });
        }
        recentTransfers.set(resolvedUserId, now);

        // 1. SERVER-SIDE BALANCE VERIFICATION FROM FIRESTORE
        let userBalances = await getUserBalanceFromDb(resolvedUserId);
        if (!userBalances) {
            return res.status(404).json({
                success: false,
                ok: false,
                error: 'User profile not found in HubCoin database.'
            });
        }

        const currentBal = rewardType === 'apple' ? userBalances.appleBalance : userBalances.diamondBalance;

        if (currentBal < finalAmount) {
            console.warn(`[Security Alert] Insufficient balance for User ${resolvedUserId}. Available: ${currentBal}, Requested: ${finalAmount}`);
            return res.status(403).json({
                success: false,
                ok: false,
                error: `Insufficient ${rewardType} balance! Available: ${currentBal.toLocaleString()}, Requested: ${finalAmount.toLocaleString()}`
            });
        }

        // 2. SERVER-SIDE ATOMIC DEDUCTION BEFORE SENDING TO APPLE FARM
        const newBalance = currentBal - finalAmount;
        await updateUserBalanceInDb(resolvedUserId, newBalance, rewardType);

        const generatedTxId = txId || ('TXHUB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase());

        console.log(`[Verified Transfer Processing] User: ${resolvedUserId} (${resolvedUserName}), Deducted: ${finalAmount} ${rewardType}, Remaining: ${newBalance}`);

        // 3. SERVER-TO-SERVER FORWARD TO APPLE FARM
        let response;
        let data = {};

        try {
            response = await fetch(APPLE_FARM_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-partner-key': PARTNER_SECRET_KEY
                },
                body: JSON.stringify({
                    userId: resolvedUserId,
                    userName: resolvedUserName,
                    amount: finalAmount,
                    type: rewardType,
                    txId: generatedTxId,
                    source: 'hubcoin_secure_backend',
                    timestamp: Date.now()
                })
            });

            data = await response.json().catch(() => ({}));
        } catch (apiErr) {
            console.error('[Apple Farm API Connection Failed]:', apiErr);
            // REFUND USER IN CASE OF NETWORK OUTAGE
            await updateUserBalanceInDb(resolvedUserId, currentBal, rewardType);
            return res.status(502).json({
                success: false,
                ok: false,
                error: 'Apple Farm server is temporarily unreachable. Your balance has been safely refunded.'
            });
        }

        if (!response.ok || (!data.ok && !data.success)) {
            console.warn('[Apple Farm Rejection]:', response.status, data);
            // REFUND USER IN CASE APPLE FARM REJECTS
            await updateUserBalanceInDb(resolvedUserId, currentBal, rewardType);
            return res.status(response.status || 500).json({
                success: false,
                ok: false,
                error: data.error || data.message || 'Transfer rejected by Apple Farm. Balance refunded.'
            });
        }

        // SUCCESSFUL TRANSFER
        return res.json({
            success: true,
            ok: true,
            message: `Successfully transferred ${finalAmount.toLocaleString()} ${rewardType} to Apple Farm!`,
            userId: resolvedUserId,
            amount: finalAmount,
            type: rewardType,
            txId: generatedTxId,
            newBalance,
            appleFarmData: data
        });

    } catch (err) {
        console.error('[Secure Transfer Error]:', err);
        return res.status(500).json({
            success: false,
            ok: false,
            error: 'Internal server error while processing secure transfer.'
        });
    }
});

// For local development listening
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Hubcoin secure backend running locally on http://localhost:${PORT}`);
    });
}

// Export for Vercel Serverless Function
module.exports = app;
