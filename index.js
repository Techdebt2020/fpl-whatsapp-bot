const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// Global handlers for transient Puppeteer navigation events
process.on('unhandledRejection', (reason, promise) => {
    const errStr = String(reason || '');
    if (errStr.includes('Execution context was destroyed') || errStr.includes('Navigation')) {
        return;
    }
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    const errStr = String(err || '');
    if (errStr.includes('Execution context was destroyed') || errStr.includes('Navigation')) {
        return;
    }
    console.error('Uncaught Exception:', err);
});

// Resilient patch for WhatsApp Web page navigation during handshake
const originalInject = Client.prototype.inject;
Client.prototype.inject = async function() {
    let retries = 15;
    while (retries > 0) {
        try {
            return await originalInject.call(this);
        } catch (err) {
            const msg = String(err || '');
            if (msg.includes('Execution context was destroyed') || msg.includes('Navigation')) {
                console.log('WhatsApp page redirecting during login, retrying in 1s...');
                await new Promise(r => setTimeout(r, 1000));
                retries--;
                continue;
            }
            throw err;
        }
    }
};

// Verify API Key
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error('Error: GEMINI_API_KEY is not defined in the environment or .env file.');
    process.exit(1);
}

// Initialize Gemini API client
const genAI = new GoogleGenerativeAI(geminiApiKey);

const isLinux = os.platform() === 'linux';

// Puppeteer Options optimized for Linux VM
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

// Define Client options
const clientOptions = {
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    authTimeoutMs: 120000,
    puppeteer: puppeteerOptions,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// Initialize WhatsApp Client
const client = new Client(clientOptions);

// State persistence to prevent duplicate alerts across restarts
const STATE_FILE = path.join(__dirname, 'alerts_state.json');

function loadAlertState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading alert state:', e.message);
    }
    return { sentAlerts: {} };
}

function saveAlertState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving alert state:', e.message);
    }
}

// Fetch live Premier League Gameweek & Fixture details from official FPL API
async function getNextGameweekInfo() {
    try {
        const res = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
        if (!res.ok) throw new Error(`FPL bootstrap status: ${res.status}`);
        const data = await res.json();

        const events = data.events || [];
        const teams = {};
        (data.teams || []).forEach(t => {
            teams[t.id] = { name: t.name, short: t.short_name };
        });

        // Find upcoming Gameweek
        let nextEvent = events.find(e => e.is_next) || events.find(e => e.is_current && !e.finished) || events.find(e => !e.finished);
        if (!nextEvent) return null;

        // Fetch fixtures for this gameweek
        const fixRes = await fetch(`https://fantasy.premierleague.com/api/fixtures/?event=${nextEvent.id}`);
        if (!fixRes.ok) throw new Error(`FPL fixtures status: ${fixRes.status}`);
        const fixtures = await fixRes.json();

        const timedFixtures = fixtures.filter(f => f.kickoff_time);
        timedFixtures.sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

        const firstKickoff = timedFixtures.length > 0 ? new Date(timedFixtures[0].kickoff_time) : new Date(nextEvent.deadline_time);
        const deadline = new Date(nextEvent.deadline_time);

        return {
            id: nextEvent.id,
            name: nextEvent.name,
            deadline,
            firstKickoff,
            firstMatch: timedFixtures[0] ? `${teams[timedFixtures[0].team_h]?.name || 'Home'} vs ${teams[timedFixtures[0].team_a]?.name || 'Away'}` : 'Match 1',
            fixtures: timedFixtures.map(f => ({
                home: teams[f.team_h]?.name || 'Home',
                away: teams[f.team_a]?.name || 'Away',
                kickoff: new Date(f.kickoff_time)
            }))
        };
    } catch (e) {
        console.error('Error fetching FPL Gameweek info:', e.message);
        return null;
    }
}

// Generate 48-Hour Fixture Preview via Gemini
async function generate48hPreview(gwInfo) {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        tools: [{ googleSearch: {} }]
    });

    const deadlineStr = gwInfo.deadline.toUTCString();
    const kickoffStr = gwInfo.firstKickoff.toUTCString();

    const prompt = `You are an elite Premier League broadcast host.
Today is 48 HOURS before the kickoff of the upcoming ${gwInfo.name}.
First match: ${gwInfo.firstMatch} (Kickoff: ${kickoffStr}).
The FPL Team Selection Deadline is: ${deadlineStr} (90 mins before kickoff).

Generate an exciting, high-energy 48-Hour Match Preview & Fixtures broadcast for WhatsApp.

Requirements:
1. Catchy headline with emojis: 🚨 *48-HOUR FPL NOTICE: ${gwInfo.name.toUpperCase()} APPROACHING* 🚨
2. Announce the first match (${gwInfo.firstMatch}) and exact time countdown.
3. List all Gameweek match pairings grouped by day.
4. Show kickoff times for each match in UK Time, IST (India), CET (Europe), AST (Qatar/Gulf), and US PST.
   Format: ⚽ *Arsenal* vs *Chelsea* - *15:00 UK | 19:30 IST | 16:00 CET | 17:00 AST | 07:00 PST*
5. Highlight 2 big blockbuster clashes to watch and early injury/rotation warnings.
6. Emphasize the FPL team lock deadline (${deadlineStr}).
7. Concluding tip to review squad and plan transfers early.
8. CRITICAL: Use single asterisks (*bold*) for WhatsApp bolding. Never use double asterisks (**). Do not use markdown # headers.`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();
    text = text.replace(/^#+\s*(.*)$/gmi, '*$1*').replace(/\*\*/g, '*');
    return text;
}

// Generate 24-Hour Final Deadline & Captaincy Alert via Gemini
async function generate24hDeadlineAlert(gwInfo) {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        tools: [{ googleSearch: {} }]
    });

    const deadlineStr = gwInfo.deadline.toUTCString();
    const kickoffStr = gwInfo.firstKickoff.toUTCString();

    const prompt = `You are an elite Premier League analyst and fantasy broadcaster.
Today is exactly 24 HOURS before the kickoff of ${gwInfo.name}!
First match: ${gwInfo.firstMatch} (Kickoff: ${kickoffStr}).
THE OFFICIAL FPL DEADLINE IS: ${deadlineStr} (Team lock happens 90 minutes before kickoff).

Generate an urgent, must-read 24-Hour Final Deadline & Captaincy Alert for WhatsApp.

Requirements:
1. Urgent Headline: ⏳ *FINAL 24-HOUR DEADLINE ALERT: ${gwInfo.name.toUpperCase()}* ⏳
2. Prominently display the EXACT FPL DEADLINE in multiple timezones (UK, IST, CET, AST, PST).
3. "Captaincy Decision Matrix":
   - Safe Essential Pick (highest expected returns)
   - Differential Captain Pick (<15% ownership) with high upside
4. Top 3 Transfer Trends & Key Matchups for this round.
5. Final Manager Checklist:
   - [ ] Vice-captain confirmed?
   - [ ] Bench order prioritized?
   - [ ] Injury flags & press conference news checked?
   - [ ] Starting XI locked?
6. High energy closing call: "Lock in your teams before the servers get busy!"
7. CRITICAL: Use single asterisks (*bold*) for WhatsApp. Never use double asterisks (**). No markdown # headers.`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();
    text = text.replace(/^#+\s*(.*)$/gmi, '*$1*').replace(/\*\*/g, '*');
    return text;
}

// Smart Scheduler: Checks every 15 minutes for 48h and 24h thresholds
async function checkAndSendSmartReminders(forcedType = null) {
    const targetChannelJid = process.env.TARGET_CHANNEL_JID;
    if (!targetChannelJid) {
        console.error('TARGET_CHANNEL_JID is not configured in .env.');
        return false;
    }

    const gwInfo = await getNextGameweekInfo();
    if (!gwInfo) {
        console.log('No upcoming Gameweek found.');
        return false;
    }

    const now = new Date();
    const hoursToKickoff = (gwInfo.firstKickoff.getTime() - now.getTime()) / (1000 * 60 * 60);
    const hoursToDeadline = (gwInfo.deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    console.log(`\n-----------------------------------------------------------`);
    console.log(`[GW Tracker] ${gwInfo.name} | First Game: ${gwInfo.firstMatch}`);
    console.log(`[GW Tracker] Kickoff: ${gwInfo.firstKickoff.toISOString()} (in ${hoursToKickoff.toFixed(1)} hrs)`);
    console.log(`[GW Tracker] FPL Deadline: ${gwInfo.deadline.toISOString()} (in ${hoursToDeadline.toFixed(1)} hrs)`);
    console.log(`-----------------------------------------------------------\n`);

    const state = loadAlertState();
    const key48h = `gw${gwInfo.id}_48h`;
    const key24h = `gw${gwInfo.id}_24h`;

    // Forced manual triggers
    if (forcedType === '48h' || forcedType === 'fixtures') {
        console.log(`Triggering manual 48-Hour Preview for ${gwInfo.name}...`);
        const text = await generate48hPreview(gwInfo);
        await client.sendMessage(targetChannelJid, text);
        console.log('48h preview sent!');
        return true;
    }

    if (forcedType === '24h' || forcedType === 'deadline') {
        console.log(`Triggering manual 24-Hour Deadline Alert for ${gwInfo.name}...`);
        const text = await generate24hDeadlineAlert(gwInfo);
        await client.sendMessage(targetChannelJid, text);
        console.log('24h deadline alert sent!');
        return true;
    }

    // 48-Hour Automatic Alert: Triggers when <= 48h and > 24h
    if (hoursToKickoff <= 48 && hoursToKickoff > 24) {
        if (!state.sentAlerts[key48h]) {
            console.log(`>>> Sending AUTOMATIC 48-Hour Alert for ${gwInfo.name}...`);
            try {
                const text = await generate48hPreview(gwInfo);
                await client.sendMessage(targetChannelJid, text);
                state.sentAlerts[key48h] = new Date().toISOString();
                saveAlertState(state);
                console.log(`Successfully sent 48h alert for ${gwInfo.name}!`);
            } catch (err) {
                console.error(`Failed to send 48h alert:`, err.message);
            }
        } else {
            console.log(`[Tracker] 48h alert already delivered for ${gwInfo.name}.`);
        }
    }

    // 24-Hour Automatic Alert: Triggers when <= 24h and > 0h
    if (hoursToKickoff <= 24 && hoursToKickoff > 0) {
        if (!state.sentAlerts[key24h]) {
            console.log(`>>> Sending AUTOMATIC 24-Hour Deadline Alert for ${gwInfo.name}...`);
            try {
                const text = await generate24hDeadlineAlert(gwInfo);
                await client.sendMessage(targetChannelJid, text);
                state.sentAlerts[key24h] = new Date().toISOString();
                saveAlertState(state);
                console.log(`Successfully sent 24h deadline alert for ${gwInfo.name}!`);
            } catch (err) {
                console.error(`Failed to send 24h deadline alert:`, err.message);
            }
        } else {
            console.log(`[Tracker] 24h deadline alert already delivered for ${gwInfo.name}.`);
        }
    }

    return true;
}

let isPairingRequested = false;

// Event: QR code / pairing code generation
client.on('qr', async (qr) => {
    console.log('\n================================================================');
    console.log('📱 SCAN THE QR CODE BELOW IN WHATSAPP TO LINK:');
    console.log('================================================================\n');
    qrcode.generate(qr, { small: true });

    const phoneNumber = process.env.PHONE_NUMBER;
    if (phoneNumber && !isPairingRequested) {
        isPairingRequested = true;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                await new Promise(r => setTimeout(r, 2000));
                const code = await client.requestPairingCode(phoneNumber.trim());
                if (code) {
                    console.log('================================================================');
                    console.log(`📱 8-DIGIT PAIRING CODE GENERATED:  * ${code} *`);
                    console.log('   (In WhatsApp -> Settings -> Linked Devices -> Link with phone number)');
                    console.log('================================================================\n');
                    break;
                }
            } catch (err) {
                console.log(`Pairing code handshake waiting for page (attempt ${attempt}/4)...`);
            }
        }
    }
});

// Event: Loading screen progress
client.on('loading_screen', (percent, message) => {
    console.log(`WhatsApp loading: ${percent}% (${message || 'syncing'})...`);
});

// Event: Successfully authenticated
client.on('authenticated', () => {
    console.log('WhatsApp Web authenticated successfully!');
});

// Event: Authentication failure
client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
});

// Event: Client is ready
client.on('ready', async () => {
    console.log('WhatsApp Client is ready!\n');

    // List all groups and their JIDs for easy reference
    try {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup);
        console.log('================================================================');
        console.log('📋 CONNECTED WHATSAPP GROUPS & JIDs:');
        groups.forEach(g => console.log(`• "${g.name}" -> ${g.id._serialized}`));
        console.log('================================================================\n');
    } catch (err) {
        console.log('Note: Group list could not be fetched:', err.message);
    }

    console.log('Smart Gameweek Tracker initialized:');
    console.log('- 48-Hour Alert: Triggers 48h before the first kickoff of every Gameweek.');
    console.log('- 24-Hour Alert: Triggers 24h before the first kickoff of every Gameweek.');
    console.log('- Routine check runs every 15 minutes.');

    // Run check immediately on startup
    await checkAndSendSmartReminders();
});

// Command Listener: Trigger manually via WhatsApp message
client.on('message_create', async (msg) => {
    const targetChannelJid = process.env.TARGET_CHANNEL_JID;
    const body = msg.body.trim().toLowerCase();

    if (msg.fromMe) {
        if (body === '!48h' || body === '!fixtures') {
            console.log('Manual 48h broadcast command received.');
            await checkAndSendSmartReminders('48h');
        } else if (body === '!24h' || body === '!deadline' || body === '!reminder') {
            console.log('Manual 24h deadline broadcast command received.');
            await checkAndSendSmartReminders('24h');
        } else if (body === '!status') {
            const info = await getNextGameweekInfo();
            if (info) {
                const now = new Date();
                const hKickoff = ((info.firstKickoff - now) / 3600000).toFixed(1);
                const hDeadline = ((info.deadline - now) / 3600000).toFixed(1);
                await client.sendMessage(msg.to, `🤖 *FPL Broadcaster Status*\n\n• Next: *${info.name}*\n• First Match: *${info.firstMatch}*\n• Kickoff: *${hKickoff} hrs*\n• Deadline: *${hDeadline} hrs*`);
            }
        } else if (body === '!groups') {
            try {
                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);
                const text = groups.map(g => `• *${g.name}*:\n${g.id._serialized}`).join('\n\n');
                await client.sendMessage(msg.to, `📋 *Your WhatsApp Groups & JIDs:*\n\n${text}`);
            } catch (err) {
                await client.sendMessage(msg.to, `Failed to retrieve groups: ${err.message}`);
            }
        }
    }
});

// Check every 15 minutes: '*/15 * * * *'
cron.schedule('*/15 * * * *', async () => {
    console.log(`[${new Date().toLocaleTimeString()}] Running periodic Gameweek schedule check...`);
    await checkAndSendSmartReminders();
});

// Start the client
console.log('Starting WhatsApp Client...');
client.initialize();
