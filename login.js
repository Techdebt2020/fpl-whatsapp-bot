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
    console.log(`Syncing WhatsApp: ${percent}%...`);
});

client.on('authenticated', () => {
    console.log('\n✅ Authenticated successfully! Finalizing session save...');
});

client.on('ready', async () => {
    console.log('\n================================================================');
    console.log('🎉 SUCCESS! YOUR WHATSAPP ACCOUNT IS PERMANENTLY LINKED!');
    console.log('================================================================');
    console.log(`• Connected as: ${client.info.pushname || client.info.wid.user}`);
    
    try {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup);
        console.log(`• Found ${groups.length} groups.`);
        console.log('\nYour Groups & JIDs:');
        groups.forEach(g => console.log(`  • "${g.name}" -> ${g.id._serialized}`));
    } catch (e) {}

    console.log('\nSession is safely saved in .wwebjs_auth/');
    console.log('Closing login tool and exiting...');
    console.log('\n👉 NEXT STEP: Start the 24/7 bot daemon with:');
    console.log('   pm2 start index.js --name "fpl-whatsapp-bot" && pm2 save\n');

    await client.destroy();
    process.exit(0);
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    process.exit(1);
});

console.log('Launching browser to request QR code (takes 15-30s)...');
client.initialize();
