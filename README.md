# Meridian

Real-time prediction-market monitor: whale, volume, velocity and regional-surge signals on a world map, with Discord notifications. Data from Polymarket.

## Quick Start

Prerequisites:
- [Bun](https://bun.sh)
- A Postgres database (e.g. [Supabase](https://supabase.com), session pooler or direct URL)
- A Redis instance (e.g. [Upstash](https://upstash.com), `rediss://` URL)

Tables are created automatically on first start.

Install dependencies:
```bash
bun install
```

Optionally configure `.env`:
```env
PORT=3000

# Polymarket CLOB Configuration
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market

# Trading Threshold (USD)
MIN_AMOUNT_THRESHOLD=1000

# Optional Discord integration (omit all three to run without Discord)
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_test_guild_id

# Redis (Upstash) and Postgres (Supabase)
REDIS_URL=rediss://default:<password>@<name>.upstash.io:6379
DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>.pooler.supabase.com:5432/postgres

# Admin Security
ADMIN_API_KEY=changeme
```

Run the services (in separate terminals):
```bash
# Terminal 1: Ingestion Service (Monitors markets)
bun run start:ingest

# Terminal 2: API/gateway (also sends notifications when Discord is enabled)
bun start
```

The API, signal engine, ingestion service, and web app work without Discord
credentials. To enable Discord, set `DISCORD_TOKEN`, then register slash
commands separately with `bun run deploy` (requires `DISCORD_CLIENT_ID`).

## Deployment

- **Backend (Oracle Cloud Always Free VM, or any host that runs Docker):** the
  API and ingestion service run in one container built from the `Dockerfile`.
  ```bash
  docker build -t meridian .
  docker run -d --name meridian --restart unless-stopped \
    -p 3000:3000 --env-file .env meridian
  ```
  Set `DATABASE_URL` (Supabase), `REDIS_URL` (Upstash), `ADMIN_API_KEY`,
  `JWT_SECRET` and `DASHBOARD_ORIGIN` (the Vercel URL) in `.env`. Serve the
  backend over HTTPS (e.g. Cloudflare Tunnel or Caddy) so the dashboard can use
  `https://` and `wss://`.
- **Dashboard (Vercel):** import the repo with root directory `app` and set
  `VITE_API_URL` to the backend's HTTPS URL.

No Discord variables are required. To enable Discord later, add `DISCORD_TOKEN`,
`DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID` to `.env`, then run
`bun run deploy` from a trusted local environment with the same credentials.

## Discord Commands

Manage the bot directly from Discord:

*   **`!add <event_slug>`**: Add all markets for a specific Polymarket event.
    *   *Example*: `!add presidential-election-2024`
*   **`!remove <market_slug_fragment>`**: Remove single market by partial slug match.
    *   *Example*: `!remove trump`
*   **`!setthreshold <amount>`**: Dynamically update the global minimum trade amount ($).
    *   *Example*: `!setthreshold 5000`
*   **`!setevent <event_slug_or_fragment> <amount>`**: Set a custom threshold for a specific event (overrides global).
    *   *Example*: `!setevent israel-strikes 100`
*   **`!event <event_slug>`**: View real-time stats (prices, volume) for an event.
    *   *Example*: `!event presidential-election-2024`

## API

**Add an event (and its markets):**
```bash
curl -X POST http://localhost:3000/api/events/presidential-election-2024 \
  -H "x-api-key: changeme"
```

**Remove an event:**
```bash
curl -X DELETE http://localhost:3000/api/events/presidential-election-2024 \
  -H "x-api-key: changeme"
```

**Status:**
- `GET /health` - Health check
- `GET /status` - Server status & market count

## How It Works

1. **Ingestion Service**: Connects to Polymarket's **CLOB (Central Limit Order Book)** via WebSocket for real-time trade data. It filters trades by `MIN_AMOUNT_THRESHOLD` and pushes valid trades to a **Redis Queue**.
2.  **Signal Engine**: Analyzes every single trade in real-time to detect whales ($20k+), volume anomalies, price velocity, and regional surges.
    *   [📖 Read Signal Engine Docs](docs/SIGNAL_ENGINE.md)
3.  **Map Engine**: A high-performance visualization system that processes thousands of markets in a WebWorker and renders them using MapLibre GL.
    *   [📖 Read Map Engine Docs](docs/MAP_ENGINE.md)
4.  **Bot Service**: Consumes trades from Redis, calculates implied probabilities locally (YES + NO = 100%), and formats Discord embeds.

## Documentation

- [**Signal Engine**](docs/SIGNAL_ENGINE.md): Deep dive into detection algorithms (Whale, Velocity, Anomaly).
- [**Map Engine**](docs/MAP_ENGINE.md): How the WebGL map handles real-time data and geocoding.
- [**Logic Summary**](docs/LOGIC_SUMMARY.md): Overview of the microservices architecture.
