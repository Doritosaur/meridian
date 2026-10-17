# Map Engine Documentation

## 1. Architecture Overview

The Map Engine is a high-performance visualization system built on **MapLibre GL JS**, designed to render thousands of real-time market data points without UI lag.

### Core Components
1.  **Controller (`MapController.tsx`)**: The React component that manages the MapLibre instance and layer lifecycle.
2.  **Processor (`cluster.worker.ts`)**: A dedicated WebWorker that handles CPU-intensive tasks (clustering, layout calculations) off the main thread.
3.  **Geocoder (`GeoMapper.ts`)**: A heuristic engine that maps text/tags to lat/lng coordinates.
4.  **Styling (`mapLayers.ts`)**: Centralized definition of all visual layers (heatmap, dots, glows).

---

## 2. Data Pipeline (Off-Main-Thread Architecture)

To ensure 60fps performance, heavy lifting is done in a WebWorker.

### Step A: Ingestion
- Real-time market data flows from `marketStore` into the `MapController`.
- The controller batches updates and sends them to the worker via `postMessage`.

### Step B: Processing (Worker)
The `cluster.worker.ts` performs three key operations:
1.  **Geocoding**: Uses `GeoMapper` to assign coordinates to new markets.
2.  **Clustering**: Groups nearby markets into cities/regions using `supercluster`.
3.  **Spiral Layout**: For cities with multiple markets (like NYC), it calculates a "Fernet's Spiral" layout so points don't overlap, creating the beautiful "exploding star" effect when zoomed in.

### Step C: Rendering
- The worker returns `GeoJSON` datasets for:
    - `points` (All markets)
    - `clusters` (Aggregated counts)
    - `topPoints` (The highest volume market per city)
- The Controller updates the MapLibre data sources in a single frame.

---

## 3. The Geocoder (`GeoMapper.ts`)

The GeoMapper determines *where* a market belongs on the map.

### Priority Logic (Waterfall)
1.  **Dynamic Overrides**: Admin-defined specific locations.
2.  **Known Tags (High Specificity)**: Matches explicit tags like "NBA" (NYC) or "Tech" (SF).
3.  **Known Tokens**: Matches words in the title (e.g., "London", "Texas").
4.  **Topic Hubs**: Maps abstract concepts to physical hubs (e.g., "Politics" -> DC, "Crypto" -> NYC).
5.  **Global Fallback**: If no location is found, it deterministically hashes the title to one of 15 "Global Hubs" (Tokyo, London, NYC, etc.) to prevent data loss.

---

## 4. Visualization Layers (`mapLayers.ts`)

The map uses a multi-layered approach to convey depth and density.

| Layer Group | Description | Visual Effect |
| :--- | :--- | :--- |
| **Heatmap** | Represents liquidity density. | Uses a **Logarithmic Scale** (`log10(volume)`) to ensure small and large markets both contribute to a seamless "nebula" glow. |
| **Top Markets** | The "Anchors". | **Purple Dots** that represent the #1 market in each city. They have a "Core" (solid) and "Glow" (fading) layer. |
| **Clusters** | Aggregated regions. | Large circles showing the count of markets in a region (e.g., "150"). Zooming in breaks them apart. |
| **Signals** | Real-time anomalies. | Superimposed layers (Pulse, Markers, Heatmap) from the Signal Engine (see `SIGNAL_ENGINE.md`). |

### Key Configs
- **Heatmap Intensity**: Scales with zoom (1.5 → 0.5).
- **Dot Size**: Scales with market volume (Logarithmic).
- **Colors**: Uses a "Cyan/Purple" Cyberpunk palette defined in `config/index.ts`.

---

## 5. Performance Optimizations

- **Vector Tiles**: Using MapLibre allows GPU-accelerated rendering.
- **Worker Threading**: Prevents UI freezes during data updates.
- **Debounced Updates**: Map updates are throttled to `1000ms` (configurable) to avoid thrashing the GPU.
- **Logarithmic Scaling**: Prevents "Super Whales" from blinding the map; ensures visual balance processing $1M vs $1k markets.
