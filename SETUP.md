# Foghorn Setup Guide

This guide walks through configuring a fresh installation of Foghorn from scratch. Because Foghorn acts as your autonomous social influence pipeline, it requires API access to your chosen platforms, LLM providers, and an approval channel.

## 1. Prerequisites

You must have **Bun** installed on your system (macOS/Linux).
```bash
curl -fsSL https://bun.sh/install | bash
```

Clone the repository and install dependencies:
```bash
git clone https://github.com/TDH-Labs/foghorn.git
cd foghorn
bun install
```

Copy the environment template:
```bash
cp .env.example .env.local
chmod 600 .env.local
```

## 2. Core Configuration

Open `.env.local` in your editor.

### Sentinel Secret
Generate a random secret for the HMAC sentinel (which ensures the publisher only posts bytes that exactly match the approved draft).
```bash
openssl rand -hex 32
```
Paste the output into `FOGHORN_SENTINEL_SECRET`.

### LLM Provider
Foghorn supports Anthropic and OpenRouter.
1. **Anthropic**: Get an API key from [console.anthropic.com](https://console.anthropic.com/) and set `ANTHROPIC_API_KEY`.
2. **OpenRouter**: Get an API key from [openrouter.ai](https://openrouter.ai/) and set `OPENROUTER_API_KEY`. It will auto-detect OpenRouter if set.

### Operator Specialty (Optional but Recommended)
To help the AI agent focus on the right topics and extract the most relevant evidence, you can specify your business or specialties as a comma-separated list.
```env
FOGHORN_BUSINESS_DOMAINS="indie hacking, typescript engineering, digital marketing"
```

## 3. Communication Channels

### Beeper (Ingestion)
Foghorn reads your chat history via Beeper to profile your voice and ingest context.
1. Install [Beeper Desktop](https://www.beeper.com/).
2. Open Beeper Settings → Developer.
3. Generate a new API token.
4. Set `BEEPER_ACCESS_TOKEN`.

### Telegram (Approvals)
Foghorn requires a dedicated Telegram bot to send you drafts for approval.
1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot`, choose a name and username.
3. Copy the HTTP API Token and set `FOGHORN_TELEGRAM_BOT_TOKEN`.
4. Message your new bot and say "hello".
5. Find your personal Chat ID by visiting: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
6. Look for `"chat": {"id": 123456789}` in the JSON response.
7. Set `FOGHORN_TELEGRAM_CHAT_ID` to that number.

## 4. Platform Connections

You only need to configure the platforms you intend to publish to.

### X (Twitter)
1. Go to the [X Developer Portal](https://developer.twitter.com/).
2. Create a Project and App.
3. Set User Authentication Settings to "Read and write" (OAuth 1.0a).
4. Generate Consumer Keys and Access Tokens.
5. Set `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`.

### LinkedIn
1. Go to the [LinkedIn Developer Portal](https://developer.linkedin.com/).
2. Create an App. You will need to link a company page.
3. Request access to the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products.
4. Under the "Auth" tab, copy your Client ID and Client Secret.
5. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.
6. (Do not manually set the `LINKEDIN_ACCESS_TOKEN` — the CLI will generate it).

### Nostr
1. Generate or export your private key (nsec).
2. Set `NOSTR_NSEC`.

## 5. Initialization

Once `.env.local` is populated, initialize the database:
```bash
bun run foghorn.ts init
```

Authorize your platforms (this will launch an OAuth flow for LinkedIn):
```bash
bun foghorn.ts connect all
```

Build your AI voice profile from your Beeper history:
```bash
bun foghorn.ts profile build
bun foghorn.ts profile ratify
```

Build the platform scores to determine where Foghorn should focus:
```bash
bun foghorn.ts score build
bun foghorn.ts score ratify
```

## 6. Launching

Foghorn is designed to run in the background as a launchd daemon (macOS).
To install the background services:
```bash
./services/install.sh
```

**Shadow Mode:** Foghorn starts at Autonomy Level 0 (L0) for each platform. In L0, it will draft and approve posts, but it will **never** actually publish them. It runs in "shadow mode" so you can observe its behavior safely.

As you approve good drafts in Telegram, Foghorn's autonomy streak will increase, eventually offering promotions to L1 (scheduled publishing) and L2 (immediate publishing).
