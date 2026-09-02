require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function runDiagnostics() {
    console.log('================================================================');
    console.log('🔍 FPL BROADCASTER - DIAGNOSTIC SYSTEM CHECK');
    console.log('================================================================\n');

    let allPassed = true;

    // 1. Check .env config
    const apiKey = process.env.GEMINI_API_KEY;
    const channelJid = process.env.TARGET_CHANNEL_JID;
    const phone = process.env.PHONE_NUMBER;

    console.log('1. Configuration Check:');
    if (apiKey) {
        console.log('   ✅ GEMINI_API_KEY: Configured (' + apiKey.substring(0, 8) + '...)');
    } else {
        console.log('   ❌ GEMINI_API_KEY: Missing in .env');
        allPassed = false;
    }

    if (channelJid) {
        console.log('   ✅ TARGET_CHANNEL_JID: ' + channelJid);
    } else {
        console.log('   ❌ TARGET_CHANNEL_JID: Missing in .env');
        allPassed = false;
    }

    if (phone) {
        console.log('   ✅ PHONE_NUMBER: ' + phone);
    } else {
        console.log('   ⚠️ PHONE_NUMBER: Not configured (optional)');
    }

    // 2. Check FPL API connectivity
    console.log('\n2. Official Premier League API:');
    try {
        const res = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const nextGw = data.events.find(e => e.is_next) || data.events.find(e => e.is_current);
        console.log(`   ✅ Connected! Upcoming: ${nextGw.name} (Deadline: ${nextGw.deadline_time})`);
    } catch (e) {
        console.log('   ❌ Failed to reach FPL API: ' + e.message);
        allPassed = false;
    }

    // 3. Check Google Gemini AI
    console.log('\n3. Google Gemini AI:');
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const testRes = await model.generateContent('Reply with: Gemini Connected');
        console.log('   ✅ ' + testRes.response.text().trim());
    } catch (e) {
        console.log('   ❌ Gemini AI Error: ' + e.message);
        allPassed = false;
    }

    // 4. Check WhatsApp Session Directory
    console.log('\n4. WhatsApp Local Authentication:');
    const authDir = path.join(__dirname, '.wwebjs_auth', 'session');
    if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
        console.log('   ✅ Saved Session Found in .wwebjs_auth/session');
    } else {
        console.log('   ⚠️ No complete session in .wwebjs_auth/session yet.');
        console.log('      Run: npm run login (to link your phone)');
    }

    console.log('\n================================================================');
    if (allPassed) {
        console.log('🎯 SYSTEM STATUS: HEALTHY & READY TO BROADCAST!');
    } else {
        console.log('⚠️ SYSTEM STATUS: NEEDS ATTENTION (Check errors above)');
    }
    console.log('================================================================\n');
}

runDiagnostics();
