const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const os = require('os');

console.log('================================================================');
console.log('🔐 FPL WHATSAPP BOT - ONE-TIME LOGIN & PAIRING TOOL');
console.log('================================================================\n');

const isLinux = os.platform() === 'linux';

const puppeteerOptions = {
    headless: true,
    protocolTimeout: 0,
    timeout: 0,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions'
    ]
};

if (isLinux) {
    if (fs.existsSync('/usr/bin/chromium')) {
        puppeteerOptions.executablePath = '/usr/bin/chromium';
    } else if (fs.existsSync('/usr/bin/chromium-browser')) {
        puppeteerOptions.executablePath = '/usr/bin/chromium-browser';
    }
}

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    takeoverOnConflict: true,
    authTimeoutMs: 180000,
    puppeteer: puppeteerOptions,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
});

// Resilient injection patch for page reload
const originalInject = Client.prototype.inject;
Client.prototype.inject = async function() {
    let retries = 15;
    while (retries > 0) {
        try {
            return await originalInject.call(this);
        } catch (err) {
            const msg = String(err || '');
            if (msg.includes('Execution context was destroyed') || msg.includes('Navigation')) {
                await new Promise(r => setTimeout(r, 1000));
                retries--;
                continue;
            }
            throw err;
        }
    }
};

client.on('qr', (qr) => {
    console.log('\n================================================================');
    console.log('📱 SCAN THIS QR CODE IN WHATSAPP:');
    console.log('================================================================\n');
    qrcode.generate(qr, { small: true });
    console.log('\n👉 On Phone: WhatsApp -> Settings -> Linked Devices -> Link a Device\n');
});

client.on('loading_screen', (percent, message) => {
    if (percent === 100) {
        console.log('Syncing WhatsApp: 100%... (Finalizing handshake, please wait ~30-45s, DO NOT press Ctrl+C!)...');
    } else {
        console.log(`Syncing WhatsApp: ${percent}%...`);
    }
});

client.on('authenticated', () => {
    console.log('\n✅ Phone accepted QR code! Downloading session keys...');
});

client.on('ready', async () => {
    console.log('\n================================================================');
    console.log('🎉 SUCCESS! YOUR WHATSAPP ACCOUNT IS PERMANENTLY LINKED!');
    console.log('================================================================');
    console.log('Session is safely saved to .wwebjs_auth/');
    console.log('Exiting login tool automatically now...');
    console.log('\n👉 NOW RUN THIS: pm2 restart fpl-whatsapp-bot && pm2 save\n');

    try {
        await client.destroy();
    } catch (e) {}
    process.exit(0);
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    process.exit(1);
});

console.log('Launching browser to request QR code (takes 15-30s)...');
client.initialize();
