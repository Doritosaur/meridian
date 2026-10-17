// Local development uses the Vite same-origin proxy. Hosted builds (e.g. Vercel)
// must set VITE_API_URL to the backend URL.
export const API_BASE_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';
if (import.meta.env.PROD && !API_BASE_URL) {
    console.error('VITE_API_URL is not set: API and websocket requests will go to this origin and fail.');
}
export const SOCKET_URL = API_BASE_URL || '/';

// === MAP COLORS CONFIGURATION ===
export const MAP_COLORS = {
    // Market Dot Colors
    dotColor: 'rgba(168, 85, 247, 0.85)', // Purple dots (matches your surge signal)
    bullish: '#00ff7d',      // Green - price > 50%
    bearish: '#ef4444',      // Red - price <= 50%
    dotStroke: '#ffffff',    // White outline
    dotStrokeHover: '#ffffff',

    // Pin/Selection Colors
    pinColor: '#DC00FF', // Magenta - harmonizes with purple dots

    // Cluster Colors
    clusterFill: 'rgba(41, 48, 61, 0.8)',
    clusterFillActive: 'rgba(0, 255, 125, 0.7)', // Active/filtered cluster
    clusterHover: '#ffffff',
    clusterStroke: '#00ff7d',
    clusterText: '#ffffff',

    // Heatmap Gradient (Cyan Theme)
    heatmap: [
        { stop: 0, color: 'rgba(10, 10, 30, 0)' },        // Transparent
        { stop: 0.02, color: 'rgba(15, 35, 60, 0.2)' },   // Very dark blue-cyan
        { stop: 0.1, color: 'rgba(20, 50, 80, 0.35)' },   // Dark blue-cyan
        { stop: 0.25, color: 'rgba(25, 70, 100, 0.5)' },  // Deep cyan-blue
        { stop: 0.4, color: 'rgba(30, 100, 130, 0.6)' },  // Medium cyan-blue
        { stop: 0.6, color: 'rgba(40, 140, 160, 0.75)' }, // Cyan
        { stop: 0.8, color: 'rgba(50, 180, 190, 0.9)' },  // Bright cyan
        { stop: 1, color: 'rgba(64, 224, 208, 1)' },      // Pure cyan peak
    ],

    // Signal Colors by Type
    signals: {
        whale: '#00ff7d',        // Green
        volume: '#40e0d0',       // Cyan (complements heatmap)
        velocity: '#fb923c',     // Orange
        surge: '#a855f7',        // Purple (matches dots!)
        reversal: '#facc15',     // Yellow
    },

    // Top Market Glow (purple to match dots)
    topMarketGlow: '#a855f7', // Purple glow - makes top markets stand out with same color as dots

    // Signal Pulse (semi-transparent versions)
    signalsPulse: {
        whale: 'rgba(0, 255, 125, 0.3)',
        volume: 'rgba(64, 224, 208, 0.3)',  // Cyan
        velocity: 'rgba(251, 146, 60, 0.3)',
        surge: 'rgba(168, 85, 247, 0.3)',   // Purple - matches dots
        reversal: 'rgba(250, 204, 21, 0.3)',
    },

    // Signal Severity Stroke Colors
    severity: {
        low: '#00ff7d',
        medium: '#eab308',
        high: '#f97316',
        critical: '#ef4444',
    },

    // Signal Labels
    labelText: '#ffffff',
    labelHalo: 'rgba(0,0,0,0.8)',

    // Signal Heatmap (green to red for alerts)
    signalHeatmap: [
        { stop: 0, color: 'rgba(0, 255, 125, 0)' },
        { stop: 0.2, color: 'rgba(0, 255, 125, 0.2)' },
        { stop: 0.4, color: 'rgba(250, 204, 21, 0.4)' },
        { stop: 0.6, color: 'rgba(251, 146, 60, 0.6)' },
        { stop: 0.8, color: 'rgba(239, 68, 68, 0.8)' },
        { stop: 1, color: 'rgba(220, 38, 38, 1)' },
    ],
};

export function buildHeatmapColorExpression(): unknown[] {
    const expr: unknown[] = ['interpolate', ['linear'], ['heatmap-density']];
    MAP_COLORS.heatmap.forEach(({ stop, color }) => {
        expr.push(stop, color);
    });
    return expr;
}

export function buildSignalHeatmapExpression(): unknown[] {
    const expr: unknown[] = ['interpolate', ['linear'], ['heatmap-density']];
    MAP_COLORS.signalHeatmap.forEach(({ stop, color }) => {
        expr.push(stop, color);
    });
    return expr;
}

export const TOOLTIP_THEME = {
    background: 'rgba(23, 23, 23, 0.95)',
    textMain: '#00ff7d',
    textDim: '#A3A3A3',
    textAlert: '#C5003C',
    pinColor: '#DC00FF',
};

// === UI CONFIGURATION ===
export const UI_CONFIG = {
    animation: {
        duration: 300,
        easing: 'ease-in-out',
    },
    virtualList: {
        rowHeight: 80,
        expandedRowHeight: 280,
        overscan: 5,
    },
    tooltips: {
        showDelay: 200,
        hideDelay: 0,
    },
    map: {
        defaultCenter: [0, 20] as [number, number],
        defaultZoom: 1.5,
        minZoom: 1.5,
        maxZoom: 19,
    },
};
