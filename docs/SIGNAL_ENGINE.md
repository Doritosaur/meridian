# Signal Engine Documentation

## 1. Architecture Overview

The Signal Engine is a real-time anomaly detection system that processes every trade from the Polymarket CLOB (Central Limit Order Book) to identify significant market events.

### Data Flow Pipeline
1.  **Ingestion (`clobListener.js`)**: Connects to Polymarket WebSocket. Receives raw trade execution messages.
2.  **Detection (`SignalEngine.js`)**: Analyzes every trade against historical windows and thresholds.
3.  **Emission (`broadcast.js`)**: If a pattern matches, a `signal` event is emitted via WebSocket to all connected clients.
4.  **State Management (`signalStore.ts`)**: Frontend stores receive the signal, add it to a FIFO queue (capped at 100), and aggregate it by region.
5.  **Visualization (`MapController.tsx`)**: Map layers render the signal dynamically using WebGL.

---

## 2. Detection Algorithms (Backend)

The backend engine (`src/signals/SignalEngine.js`) tracks state for every active market.

### A. 🐋 Whale Activity
Detects large capital injections.
- **Logic**: `Trade Volume (USD) > Threshold`
- **Thresholds**:
    - **Medium**: > $1,000 (Configurable)
    - **High**: > $20,000
    - **Critical**: > $50,000

### B. 📈 Volume Anomaly
Detects sudden spikes in trading activity compared to the baseline.
- **Window**: 5-minute rolling window for baseline calculation.
- **Logic**: `Current Volume > (Baseline Average * Multiplier)`
- **Thresholds**:
    - **Medium**: > 2.5x Baseline
    - **High**: > 3.0x Baseline
    - **Critical**: > 5.0x Baseline

### C. 🚀 Price Velocity
Detects rapid price movements within a short timeframe.
- **Window**: 60-second sliding window.
- **Logic**: measures absolute price change per minute.
- **Thresholds**:
    - **Medium**: > 7% / min
    - **High**: > 10% / min
    - **Critical**: > 20% / min

### D. 🌍 Regional Surge
Detects coordinated activity across a geographic zone (e.g., "Middle East").
- **Logic**: `Unique Active Markets in Region (last 60s) >= 3`
- **Purpose**: Identifies broad geopolitical events that affect multiple related markets simultaneously.

### E. ↩️ Market Reversal
Detects trend flips (Bullish to Bearish or vice versa).
- **Logic**: sustained price movement (5+ data points) followed by a sharp directional change.

---

## 3. Visualization Layers (Frontend)

The frontend uses `mapLayers.ts` to render signals on the MapLibre GL canvas.

| Layer Name | Type | Description |
| :--- | :--- | :--- |
| **`signal-heatmap`** | Heatmap | A glowing "fog" that represents the intensity/density of signals in an area. Intensity scales with zoom level. |
| **`signal-pulse`** | Circle | An expanding ring animation that only appears for **New** signals (< 5 seconds old). |
| **`signal-markers`** | Circle | Solid colored dots representing the signal type. |
| **`signal-labels`** | Symbol | Text labels (e.g., "Whale Alert") that appear on hover. |

### Color Coding
- **Whale Activity**: 🟪 Purple (`#d946ef`)
- **Volume Anomaly**: 🟦 Cyan (`#06b6d4`)
- **Price Velocity**: 🟧 Orange (`#f97316`)
- **Regional Surge**: 🟨 Amber (`#fbbf24`)
- **Market Reversal**: 🟥 Red (`#ef4444`)

---

## 4. Configuration

Key thresholds can be adjusted dynamically in `config.js` or via the Admin Panel:

```javascript
// src/config.js defaults
signals: {
    volumeAnomalyThreshold: 2.0,    // Multiplier
    velocityThreshold: 5.0,         // % per minute
    regionalSurgeMinMarkets: 3,     // Min markets to trigger surge
    whaleThreshold: 1000,           // USD amount
    slidingWindowMs: 60000          // 1 minute
}
```
