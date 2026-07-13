"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const qrcode_1 = __importDefault(require("qrcode"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const fs_1 = __importDefault(require("fs"));
// ═══════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════
const PORT = Number(process.env.PORT || process.env.WA_BOT_PORT) || 3002;
const API_SECRET = process.env.WA_BOT_SECRET || 'dev-secret-change-in-production';
const AUTH_DIR = process.env.WA_AUTH_DIR || '/tmp/whatsapp-auth';
const PHONE_NUMBER = process.env.WA_PHONE_NUMBER || '';
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;
// Rate limiting: 1 message per 2.5 seconds (safety)
const RATE_LIMIT_MS = 2500;
let lastSendTime = 0;
// ═══════════════════════════════════════════════
// Global State
// ═══════════════════════════════════════════════
let sock = null;
let isConnected = false;
let isReady = false;
let phoneNumber = null;
let retryCount = 0;
let messagesSent = 0;
let messagesFailed = 0;
let qrData = null;
const startTime = Date.now();
// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
function formatEgyptPhone(phone) {
    let cleaned = phone.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('01')) {
        cleaned = '20' + cleaned.substring(1);
    }
    else if (cleaned.startsWith('+20')) {
        cleaned = cleaned.substring(1);
    }
    else if (cleaned.startsWith('20')) {
        // Already correct
    }
    return cleaned + '@s.whatsapp.net';
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - lastSendTime;
    if (elapsed < RATE_LIMIT_MS) {
        await sleep(RATE_LIMIT_MS - elapsed);
    }
    lastSendTime = Date.now();
}
// ═══════════════════════════════════════════════
// WhatsApp Connection
// ═══════════════════════════════════════════════
async function connectWhatsApp() {
    if (!fs_1.default.existsSync(AUTH_DIR)) {
        fs_1.default.mkdirSync(AUTH_DIR, { recursive: true });
    }
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(AUTH_DIR);
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    sock = (0, baileys_1.default)({
        auth: {
            creds: state.creds,
            keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, undefined),
        },
        version,
        printQRInTerminal: false,
        browser: baileys_1.Browsers.appropriate('Desktop'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });
    let pairingRequested = false;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection === 'open') {
            isConnected = true;
            retryCount = 0;
            if (sock && sock.user) {
                phoneNumber = sock.user.id?.split(':')[0] || null;
            }
            console.log('✅ تم الاتصال بواتساب بنجاح!');
            console.log(`📱 رقم الحساب: ${phoneNumber || 'غير معروف'}`);
            console.log('⏳ جاري تهيئة الاتصال... (انتظر 5 ثوانٍ)');
            await sleep(5000);
            isReady = true;
            console.log('🚀 الاتصال جاهز لإرسال الرسائل!');
            return;
        }
        if (connection === 'close') {
            isConnected = false;
            isReady = false;
            phoneNumber = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
            console.log(`❌ تم قطع الاتصال (كود: ${statusCode})`);
            if (shouldReconnect) {
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    console.log(`🔄 إعادة الاتصال (${retryCount}/${MAX_RETRIES})...`);
                    await sleep(RETRY_DELAY_MS);
                    await connectWhatsApp();
                }
                else {
                    console.log('⛔ تم تجاوز الحد الأقصى للمحاولات. أعد تشغيل الخدمة يدوياً.');
                }
            }
            else {
                console.log('👋 تم تسجيل الخروج. احذف مجلد auth وأعد التشغيل.');
            }
            return;
        }
        if (qr && !pairingRequested) {
            qrData = qr;
            if (PHONE_NUMBER) {
                pairingRequested = true;
                console.log(`\n📱 pairing code for ${PHONE_NUMBER}...`);
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n═══════════════════════════════════════`);
                    console.log(`🔑 pairing code: ${code}`);
                    console.log(`📱 Go to WhatsApp → Linked Devices → Link with Phone Number`);
                    console.log(`📱 Enter the code above`);
                    console.log(`═══════════════════════════════════════\n`);
                }
                catch (err) {
                    console.error('❌ Failed to request pairing code:', err.message);
                    pairingRequested = false;
                }
            }
            else {
                console.log('\n📱 امسح كود QR التالي بهاتفك:');
                console.log('═══════════════════════════════════════');
                qrcode_terminal_1.default.generate(qr, { small: true });
                console.log('═══════════════════════════════════════');
                console.log('⏳ في انتظار المسح...\n');
                console.log(`🔗 أو افتح: /qr-scanner لعرض QR كصورة`);
            }
        }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify')
            return;
        for (const msg of messages) {
            if (msg.key.fromMe)
                continue;
            const from = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (text) {
                console.log(`📩 رسالة واردة من ${from}: ${text.substring(0, 50)}`);
            }
        }
    });
}
// ═══════════════════════════════════════════════
// Send Message Function
// ═══════════════════════════════════════════════
async function sendMessage(phone, message) {
    if (!sock || !isConnected) {
        console.error('❌ WhatsApp not connected');
        return false;
    }
    if (!isReady) {
        console.error('❌ WhatsApp not ready yet, waiting...');
        let waited = 0;
        while (!isReady && waited < 15000) {
            await sleep(1000);
            waited += 1000;
        }
        if (!isReady) {
            console.error('❌ WhatsApp readiness timeout');
            return false;
        }
    }
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await waitForRateLimit();
            const jid = formatEgyptPhone(phone);
            console.log(`📤 محاولة ${attempt}/${maxRetries}: إرسال إلى ${jid}`);
            const result = await sock.sendMessage(jid, { text: message });
            if (result && result.key && result.key.id) {
                messagesSent++;
                console.log(`✅ تم إرسال رسالة إلى ${phone} (msgId: ${result.key.id})`);
                return true;
            }
            else {
                console.warn(`⚠️_RESULT بدون msgId (محاولة ${attempt}):`, JSON.stringify(result));
                if (attempt < maxRetries) {
                    await sleep(3000);
                    continue;
                }
                messagesFailed++;
                return false;
            }
        }
        catch (error) {
            console.error(`❌ فشل إرسال رسالة إلى ${phone} (محاولة ${attempt}):`, error.message || error);
            if (attempt < maxRetries) {
                await sleep(3000);
            }
        }
    }
    messagesFailed++;
    return false;
}
async function sendOTPMessage(phone, otp, purpose = 'verification') {
    const purposeText = {
        registration: 'التسجيل في الحساب',
        password_reset: 'إعادة تعيين كلمة المرور',
        verification: 'التحقق من رقم الهاتف',
    };
    const message = `🔐 رمز التحقق الخاص بك

الغرض: ${purposeText[purpose] || 'التحقق'}
الرمز: ${otp}

⏰ صالح لمدة 5 دقائق فقط
⚠️ لا تشارك هذا الرمز مع أي شخص

نادي ريادة الأعمال
جودة . ثقة . أمان`;
    return sendMessage(phone, message);
}
// ═══════════════════════════════════════════════
// Express HTTP API
// ═══════════════════════════════════════════════
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
function requireAuth(req, res, next) {
    const secret = req.headers['x-bot-secret'];
    if (secret !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/qr-scanner', async (_req, res) => {
    if (!qrData) {
        res.status(404).send('No QR code available. Bot may already be paired.');
        return;
    }
    try {
        const qrDataUrl = await qrcode_1.default.toDataURL(qrData, { width: 400, margin: 2 });
        res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR Pairing</title>
<style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:sans-serif;background:#111;color:#fff;flex-direction:column}
img{border-radius:12px;border:4px solid #25D366}
h2{color:#25D366}p{color:#aaa}
.refresh{margin-top:20px;padding:10px 20px;background:#25D366;color:#000;border:none;border-radius:8px;font-size:16px;cursor:pointer}
</style></head>
<body>
<h2>WhatsApp Pairing</h2>
<p>Open WhatsApp → Linked Devices → Link with Phone Number</p>
<p>Scan this QR code</p>
<img src="${qrDataUrl}" alt="QR Code"/>
<button class="refresh" onclick="location.reload()">Refresh QR</button>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`);
    }
    catch {
        res.status(500).send('Error generating QR');
    }
});
app.get('/qr-json', requireAuth, async (_req, res) => {
    if (!qrData) {
        return res.json({ available: false });
    }
    try {
        const qrDataUrl = await qrcode_1.default.toDataURL(qrData, { width: 400, margin: 2 });
        res.json({ available: true, qr: qrDataUrl });
    }
    catch {
        res.status(500).json({ error: 'Error generating QR' });
    }
});
app.post('/logout', requireAuth, async (_req, res) => {
    try {
        if (sock) {
            try {
                await sock.logout();
            }
            catch { /* ignore */ }
            sock = null;
        }
        isConnected = false;
        isReady = false;
        phoneNumber = null;
        qrData = null;
        if (fs_1.default.existsSync(AUTH_DIR)) {
            fs_1.default.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        console.log('👋 تم تسجيل الخروج. إعادة الاتصال...');
        res.json({ success: true, message: 'تم فصل الاتصال. جاري إعادة الاتصال...' });
        setTimeout(() => { connectWhatsApp().catch(console.error); }, 2000);
    }
    catch (error) {
        console.error('Logout error:', error.message);
        res.status(500).json({ error: error.message || 'Failed to logout' });
    }
});
app.get('/status', requireAuth, (_req, res) => {
    const status = {
        connected: isConnected,
        ready: isReady,
        phone: phoneNumber,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        messagesSent,
        messagesFailed,
    };
    res.json(status);
});
app.post('/send-otp', requireAuth, async (req, res) => {
    try {
        const { phone, otp, purpose } = req.body;
        console.log(`\n📥 /send-otp: phone=${phone}, purpose=${purpose}`);
        if (!phone || !otp) {
            return res.status(400).json({ error: 'phone and otp are required' });
        }
        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({ error: 'OTP must be 6 digits' });
        }
        if (!/^01[0-9]{9}$/.test(phone.replace(/\s/g, ''))) {
            return res.status(400).json({ error: 'Invalid Egyptian phone number' });
        }
        if (!isConnected) {
            console.error('❌ WhatsApp not connected — cannot send OTP');
            return res.status(503).json({ error: 'WhatsApp bot not connected' });
        }
        if (!isReady) {
            console.warn('⚠️ WhatsApp connected but not ready yet — waiting...');
        }
        const success = await sendOTPMessage(phone, otp, purpose || 'verification');
        if (success) {
            console.log(`✅ OTP sent successfully to ${phone}`);
            res.json({ success: true, message: 'OTP sent successfully' });
        }
        else {
            console.error(`❌ Failed to send OTP to ${phone}`);
            res.status(500).json({ error: 'Failed to send OTP' });
        }
    }
    catch (error) {
        console.error('Send OTP error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/send-message', requireAuth, async (req, res) => {
    try {
        const { phone, message } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ error: 'phone and message are required' });
        }
        const success = await sendMessage(phone, message);
        if (success) {
            res.json({ success: true, message: 'Message sent successfully' });
        }
        else {
            res.status(500).json({ error: 'Failed to send message' });
        }
    }
    catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/pair', requireAuth, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }
        if (!sock) {
            return res.status(503).json({ error: 'Socket not initialized' });
        }
        const cleaned = phone.replace(/[\s\-()]/g, '').replace(/^\+/, '');
        const code = await sock.requestPairingCode(cleaned);
        console.log(`🔑 Pairing code for ${cleaned}: ${code}`);
        res.json({ success: true, code });
    }
    catch (error) {
        console.error('Pair error:', error.message);
        res.status(500).json({ error: error.message || 'Failed to generate pairing code' });
    }
});
// ═══════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════
async function start() {
    console.log('🚀 بدء تشغيل WhatsApp Bot Service...');
    console.log(`📡 Listening on port ${PORT}`);
    console.log(`🔑 API Secret: ${API_SECRET.substring(0, 8)}...`);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🌐 HTTP API: http://localhost:${PORT}`);
        console.log(`📊 Status: http://localhost:${PORT}/status`);
        console.log(`\n═══════════════════════════════════════\n`);
    });
    await connectWhatsApp();
}
start().catch(console.error);
//# sourceMappingURL=index.js.map