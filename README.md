# ⚽ FPL WhatsApp Broadcaster Bot

An automated 24/7 WhatsApp broadcaster bot for Fantasy Premier League (FPL) mini-leagues. Powered by **Google Gemini AI** and the official **Premier League API**.

Designed to run lightweight on free-tier cloud servers (such as Google Cloud **e2-micro**) with ultra-low memory consumption.

---

## 🌟 Key Features

* **🚨 48-Hour Kickoff Notice**: Automatically detects the earliest kickoff of every Gameweek (including Friday night matches and mid-week fixtures). Broadcasts match schedules converted across 5 timezones (UK, IST, CET, AST, PST) with early team news.
* **⏳ 24-Hour Final Deadline & Captaincy Alert**: Broadcasts exact countdown to the official FPL team selection lock deadline (90 minutes before kickoff), along with safe vs. differential captain recommendations and pre-deadline checklists.
* **🧠 Gemini AI with Live Google Search**: Uses `gemini-2.5-flash` with Google Search grounding to retrieve up-to-date fixture information, team news, and tactical tips.
* **💾 State Persistence**: Tracks sent alerts in `alerts_state.json` to prevent duplicate announcements across server reboots.
* **⚡ Ultra-Low RAM Optimizations**: Chromium flags tailored to run on 1 GB RAM cloud VMs without memory crashes.
* **💬 On-Demand Commands**:
  * `!fixtures` or `!48h`: Manually broadcast Gameweek fixture previews.
  * `!deadline` or `!24h`: Manually broadcast deadline & captaincy alerts.
  * `!status`: Check upcoming Gameweek kickoff and deadline countdown.

---

## 🚀 Quick Start (Local)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Techdebt2020/fpl-whatsapp-bot.git
   cd fpl-whatsapp-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your GEMINI_API_KEY, TARGET_CHANNEL_JID, and PHONE_NUMBER
   ```

4. **Link WhatsApp**:
   ```bash
   npm start
   ```
   Scan the terminal QR code or enter the 8-digit phone pairing code on WhatsApp (**Settings** → **Linked Devices** → **Link a Device**).

---

## ☁️ 24/7 Cloud Deployment (Google Cloud Always Free e2-micro)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full step-by-step instructions.

### 1-Liner Cloud Setup:
```bash
# 1. Enable 2GB Swap (critical for 1GB RAM VMs)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Install Node.js 20, Chromium, and PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get update -y && sudo apt-get install -y nodejs chromium-browser git
sudo npm install -g pm2

# 3. Clone & install bot
git clone https://github.com/Techdebt2020/fpl-whatsapp-bot.git ~/fpl-whatsapp-bot
cd ~/fpl-whatsapp-bot
cp .env.example .env
# Edit .env with your credentials
npm install

# 4. Link WhatsApp (one-time)
node index.js
# Scan QR code or enter 8-digit pairing code, then press Ctrl+C once ready

# 5. Run permanently with PM2
pm2 start index.js --name "fpl-whatsapp-bot"
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp /home/$USER
```

---

## 📜 License
MIT License
