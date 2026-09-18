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

// Helper to guarantee window.WWebJS and getChat are always present in the browser page
async function ensureWWebJS(clientInstance) {
    const page = clientInstance.pupPage;
    if (!page || page.isClosed()) return false;
    try {
        const hasWWebJS = await page.evaluate(() => {
            return typeof window !== 'undefined' && typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChat === 'function';
        }).catch(() => false);

        if (!hasWWebJS) {
            console.log('🔄 window.WWebJS missing or wiped by page reload. Re-injecting utilities...');
            const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
            await page.evaluate(LoadUtils);
            console.log('✅ WWebJS re-injected successfully.');
        }
        return true;
    } catch (e) {
        console.warn('⚠️ WWebJS verification warning:', e.message);
        return false;
    }
}

// Resilient patch for sendMessage to eliminate "Cannot read properties of undefined (reading 'getChat')"
const originalSendMessage = Client.prototype.sendMessage;
Client.prototype.sendMessage = async function(chatId, content, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await ensureWWebJS(this);
        try {
            return await originalSendMessage.call(this, chatId, content, options);
        } catch (err) {
            lastError = err;
            const msg = String(err.message || err);
            console.warn(`[Send Attempt ${attempt}/3] Error sending to ${chatId}: ${msg}`);
            if (msg.includes('getChat') || msg.includes('Execution context') || msg.includes('Navigation') || msg.includes('Session closed')) {
                console.log('WhatsApp Web context refreshing. Re-injecting and retrying in 2s...');
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
                    if (this.pupPage && !this.pupPage.isClosed()) {
                        await this.pupPage.evaluate(LoadUtils);
                    }
                } catch (_) {}
                continue;
            }
            throw err;
        }
    }
    throw lastError;
};

// Resilient patch for getChats to eliminate missing WWebJS errors
const originalGetChats = Client.prototype.getChats;
Client.prototype.getChats = async function() {
    await ensureWWebJS(this);
    return originalGetChats.call(this);
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
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
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

// Fetch live Premier League Gameweek & Fixture details from official FPL API with cache-busting
async function getNextGameweekInfo() {
    try {
        const timestamp = Date.now();
        const res = await fetch(`https://fantasy.premierleague.com/api/bootstrap-static/?_t=${timestamp}`, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });
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

        // Fetch live fixtures for this gameweek with cache-busting
        const fixRes = await fetch(`https://fantasy.premierleague.com/api/fixtures/?event=${nextEvent.id}&_t=${timestamp}`, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });
        if (!fixRes.ok) throw new Error(`FPL fixtures status: ${fixRes.status}`);
        const fixtures = await fixRes.json();

        const timedFixtures = fixtures.filter(f => f.kickoff_time);
        timedFixtures.sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

        const firstKickoff = timedFixtures.length > 0 ? new Date(timedFixtures[0].kickoff_time) : new Date(nextEvent.deadline_time);
        const deadline = new Date(nextEvent.deadline_time);

        // 1. Live Top In-Form Players (active available players only)
        const topForm = data.elements
            .filter(p => p.status === 'a' && parseFloat(p.form || 0) > 0)
            .sort((a, b) => parseFloat(b.form || 0) - parseFloat(a.form || 0))
            .slice(0, 8)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}, Form: ${p.form}, Pts: ${p.total_points}, Goals: ${p.goals_scored || 0})`)
            .join('\n');

        // 2. Live Top Transferred-In Players this week
        const topTransferredIn = data.elements
            .filter(p => p.status === 'a')
            .sort((a, b) => (b.transfers_in_event || 0) - (a.transfers_in_event || 0))
            .slice(0, 8)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}, ${p.selected_by_percent}% owned, +${p.transfers_in_event} transfers in)`)
            .join('\n');

        // 3. Live Top Transferred-Out Players (who managers are panic-selling)
        const topTransferredOut = data.elements
            .filter(p => (p.transfers_out_event || 0) > 0)
            .sort((a, b) => (b.transfers_out_event || 0) - (a.transfers_out_event || 0))
            .slice(0, 6)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}, -${p.transfers_out_event} sold this GW, Status: ${p.status === 'a' ? 'Available' : p.news || 'Flagged'})`)
            .join('\n');

        // 4. Live Most Owned / The Template Herd
        const topOwned = data.elements
            .filter(p => p.status === 'a')
            .sort((a, b) => parseFloat(b.selected_by_percent || 0) - parseFloat(a.selected_by_percent || 0))
            .slice(0, 8)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}, ${p.selected_by_percent}% owned, Form: ${p.form})`)
            .join('\n');

        // 5. Live Verified Differential Gems (<15% owned with high form)
        const topDifferentials = data.elements
            .filter(p => p.status === 'a' && parseFloat(p.selected_by_percent || 0) < 15 && parseFloat(p.form || 0) >= 3.5)
            .sort((a, b) => parseFloat(b.form || 0) - parseFloat(a.form || 0))
            .slice(0, 6)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}, Form: ${p.form}, ${p.selected_by_percent}% owned, Pts: ${p.total_points})`)
            .join('\n');

        // 6. Live Official Injury Flags & News directly from club press conferences
        const injuries = data.elements
            .filter(p => p.news && p.news.length > 0 && (p.selected_by_percent > 2.5 || p.now_cost > 65))
            .slice(0, 8)
            .map(p => `• ${p.web_name} (${teams[p.team]?.name || 'PL'}): ${p.news} (${p.chance_of_playing_next_round !== null ? p.chance_of_playing_next_round + '% chance' : 'Under assessment'})`)
            .join('\n');

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
            })),
            topTransferredIn,
            topTransferredOut,
            topForm,
            topOwned,
            topDifferentials,
            injuries
        };
    } catch (e) {
        console.error('Error fetching FPL Gameweek info:', e.message);
        return null;
    }
}

// List of models to try in order of preference
const FALLBACK_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest'
];

// Helper to call Gemini with Google Search grounding and graceful direct fallback
async function callGeminiWithFallback(prompt, useSearch = true) {
    for (const modelName of FALLBACK_MODELS) {
        // 1. First attempt: Live Google Search grounding for real-time web context & press conferences
        if (useSearch) {
            try {
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    tools: [{ googleSearch: {} }]
                });
                const res = await model.generateContent(prompt);
                let text = res.response.text().trim();
                if (text) {
                    return text.replace(/^#+\s*(.*)$/gmi, '*$1*').replace(/\*\*/g, '*');
                }
            } catch (err) {
                console.log(`Search grounding unavailable for ${modelName} (${err.message}), falling back to direct generation...`);
            }
        }

        // 2. Direct generation using the injected official live Premier League API data
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const res = await model.generateContent(prompt);
            let text = res.response.text().trim();
            if (text) {
                return text.replace(/^#+\s*(.*)$/gmi, '*$1*').replace(/\*\*/g, '*');
            }
        } catch (err) {
            console.log(`Direct generation failed for ${modelName}:`, err.message);
        }
    }
    return null;
}

// Formats any Date object into 5 international timezones with bold WhatsApp formatting
function formatMultiTimezone(date) {
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    const uk = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Europe/London' }).format(date);
    const ist = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Asia/Kolkata' }).format(date);
    const cet = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Europe/Paris' }).format(date);
    const ast = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Asia/Qatar' }).format(date);
    const pst = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'America/Los_Angeles' }).format(date);
    return `*${uk} UK | ${ist} IST | ${cet} CET | ${ast} AST | ${pst} PST*`;
}

// Local fallback if AI service is completely unreachable
function generateLocal48hPreview(gwInfo) {
    const lines = [
        `🚨 *48-HOUR FPL NOTICE: ${gwInfo.name.toUpperCase()} ON THE HORIZON* 🚨\n`,
        `⚽ *First Match:* ${gwInfo.firstMatch}`,
        `⏰ *Kickoff:* ${formatMultiTimezone(gwInfo.firstKickoff)}`,
        `⏳ *FPL Team Lock Deadline:* ${formatMultiTimezone(gwInfo.deadline)}\n`,
        `📜 *THE 48-HOUR ODE:*\n` +
        `_Two days to ponder, two days to scheme,_\n` +
        `_To rip up your bench or stay with the dream._\n` +
        `_Will you hold your knees steady or take a mad hit?_\n` +
        `_Sunday will tell if you’re genius or... not quite fit!_\n`,
        `*MATCH SCHEDULE:*`
    ];
    gwInfo.fixtures.forEach(f => {
        lines.push(`• ⚽ *${f.home}* vs *${f.away}* - ${formatMultiTimezone(f.kickoff)}`);
    });
    lines.push(`\n🎭 *EARLY PUNDIT BANTER:* To the managers already itching to rage-transfer at 2 AM—step away from the app! Check press conferences first, guard your free transfer like gold, and start scheming your *Captain (C)* armband!`);
    return lines.join('\n');
}

function generateLocal24hAlert(gwInfo) {
    return `⏳ *FINAL 24-HOUR DEADLINE ALERT: ${gwInfo.name.toUpperCase()}* ⏳\n\n` +
           `⚽ *Opening Match:* ${gwInfo.firstMatch}\n` +
           `⏰ *Kickoff:* ${formatMultiTimezone(gwInfo.firstKickoff)}\n` +
           `🔒 *OFFICIAL FPL DEADLINE:* ${formatMultiTimezone(gwInfo.deadline)} (Team lock happens 90 mins before kickoff!)\n\n` +
           `📜 *THE PRE-DEADLINE BALLAD:*\n` +
           `_A deadline forgotten, a captain unpinned,_\n` +
           `_Your fifteen-point hero left out in the wind._\n` +
           `_The green arrows beckon, the red arrows loom,_\n` +
           `_One careless misclick spells mini-league doom!_\n\n` +
           `🎯 *CAPTAINCY DECISION MATRIX:*\n` +
           `• 🛡️ *The Sensible Shield (The Safe Armband):* Back your verified high-ownership talisman so you can sleep peacefully tonight.\n` +
           `• ⚔️ *The Madman's Dagger (The Differential Punt):* Sub-15% owned wildcard for the reckless souls chasing glorious redemption!\n` +
           `• 🦺 *The Vice-Captain Lifejacket:* Put that VC armband on someone guaranteed 90 minutes. Tactical benchings are real!\n\n` +
           `📋 *FINAL MANAGER CHECKLIST (NO EXCUSES):*\n` +
           `• [ ] *CAPTAIN (C) LOCKED:* Double-check the armband! Did you actually pin it on your talisman, or did you leave it on your 4.0m backup keeper?!\n` +
           `• [ ] *VICE-CAPTAIN (VC) CONFIRMED:* Insurance secured! Because warm-up tweaks happen, and crying in the group chat scores 0 points.\n` +
           `• [ ] *STARTING XI LOCKED:* No red or yellow-flagged ghosts haunting your starting 11.\n` +
           `• [ ] *BENCH ORDER PRIORITIZED:* Left-to-right! Your #1 sub is your savior, #3 is where hauls go to die.\n` +
           `• [ ] *PRESS CONFERENCES CHECKED:* Don't get bamboozled by cryptic press conference mind games.\n` +
           `• [ ] *KNEE-JERK HIT REGRET CHECK:* Did you take a -4 or -8? Own your chaos and pray for a brace!\n\n` +
           `🏃‍♂️ Lock in your squads before the FPL servers melt down!`;
}

// Generate 48-Hour Fixture Preview via Gemini
async function generate48hPreview(gwInfo) {
    const deadlineFormatted = formatMultiTimezone(gwInfo.deadline);
    const kickoffFormatted = formatMultiTimezone(gwInfo.firstKickoff);

    const fixtureListText = (gwInfo.fixtures || []).map(f =>
        `• ⚽ *${f.home}* vs *${f.away}* - ${formatMultiTimezone(f.kickoff)}`
    ).join('\n');

    const prompt = `You are an elite Premier League and Fantasy Premier League (FPL) broadcast host with razor-sharp wit, poetic humor, and playful teasing banter towards mini-league managers.
Today is 48 HOURS before the kickoff of ${gwInfo.name}.
Opening Match: ${gwInfo.firstMatch} (Kickoff: ${kickoffFormatted}).
FPL Team Selection Deadline: ${deadlineFormatted} (90 mins before kickoff).

VERIFIED OFFICIAL LIVE GAMEWEEK FIXTURES (DO NOT CHANGE OR INVENT MATCHES):
${fixtureListText}

VERIFIED OFFICIAL LIVE FPL STATS & MARKET TRENDS (DIRECTLY FROM PREMIER LEAGUE):
Top In-Form Players (Current Season Form):
${gwInfo.topForm || 'N/A'}

Top Transferred-In Players This Round:
${gwInfo.topTransferredIn || 'N/A'}

Most Transferred-Out Players This Round (The Sell-Off):
${gwInfo.topTransferredOut || 'N/A'}

The Template Herd (Highest Owned Active Players):
${gwInfo.topOwned || 'N/A'}

Verified Differential Gems (<15% Ownership High Upside):
${gwInfo.topDifferentials || 'N/A'}

Official Club Injury Flags & Press Conference News:
${gwInfo.injuries || 'No major flags'}

CRITICAL FPL CONTENT REQUIREMENTS:
1. High-energy WhatsApp broadcast focusing 100% on active FPL PLAYERS, transfers, form, goals, clean sheets, and captaincy picks.
2. ABSOLUTE GROUNDING MANDATE: Every player name, club, ownership %, and statistic MUST be taken directly from the verified live lists provided above. DO NOT use stale data from past seasons.
3. ABSOLUTE RULE: DO NOT mention managers or head coaches under any circumstances (managers score 0 FPL points). Focus entirely on active players.
4. ABSOLUTE BAN: Under NO circumstances mention Erik ten Hag, Jürgen Klopp, or Mauricio Pochettino. They are not in the Premier League.
5. WITTY POETIC PROLOGUE: Include a clever, funny 2-to-4 line rhyming verse about FPL obsession, managers sweating their free transfers, or fighting the urge to knee-jerk.
6. PLAYFUL TEASING & BANTER:
   - Tease the template clones who copy whatever the top influencers do.
   - Gently roast managers itching to take -4 hits on a Thursday night before press conferences.
   - Banter about leaving 15 points on the bench.
7. List all the official match pairings provided above with their multi-timezone kickoff times.
8. Highlight 2 big blockbuster clashes from an FPL perspective (attacking firepower vs leaky defenses).
9. Discuss the top in-form players and transfer frenzy from the official live FPL data above.
10. Early Captaincy Radar: Remind managers to start planning both their Captain (C) and Vice-Captain (VC).
11. Emphasize the FPL team lock deadline (${deadlineFormatted}).
12. CRITICAL FORMATTING: Use single asterisks (*bold*) for WhatsApp bolding. Never use double asterisks (**). Do not use markdown # headers. Only list the actual matches provided above.`;

    const aiText = await callGeminiWithFallback(prompt, true);
    return aiText || generateLocal48hPreview(gwInfo);
}

// Generate 24-Hour Final Deadline & Captaincy Alert via Gemini
async function generate24hDeadlineAlert(gwInfo) {
    const deadlineFormatted = formatMultiTimezone(gwInfo.deadline);
    const kickoffFormatted = formatMultiTimezone(gwInfo.firstKickoff);

    const fixtureListText = (gwInfo.fixtures || []).map(f =>
        `• ⚽ *${f.home}* vs *${f.away}* - ${formatMultiTimezone(f.kickoff)}`
    ).join('\n');

    const prompt = `You are an elite Premier League and Fantasy Premier League (FPL) analyst celebrated for your razor-sharp tactical insight, witty poetic humor, and hilarious teasing banter aimed directly at mini-league managers.
Today is exactly 24 HOURS before the kickoff of ${gwInfo.name}!
Opening match: ${gwInfo.firstMatch} (Kickoff: ${kickoffFormatted}).
THE OFFICIAL FPL DEADLINE IS: ${deadlineFormatted} (Team lock happens 90 minutes before kickoff).

VERIFIED OFFICIAL LIVE GAMEWEEK FIXTURES (DO NOT INVENT OR ALTER MATCHES):
${fixtureListText}

VERIFIED OFFICIAL LIVE FPL STATS & MARKET TRENDS (DIRECTLY FROM PREMIER LEAGUE):
Top In-Form Players (Current Season Form):
${gwInfo.topForm || 'N/A'}

Top Transferred-In Players This Round:
${gwInfo.topTransferredIn || 'N/A'}

Most Transferred-Out Players This Round (The Sell-Off):
${gwInfo.topTransferredOut || 'N/A'}

The Template Herd (Highest Owned Active Players):
${gwInfo.topOwned || 'N/A'}

Verified Differential Gems (<15% Ownership High Upside):
${gwInfo.topDifferentials || 'N/A'}

Official Club Injury Flags & Press Conference News:
${gwInfo.injuries || 'None'}

CRITICAL FPL CONTENT REQUIREMENTS:
1. Urgent Headline: ⏳ *FINAL 24-HOUR DEADLINE ALERT: ${gwInfo.name.toUpperCase()}* ⏳
2. Prominently display the EXACT FPL DEADLINE (${deadlineFormatted}). Warn that last-minute server crashes wait for no one.
3. ABSOLUTE GROUNDING MANDATE: Every player name, club, ownership %, and statistic MUST be taken directly from the verified live lists provided above. DO NOT use stale data from previous seasons.
4. ABSOLUTE RULE: DO NOT mention managers or head coaches (managers score 0 FPL points). Focus 100% on active players.
5. ABSOLUTE BAN: Under NO circumstances mention Erik ten Hag, Jürgen Klopp, or Mauricio Pochettino.
6. WITTY POETIC ODE (2-4 lines of clever, rhyming verse poking fun at the tragedy of bench points, blanking captains, or mini-league rivalry).
7. PLAYFUL TEASING & ROASTING:
   - Roast the template merchants whose entire team is copied from Reddit or Twitter/X.
   - Call out the desperate 2 AM knee-jerkers sitting on -8 hits.
   - Tease the differential hipsters betting their weekend on a 1.5% owned gamble.
   - Remind everyone that the player sitting on their 1st bench spot is statistically guaranteed to haul.
8. "Captaincy Decision Matrix":
   - 🛡️ *The Sensible Shield (Safe Pick):* High-ownership, high-floor talisman chosen strictly from the Top In-Form or Template lists above for managers who value sleep and sanity.
   - ⚔️ *The Madman's Dagger (Differential Punt):* Sub-15% ownership high-upside pick chosen strictly from the Verified Differential Gems list above.
   - 🦺 *The Vice-Captain Lifejacket:* Why your VC choice is critical insurance against late rotation heartbreak.
9. Top 3 Transfer Trends & Key Matchups for this round from the official live FPL data provided above.
10. Key injury warnings from the official injury list above (calling out suspicious 75% orange flags).
11. *FINAL MANAGER CHECKLIST (CRITICAL: MUST INCLUDE BOTH CAPTAIN AND VICE-CAPTAIN WITH BANTER!)*:
   - [ ] *CAPTAIN (C) LOCKED:* Double-check the armband! Did you actually confirm it on your star talisman, or did you leave it on your 4.0m bench fodder?
   - [ ] *VICE-CAPTAIN (VC) CONFIRMED:* Insurance secured! Because unexpected benchings happen, and tears don't generate FPL points.
   - [ ] *STARTING XI LOCKED:* Ensure no red-flagged injured players are chilling in your starting lineup.
   - [ ] *BENCH ORDER PRIORITIZED:* Left-to-right! Your #1 sub is your hero; don't leave your highest ceiling player in slot 3!
   - [ ] *PRESS CONFERENCES CHECKED:* Verified late team news?
   - [ ] *KNEE-JERK HIT REGRET CHECK:* Reconciled with any -4 or -8 point deductions?
12. High energy closing call: "Lock in your teams before the servers melt!"
13. CRITICAL FORMATTING: Use single asterisks (*bold*) for WhatsApp bolding. Never use double asterisks (**). Do not use markdown # headers. Only list the actual matches provided above.`;

    const aiText = await callGeminiWithFallback(prompt, true);
    return aiText || generateLocal24hAlert(gwInfo);
}

function getSanitizedChannelJid() {
    let jid = (process.env.TARGET_CHANNEL_JID || '').trim().replace(/['"]/g, '');
    if (jid && !jid.includes('@')) {
        jid += '@g.us';
    }
    return jid;
}

let isCheckingSchedule = false;

// Smart Scheduler: Checks every 15 minutes for 48h and 24h thresholds
async function checkAndSendSmartReminders(forcedType = null) {
    if (isCheckingSchedule && !forcedType) {
        console.log('Schedule check already running, skipping duplicate.');
        return false;
    }
    isCheckingSchedule = true;

    try {
        const targetChannelJid = getSanitizedChannelJid();
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
                    if (err.message && err.message.includes('getChat')) {
                        console.log('WhatsApp Web browser session stalled. Triggering PM2 auto-restart to refresh session...');
                        process.exit(1);
                    }
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
                    if (err.message && err.message.includes('getChat')) {
                        console.log('WhatsApp Web browser session stalled. Triggering PM2 auto-restart to refresh session...');
                        process.exit(1);
                    }
                }
            } else {
                console.log(`[Tracker] 24h deadline alert already delivered for ${gwInfo.name}.`);
            }
        }

        return true;
    } finally {
        isCheckingSchedule = false;
    }
}

// Event: QR code generation (Instant & 100% Reliable)
client.on('qr', (qr) => {
    console.log('\n================================================================');
    console.log('📱 SCAN THIS QR CODE IN WHATSAPP TO LINK (Instant 2-Sec Link):');
    console.log('================================================================\n');
    qrcode.generate(qr, { small: true });
    console.log('\n👉 On Phone: WhatsApp -> Settings -> Linked Devices -> Link a Device -> Point Camera at QR\n');
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
    const targetChannelJid = getSanitizedChannelJid();
    console.log(`Target WhatsApp Broadcast Group: ${targetChannelJid || 'Not configured'}\n`);

    console.log('Smart Gameweek Tracker initialized:');
    console.log('- 48-Hour Alert: Triggers 48h before the first kickoff of every Gameweek.');
    console.log('- 24-Hour Alert: Triggers 24h before the first kickoff of every Gameweek.');
    console.log('- Routine check runs every 15 minutes.');

    // 4-second settle delay to let WhatsApp Web finish initial React DOM hydration and chat store sync
    await new Promise(r => setTimeout(r, 4000));

    // Run check immediately on startup
    await checkAndSendSmartReminders();
});

const processedMessages = new Set();

async function safeReply(msg, text) {
    try {
        return await msg.reply(text);
    } catch (e1) {
        try {
            const dest = msg.fromMe ? (msg.to || msg.from) : msg.from;
            return await client.sendMessage(dest, text);
        } catch (e2) {
            console.error('Failed to deliver reply:', e2.message);
        }
    }
}

async function handleCommand(msg) {
    try {
        if (!msg || !msg.body) return;
        const msgId = msg.id ? msg.id._serialized : null;
        if (msgId && processedMessages.has(msgId)) return;
        if (msgId) {
            processedMessages.add(msgId);
            if (processedMessages.size > 200) processedMessages.clear();
        }

        const body = msg.body.trim().toLowerCase();
        if (!body.startsWith('!')) return;

        const targetChannelJid = getSanitizedChannelJid();
        const isTargetGroup = targetChannelJid && (msg.to === targetChannelJid || msg.from === targetChannelJid);

        console.log(`[Command Received] "${body}" from ${msg.fromMe ? 'Me (Self)' : msg.from}`);

        if (msg.fromMe || isTargetGroup) {
            if (body === '!status') {
                console.log('Replying to !status command...');
                const info = await getNextGameweekInfo();
                if (info) {
                    const now = new Date();
                    const hKickoff = ((info.firstKickoff - now) / 3600000).toFixed(1);
                    const hDeadline = ((info.deadline - now) / 3600000).toFixed(1);
                    await safeReply(msg, `🤖 *FPL Broadcaster Status*\n\n• Next: *${info.name}*\n• First Match: *${info.firstMatch}*\n• Kickoff: *${hKickoff} hrs*\n• Deadline: *${hDeadline} hrs*`);
                }
            } else if (body === '!preview' || body === '!preview48h') {
                console.log('Generating private 48h preview...');
                const info = await getNextGameweekInfo();
                if (info) {
                    await safeReply(msg, '⏳ *Generating 48-Hour Preview for your eyes only...*');
                    const text = await generate48hPreview(info);
                    await safeReply(msg, text);
                }
            } else if (body === '!preview24h') {
                console.log('Generating private 24h deadline alert...');
                const info = await getNextGameweekInfo();
                if (info) {
                    await safeReply(msg, '⏳ *Generating 24-Hour Alert for your eyes only...*');
                    const text = await generate24hDeadlineAlert(info);
                    await safeReply(msg, text);
                }
            } else if (body === '!48h' || body === '!fixtures') {
                console.log('Manual 48h broadcast command received.');
                await checkAndSendSmartReminders('48h');
            } else if (body === '!24h' || body === '!deadline' || body === '!reminder') {
                console.log('Manual 24h deadline broadcast command received.');
                await checkAndSendSmartReminders('24h');
            } else if (body === '!groups') {
                try {
                    const chats = await client.getChats();
                    const groups = chats.filter(c => c.isGroup);
                    const text = groups.map(g => `• *${g.name}*:\n${g.id._serialized}`).join('\n\n');
                    await safeReply(msg, `📋 *Your WhatsApp Groups & JIDs:*\n\n${text}`);
                } catch (err) {
                    await safeReply(msg, `Failed to retrieve groups: ${err.message}`);
                }
            } else if (body === '!help' || body === '!commands') {
                await safeReply(msg, 
                    `🤖 *FPL Broadcaster Commands:*\n\n` +
                    `• *!status* - Live Gameweek countdown & earliest kickoff\n` +
                    `• *!preview* - Preview 48-hour broadcast privately here\n` +
                    `• *!preview24h* - Preview 24-hour deadline alert privately here\n` +
                    `• *!groups* - List all connected WhatsApp groups & JIDs\n` +
                    `• *!help* - Show this menu\n\n` +
                    `*(Note: !48h and !24h broadcast directly to the configured group)*`
                );
            }
        }
    } catch (err) {
        console.error('Error handling command:', err.message);
    }
}

client.on('message_create', handleCommand);
client.on('message', handleCommand);

// Check every 15 minutes: '*/15 * * * *'
cron.schedule('*/15 * * * *', async () => {
    console.log(`[${new Date().toLocaleTimeString()}] Running periodic Gameweek schedule check...`);
    await checkAndSendSmartReminders();
});

// Event: Disconnect listener (Auto-restart via PM2)
client.on('disconnected', async (reason) => {
    console.error('⚠️ WhatsApp Client was disconnected:', reason);
    console.log('Restarting process via PM2 to re-establish clean connection...');
    try {
        await client.destroy();
    } catch (e) {}
    process.exit(1);
});

// Keep-alive ping every 5 minutes to prevent Chromium background freeze
setInterval(async () => {
    try {
        if (client && client.pupPage && !client.pupPage.isClosed()) {
            await client.pupPage.evaluate(() => window.location.href);
        }
    } catch (e) {
        console.log('[Keep-Alive] Ping failed, socket may be reconnecting.');
    }
}, 300000);

// Start the client
console.log('Starting WhatsApp Client...');
client.initialize();
