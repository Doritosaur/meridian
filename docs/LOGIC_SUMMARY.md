# Meridian - Logic Summary

## Overview

This bot monitors Polymarket trades by listening to the **Polymarket Central Limit Order Book (CLOB)** via WebSocket. It utilizes a **Microservices Architecture** with **Redis** to ensure high throughput, reliability, and separation of concerns.

## Core Architecture

```mermaid
graph TD
    subgraph "Ingest Service"
        CLOB[Polymarket CLOB WebSocket] -->|Real-time Trade Data| Listener[CLOB Listener Producer]
        Listener -->|Add Job (Fast)| Redis[(Redis Queue)]
        Events[Redis Pub/Sub] -->|Updates| Listener
    end

    subgraph "Bot Service"
        Redis -->|Process Job (Rate Limited)| Worker[Trade Worker Consumer]
        Worker -->|Calculate Probabilities| LocalCalc[Local Math]
        Worker -->|Send Embed| Discord[Discord Webhook]
        API[Express API] -->|Publish Updates| Events
        DiscordCmds[Discord Commands] -->|Publish Updates| Events
    end
```

## Key Components

### 1. Ingest Service (`src/ingest/index.js`)
*   **Role**: Dedicated service for market monitoring and data ingestion.
*   **Components**:
    *   **CLOB Listener**: Connects to Polymarket's WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`) and listens for `last_trade_price`.
    *   **Market Fetcher**: Periodically syncs markets.
*   **Logic**:
    *   Filters trades below `MIN_AMOUNT_THRESHOLD`.
    *   **Signal Engine**: Analyzes every trade for anomalies (Whales, Velocity, Panic) and broadcasts `signal` events.
    *   **Map Engine**: Broadcasts batched market updates to the frontend.
    *   Pushes trade data to **Redis Queue** (Fire-and-Forget).
    *   Listens to **Redis Pub/Sub** for dynamic configuration changes (added markets, threshold updates) from the Bot Service.

### 2. Redis Framework
*   **Queue (BullMQ)**: Buffers trade events between Ingest and Bot services.
    *   Persistence: Jobs survive restarts.
    *   Rate Limiting: Max 5 jobs/sec (Protect Discord API).
*   **Pub/Sub**: Synchronizes state (e.g., "New Market Added") between the two services.

### 3. Bot Service (`src/index.js`)
*   **Role**: User-facing interface (Discord + API) and notification processing.
*   **Components**:
    *   **Trade Worker**: Consumes jobs from Redis, calculates probabilities, and sends Discord notifications.
    *   **Discord Bot**: Handles commands (`!add`, `!remove`) and interactive components.
    *   **API**: REST endpoints for administrative control.
*   **Logic**:
    *   When a user adds a market, it publishes an event via Redis Pub/Sub. The Ingest Service picks this up and subscribes to the new market dynamically.

### 4. Market Registry -- `src/database/marketRegistry.js`
*   **Role**: Persistent storage for tracked markets and bot settings.
*   **Storage**: SQLite (`data/markets.db`).
*   **Features**:
    *   Stores `clob_token_ids` for subscriptions.
    *   Stores `event_slug` to allow bulk deletion of markets by event.
    *   Persists `minAmountThreshold` so dynamic changes survive restarts.

### 5. Frontend Service (`app/`)
*   **Role**: Real-time Visualization Dashboard (React + Vite).
*   **Components**:
    *   **MapController**: WebGL Map (MapLibre) powered by a WebWorker.
    *   **SignalStore**: Visualizes real-time signals on the map.
    *   **GeoMapper**: Client-side geocoding engine to place markets on the world map.

---

## Data Flow

1.  **Market Add**: User adds an event via `!add` or API (`POST /api/events/:slug`).
2.  **Lookup**: Bot fetches Token IDs from Gamma API (one-time) and stores them in SQLite.
3.  **Subscription**: `clobListener` batches the new markets and restarts the WebSocket to subscribe.
4.  **Trade Event**:
    *   Websocket emits `last_trade_price`.
    *   `clobListener` checks `current_threshold` vs trade value.
    *   Pushes to `trade-notification-queue`.
5.  **Notification**:
    *   Worker pops the job.
    *   Worker calculates probabilities.
    *   Worker posts to Discord.

## Scalability Features

*   **Incremental Subscriptions**: Adding/removing markets sends dynamic subscription messages to the CLOB WebSocket without disconnecting or restarting.
*   **In-Memory Thresholds**: Updating event thresholds is instant and requires no database reads or restarts.
*   **Load Leveling**: Redis absorbs spikes in trading activity.

## Key Files

- `src/clob/clobListener.js`: WebSocket handling (Incremental updates supported).
- `src/queue/tradeQueue.js`: Redis Queue definition & Worker logic.
- `src/utils/gammaClient.js`: Centralized Gamma API interaction.
- `src/utils/number.js`: Shared number parsing/formatting logic.
- `src/database/marketRegistry.js`: SQLite storage for markets and settings.
- `src/discord/notifier.js`: Main Discord client entry point.
- `src/discord/commands/*.js`: Individual command logic (`add`, `remove`, `setThreshold`, etc.).
- `src/discord/formatters.js`: Pure functions for creating Discord Embeds.
