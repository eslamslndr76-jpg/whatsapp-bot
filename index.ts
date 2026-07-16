import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';

// ═══════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════

const PORT = Number(process.env.PORT || process.env.WA_BOT_PORT) || 3002;
const API_SECRET = process.env.WA_BOT_SECRET || 'dev-secret-change-in-production';
const AUTH_DIR = process.env.WA_AUTH_DIR || '/tmp/whatsapp-auth';
const PHONE_NUMBER = process.env.WA_PHONE_NUMBER || '';

// Heartbeat: ping every 30s to detect zombie connections
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

// Exponential backoff: 5s → 10s → 20s → … → max 5 minutes, unlimited retries
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

// Rate limiting: 1 message per 2.5 seconds
const RATE_LIMIT_MS = 2500;
let lastSendTime = 0;

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

interface SendMessageRequest {
  phone: string;
  message: string;
}

interface SendOTPRequest {
  phone: string;
  otp: string;
  purpose?: 'registration' | 'password_reset' | 'verification';
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface BotStatus {
  connected: boolean;
  ready: boolean;
  phone: string | null;
  uptime: number;
  messagesSent: number;
  messagesFailed: number;
  reconnecting: boolean;
  retryCount: number;
  lastConnectedAt: number | null;
  connectionState: ConnectionState;
}

// ═══════════════════════════════════════════════
// Global State
// ═══════════════════════════════════════════════

let sock: WASocket | null = null;
let isConnected = false;
let isReady = false;
let phoneNumber: string | null = null;
let retryCount = 0;
let messagesSent = 0;
let messagesFailed = 0;
let qrData: string | null = null;
let qrGeneratedAt: number = 0;
let connectionState: ConnectionState = 'disconnected';
let lastConnectedAt: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isReconnecting = false;
const startTime = Date.now();

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

function formatEgyptPhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, '');

  if (cleaned.startsWith('01')) {
    cleaned = '20' + cleaned.substring(1);
  } else if (cleaned.startsWith('+20')) {
    cleaned = cleaned.substring(1);
  } else if (cleaned.startsWith('20')) {
    // Already correct
  } else if (/^1[0-9]{9}$/.test(cleaned)) {
    cleaned = '20' + cleaned;
  }

  return cleaned + '@s.whatsapp.net';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(): number {
  const delay = RETRY_BASE_MS * Math.pow(2, retryCount);
  return Math.min(delay, RETRY_MAX_MS);
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastSendTime = Date.now();
}

// ═══════════════════════════════════════════════
// Heartbeat — detect zombie connections
// ═══════════════════════════════════════════════

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!sock || !isConnected || isReconnecting) return;

    try {
      const ws = (sock as any).ws;
      if (!ws || ws.readyState !== 1) {
        console.log(`⚠️ Heartbeat: WebSocket.readyState=${ws?.readyState ?? 'null'} — zombie detected`);
        await handleConnectionLoss('heartbeat_ws_closed');
        return;
      }

      await Promise.race([
        sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), HEARTBEAT_TIMEOUT_MS)),
      ]);
    } catch {
      console.log('⚠️ Heartbeat: ping failed — connection may be dead');
      await handleConnectionLoss('heartbeat_ping_failed');
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleConnectionLoss(reason: string): Promise<void> {
  if (isReconnecting) return;
  console.log(`🔴 Connection loss detected: ${reason}`);
  stopHeartbeat();
  isConnected = false;
  isReady = false;
  connectionState = 'reconnecting';

  if (sock) {
    try { sock.end(undefined); } catch { /* ignore */ }
    sock = null;
  }

  retryCount++;
  const delay = getRetryDelay();
  console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${retryCount})...`);
  await sleep(delay);
  await connectWhatsApp();
}

// ═══════════════════════════════════════════════
// WhatsApp Connection
// ═══════════════════════════════════════════════

async function connectWhatsApp(): Promise<void> {
  isReconnecting = true;
  connectionState = retryCount === 0 ? 'connecting' : 'reconnecting';

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
    },
    version,
    printQRInTerminal: false,
    browser: Browsers.appropriate('Desktop'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  // Detect WebSocket-level disconnection (catches zombie connections)
  const ws = (sock as any).ws;
  if (ws) {
    ws.on('close', () => {
      if (isConnected && !isReconnecting) {
        console.log('🔴 WebSocket closed unexpectedly');
        handleConnectionLoss('ws_close_event');
      }
    });
    ws.on('error', (err: Error) => {
      if (isConnected && !isReconnecting) {
        console.error('🔴 WebSocket error:', err.message);
        handleConnectionLoss('ws_error_event');
      }
    });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'open') {
      isConnected = true;
      isReady = false;
      isReconnecting = false;
      connectionState = 'connected';
      retryCount = 0;
      lastConnectedAt = Date.now();
      qrData = null;
      qrGeneratedAt = 0;

      if (sock && sock.user) {
        phoneNumber = sock.user.id?.split(':')[0] || null;
      }

      console.log('✅ تم الاتصال بواتساب بنجاح!');
      console.log(`📱 رقم الحساب: ${phoneNumber || 'غير معروف'}`);

      console.log('⏳ جاري تهيئة الاتصال... (انتظر 5 ثوانٍ)');
      await sleep(5000);
      isReady = true;
      console.log('🚀 الاتصال جاهز لإرسال الرسائل!');

      startHeartbeat();
      return;
    }

    if (connection === 'close') {
      isConnected = false;
      isReady = false;
      phoneNumber = null;
      qrData = null;
      qrGeneratedAt = 0;

      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`❌ تم قطع الاتصال (كود: ${statusCode})`);

      stopHeartbeat();

      if (shouldReconnect) {
        connectionState = 'reconnecting';
        retryCount++;
        const delay = getRetryDelay();
        console.log(`🔄 إعادة الاتصال في ${Math.round(delay / 1000)}ث (محاولة ${retryCount})...`);
        await sleep(delay);
        isReconnecting = false;
        await connectWhatsApp();
      } else {
        connectionState = 'disconnected';
        isReconnecting = false;
        console.log('👋 تم تسجيل الخروج. احذف مجلد auth وأعد التشغيل.');
      }
      return;
    }

    if (qr && !pairingRequested) {
      qrData = qr;
      qrGeneratedAt = Date.now();
      if (PHONE_NUMBER) {
        pairingRequested = true;
        console.log(`\n📱 pairing code for ${PHONE_NUMBER}...`);
        try {
          const code = await sock!.requestPairingCode(PHONE_NUMBER);
          console.log(`\n═══════════════════════════════════════`);
          console.log(`🔑 pairing code: ${code}`);
          console.log(`📱 Go to WhatsApp → Linked Devices → Link with Phone Number`);
          console.log(`📱 Enter the code above`);
          console.log(`═══════════════════════════════════════\n`);
        } catch (err: any) {
          console.error('❌ Failed to request pairing code:', err.message);
          pairingRequested = false;
        }
      } else {
        console.log('\n📱 امسح كود QR التالي بهاتفك:');
        console.log('═══════════════════════════════════════');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('═══════════════════════════════════════');
        console.log('⏳ في انتظار المسح...\n');
        console.log(`🔗 أو افتح: /qr-scanner لعرض QR كصورة`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (text) {
        console.log(`📩 رسالة واردة من ${from}: ${text.substring(0, 50)}`);
      }
    }
  });

  isReconnecting = false;
}

// ═══════════════════════════════════════════════
// Send Message Function
// ═══════════════════════════════════════════════

async function sendMessage(phone: string, message: string): Promise<boolean> {
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
      } else {
        console.warn(`⚠️_RESULT بدون msgId (محاولة ${attempt}):`, JSON.stringify(result));
        if (attempt < maxRetries) {
          await sleep(3000);
          continue;
        }
        messagesFailed++;
        return false;
      }
    } catch (error: any) {
      console.error(`❌ فشل إرسال رسالة إلى ${phone} (محاولة ${attempt}):`, error.message || error);

      const errMsg = (error.message || '').toLowerCase();
      if (errMsg.includes('connection') || errMsg.includes('closed') || errMsg.includes('not opened')) {
        console.log('🔴 Send failed due to connection issue — triggering reconnect');
        handleConnectionLoss('send_failed_connection');
        return false;
      }

      if (attempt < maxRetries) {
        await sleep(3000);
      }
    }
  }

  messagesFailed++;
  return false;
}

async function sendOTPMessage(phone: string, otp: string, purpose: string = 'verification'): Promise<boolean> {
  const purposeText: Record<string, string> = {
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
نحو تعليم أفضل`;

  return sendMessage(phone, message);
}

// ═══════════════════════════════════════════════
// Express HTTP API
// ═══════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

function requireAuth(req: Request, res: Response, next: () => void) {
  const secret = req.headers['x-bot-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Shallow health: Express server alive?
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Deep health: WhatsApp actually connected?
app.get('/health/deep', (_req: Request, res: Response) => {
  const status: BotStatus = {
    connected: isConnected,
    ready: isReady,
    phone: phoneNumber,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    messagesSent,
    messagesFailed,
    reconnecting: isReconnecting || connectionState === 'reconnecting',
    retryCount,
    lastConnectedAt,
    connectionState,
  };
  const httpCode = isConnected && isReady ? 200 : 503;
  res.status(httpCode).json(status);
});

app.get('/qr-scanner', async (_req: Request, res: Response) => {
  if (!qrData) {
    res.status(404).send('No QR code available. Bot may already be paired.');
    return;
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(qrData, { width: 400, margin: 2 });
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
  } catch {
    res.status(500).send('Error generating QR');
  }
});

app.get('/qr-json', requireAuth, async (_req: Request, res: Response) => {
  if (!qrData) {
    return res.json({ available: false });
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(qrData, { width: 400, margin: 2 });
    const ageSeconds = Math.floor((Date.now() - qrGeneratedAt) / 1000);
    res.json({ available: true, qr: qrDataUrl, age: ageSeconds, generatedAt: qrGeneratedAt });
  } catch {
    res.status(500).json({ error: 'Error generating QR' });
  }
});

app.post('/logout', requireAuth, async (_req: Request, res: Response) => {
  try {
    stopHeartbeat();
    if (sock) {
      try { await sock.logout(); } catch { /* ignore */ }
      sock = null;
    }
    isConnected = false;
    isReady = false;
    phoneNumber = null;
    qrData = null;
    qrGeneratedAt = 0;
    connectionState = 'disconnected';

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }

    console.log('👋 تم تسجيل الخروج. إعادة الاتصال...');
    res.json({ success: true, message: 'تم فصل الاتصال. جاري إعادة الاتصال...' });

    retryCount = 0;
    isReconnecting = false;
    setTimeout(() => { connectWhatsApp().catch(console.error); }, 2000);
  } catch (error: any) {
    console.error('Logout error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to logout' });
  }
});

// Status endpoint — no auth for easier monitoring
app.get('/status', (_req: Request, res: Response) => {
  const status: BotStatus = {
    connected: isConnected,
    ready: isReady,
    phone: phoneNumber,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    messagesSent,
    messagesFailed,
    reconnecting: isReconnecting || connectionState === 'reconnecting',
    retryCount,
    lastConnectedAt,
    connectionState,
  };
  res.json(status);
});

app.post('/send-otp', requireAuth, async (req: Request, res: Response) => {
  try {
    const { phone, otp, purpose } = req.body as SendOTPRequest;

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
      return res.status(503).json({
        error: 'WhatsApp bot not connected',
        connectionState,
        reconnecting: isReconnecting || connectionState === 'reconnecting',
      });
    }

    if (!isReady) {
      console.warn('⚠️ WhatsApp connected but not ready yet — waiting...');
    }

    const success = await sendOTPMessage(phone, otp, purpose || 'verification');

    if (success) {
      console.log(`✅ OTP sent successfully to ${phone}`);
      res.json({ success: true, message: 'OTP sent successfully' });
    } else {
      console.error(`❌ Failed to send OTP to ${phone}`);
      res.status(500).json({
        error: 'Failed to send OTP',
        connectionState,
        reconnecting: isReconnecting || connectionState === 'reconnecting',
      });
    }
  } catch (error: any) {
    console.error('Send OTP error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/send-message', requireAuth, async (req: Request, res: Response) => {
  try {
    const { phone, message } = req.body as SendMessageRequest;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    const success = await sendMessage(phone, message);

    if (success) {
      res.json({ success: true, message: 'Message sent successfully' });
    } else {
      res.status(500).json({
        error: 'Failed to send message',
        connectionState,
        reconnecting: isReconnecting || connectionState === 'reconnecting',
      });
    }
  } catch (error: any) {
    console.error('Send message error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/pair', requireAuth, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body as { phone: string };

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
  } catch (error: any) {
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
  console.log(`💓 Heartbeat: every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 HTTP API: http://localhost:${PORT}`);
    console.log(`📊 Status: http://localhost:${PORT}/status`);
    console.log(`❤️ Deep Health: http://localhost:${PORT}/health/deep`);
    console.log(`\n═══════════════════════════════════════\n`);
  });

  await connectWhatsApp();
}

start().catch(console.error);
