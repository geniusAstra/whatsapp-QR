// ==========================================================================
// 🚀 PARCHE DE INTERCEPCIÓN + ENDPOINT QR (SIN DEPENDENCIAS EXTRA)
// ==========================================================================
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === './error' && this.filename.includes('@hapi/hoek')) {
        return class extends Error { constructor(args) { super(Array.isArray(args) ? args.join(' ') : args || 'Unknown error'); } };
    }
    if (id === 'whatwg-url' || id.includes('whatwg-url')) {
        try { return originalRequire.apply(this, arguments); } catch (e) {
            const { URL, URLSearchParams } = require('url');
            return { URL, URLSearchParams, parseURL: (input) => { try { return new URL(input); } catch(e) { return null; } }, serializeURL: (url) => url.toString() };
        }
    }
    return originalRequire.apply(this, arguments);
};

const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage,
    BufferJSON 
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');
const express = require('express');
const { MongoClient } = require('mongodb');
const useMongoDBAuthState = require('./mongo_auth'); 
require('dotenv').config();

const app = express();
app.use(express.json());
const logger = pino({ level: 'info' });

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://agentv1-0-citasconcal-com-premium-version.onrender.com/webhook/whatsapp';
const PORT = process.env.PORT || 3000;
const MONGODB_URL = process.env.MONGODB_URL || process.env.MONGO_URI;

let sock; 
let lastQR = null;

// ==========================================================================
// 📦 NUEVO: SISTEMA DE COLA (QUEUE) PARA EVITAR ERROR 429
// Este bloque gestiona los mensajes uno por uno con un retraso para no saturar.
// ==========================================================================
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const { jid, content, resolve, reject } = messageQueue.shift();
        
        try {
            // Retraso humano de 1.5 segundos entre mensajes para evitar bloqueos y 429
            await new Promise(res => setTimeout(res, 1500));

            await sock.sendMessage(jid, content);
            logger.info(`✅ Mensaje enviado exitosamente a ${jid}`);
            resolve({ status: 'success', to: jid });
        } catch (error) {
            logger.error(`❌ Error al enviar mensaje a ${jid}: ${error.message}`);
            reject(error);
        }
    }
    isProcessingQueue = false;
}
// ==========================================================================

app.get('/qr', (req, res) => {
    if (!lastQR) {
        return res.send('<h1>El bot ya está conectado o el QR no se ha generado aún.</h1><p>Refresca en unos segundos si acabas de reiniciar.</p>');
    }
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQR)}`;
    res.send(`
        <html>
            <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#f0f2f5; font-family:sans-serif;">
                <div style="background:white; padding:40px; border-radius:20px; box-shadow:0 10px 25px rgba(0,0,0,0.1); text-align:center;">
                    <h1 style="color:#128c7e;">WhatsApp Bridge</h1>
                    <p style="color:#666;">Escanea este código para conectar</p>
                    <img src="${qrImageUrl}" style="margin:20px 0; border:1px solid #eee;" />
                    <p style="font-size:12px; color:#999;">El QR se actualiza automáticamente cada 20 segundos.</p>
                </div>
                <script>setTimeout(() => location.reload(), 20000);</script>
            </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    res.send('<h1>Servidor WhatsApp Bridge Activo</h1><p>Ve a <a href="/qr">/qr</a> para conectar.</p>');
});

// ==========================================================================
// 🚀 ENDPOINT /SEND-MESSAGE MODIFICADO PARA USAR LA COLA
// ==========================================================================
app.post('/send-message', (req, res) => {
    const { number, message, to, isImage } = req.body;
    const phoneNumber = to || number;

    if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const jid = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;
    const urlString = String(message).toLowerCase();
    let content;

    if (urlString.includes('.mp4') || urlString.includes('video')) {
        content = { video: { url: message } };
    } else if (isImage === true || isImage === "true" || urlString.includes('.png') || urlString.includes('.jpg')) {
        content = { image: { url: message } };
    } else {
        content = { text: message };
    }

    // CAMBIO: En lugar de sock.sendMessage directo, lo metemos en la cola
    new Promise((resolve, reject) => {
        messageQueue.push({ jid, content, resolve, reject });
        processQueue(); // Iniciar el procesador si no está corriendo
    })
    .then(result => res.json(result))
    .catch(error => res.status(500).json({ error: error.message }));
});
// ==========================================================================

async function startWhatsAppBot() {
    if (!MONGODB_URL) {
        console.error("❌ ERROR: No se encontró MONGODB_URL ni MONGO_URI.");
        process.exit(1);
    }

    const client = new MongoClient(MONGODB_URL);
    await client.connect();
    const db = client.db('whatsapp_bridge');
    const collection = db.collection('auth_session');

    const { state, saveCreds } = useMongoDBAuthState(collection);
    const credsData = await collection.findOne({ _id: 'creds' });
    if (credsData) {
        state.creds = JSON.parse(credsData.data, BufferJSON.reviver);
    }

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', async () => {
        const jsonStr = JSON.stringify(state.creds, BufferJSON.replacer);
        await collection.updateOne({ _id: 'creds' }, { $set: { data: jsonStr } }, { upsert: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            lastQR = qr;
            console.log('📱 QR generado. Míralo en: https://tu-app.onrender.com/qr');
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconectando...');
                setTimeout(startWhatsAppBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Conexión establecida.');
            lastQR = null;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        if (from.includes('@g.us')) return;

        try {
            if (msg.message?.audioMessage) {
                const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const audioBase64 = audioBuffer.toString('base64');
                const payload = {
                    message: '', sender: from, platform: 'whatsapp',
                    isVoiceMessage: true, audio: audioBase64,
                    audio_mimetype: msg.message.audioMessage.mimetype || 'audio/ogg'
                };
                const response = await axios.post(WEBHOOK_URL, payload, { timeout: 60000 });
                const agentResponse = response.data.response || 'Sin respuesta.';
                await sock.sendMessage(from, { text: agentResponse });
                return;
            }
            const messageBody = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!messageBody) return;
            const payload = { message: messageBody, sender: from, platform: 'whatsapp' };
            const response = await axios.post(WEBHOOK_URL, payload, { timeout: 30000 });
            const agentResponse = response.data.response || 'No entendí tu mensaje.';
            await sock.sendMessage(from, { text: agentResponse });
        } catch (error) {
            logger.error(`❌ Error en mensaje: ${error.message}`);
        }
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    startWhatsAppBot().catch(err => console.error('❌ Error bot:', err));
});
