# Deployment Guide: Google Cloud Compute Engine (GCE) e2-micro

Setting up the WhatsApp bot on Google Cloud's **Always Free** tier is straightforward. Follow these steps to get a 24/7 persistent bot running.

---

## Step 1: Create your Free VM in Google Cloud

1. Go to the [Google Cloud Console Compute Engine](https://console.cloud.google.com/compute/instances).
2. Click **Create Instance**.
3. Configure the VM to match the **GCP Free Tier requirements**:
   - **Name**: `fpl-whatsapp-bot`
   - **Region**: Choose one of the following (US Free Tier regions):
     - `us-central1` (Iowa)
     - `us-east1` (South Carolina)
     - `us-west1` (Oregon)
   - **Machine configuration**:
     - Series: **E2**
     - Machine type: **e2-micro** (2 vCPU, 1 GB RAM)
   - **Boot disk**:
     - Click **Change**.
     - Operating System: **Ubuntu**
     - Version: **Ubuntu 22.04 LTS**
     - Boot disk type: **Standard persistent disk**
     - Size: **30 GB** (GCP free tier limits disk size up to 30 GB).
     - Click **Select**.
4. Click **Create** at the bottom.

---

## Step 2: Connect to your VM

1. In the GCP VM list, click the **SSH** button next to your new `fpl-whatsapp-bot` instance.
2. A browser terminal window will open, logging you directly into the server.

---

---

## Step 3: Crucial Fix for e2-micro — Enable 2 GB Swap Space

Google Cloud Ubuntu images have **0 MB swap** by default. When Chromium launches on an `e2-micro` (1 GB RAM), memory spikes cause the VM to freeze or OOM-kill Chromium. Adding a **2 GB Swap file** expands total usable memory to **3 GB**, completely eliminating freezes:

```bash
# Create and activate 2 GB swap space (takes 10 seconds)
sudo fallocate -l 2G /swapfile && \
sudo chmod 600 /swapfile && \
sudo mkswap /swapfile && \
sudo swapon /swapfile && \
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Step 4: Install Node.js v20 & Chromium Dependencies

Copy and paste these commands into the SSH terminal:

```bash
# 1. Update system packages
sudo apt-get update -y

# 2. Install Node.js v20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs chromium-browser

# 3. Install headless browser libraries
sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 \
pangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
lsb-release xdg-utils wget git
```

---

## Step 4: Move your Bot code to the VM

1. On the server, create a folder for the bot:
   ```bash
   mkdir fpl-bot && cd fpl-bot
   ```
2. Create `package.json`, `index.js`, and `.env` using nano (or clone your GitHub repository if you put this in git):
   ```bash
   nano .env
   # Paste your env values, then press Ctrl+O to save and Ctrl+X to exit
   ```

---

## Step 5: Install Bot Dependencies & Scan QR Code

1. Install npm packages:
   ```bash
   npm install
   ```
2. Start the bot to scan the QR code:
   ```bash
   npm start
   ```
3. A QR code will print in the browser SSH terminal. Open WhatsApp on your phone, go to **Linked Devices**, and scan the screen.
4. Once it prints `WhatsApp Client is ready!`, test it by sending `!fixtures` in your group chat.
5. Stop the bot temporarily in the terminal using `Ctrl + C`.

---

## Step 6: Keep it running 24/7 in the background

To ensure the bot keeps running even if you close the SSH window, we use **PM2** (Process Manager):

```bash
# 1. Install PM2 globally
sudo npm install -g pm2

# 2. Start the bot under PM2
pm2 start index.js --name "fpl-whatsapp-bot"

# 3. Setup PM2 to restart the bot automatically if the VM reboots
pm2 startup
# (Copy and paste the command printed by the output of the line above, then run:)
pm2 save
```

### Useful PM2 commands:
- Check logs: `pm2 logs`
- Check bot status: `pm2 status`
- Restart bot: `pm2 restart fpl-whatsapp-bot`
