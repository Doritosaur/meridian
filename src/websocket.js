import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { subscribeToEvents } from './utils/broadcast.js';
import { marketRegistry } from './database/marketRegistry.js';
import { clobListener } from './clob/clobListener.js';
import { config } from './config.js';
import { createLimiter, socketIp } from './utils/rateLimit.js';

const JWT_SECRET = process.env.JWT_SECRET || 'polymarket-bot-secret-change-me';

let io;

const MAX_CONNECTIONS_PER_IP = 10;
const openByIp = new Map();
const connectLimit = createLimiter({ windowMs: 60_000, max: 30 });
const eventLimit = createLimiter({ windowMs: 10_000, max: 40 });
const authEventLimit = createLimiter({ windowMs: 15 * 60_000, max: 20 });

export function initializeWebSockets(server) {
    if (io) return io;

    io = new Server(server, {
        maxHttpBufferSize: 1e5, // 100 KB; default is 1 MB
        cors: {
            // DASHBOARD_ORIGIN restricts this to the hosted dashboard (e.g. the Vercel URL)
            origin: config.dashboardOrigins.includes('*') ? '*' : config.dashboardOrigins,
            methods: ["GET", "POST"],
            // Authentication uses the Socket.IO handshake token, not cookies.
            // Keeping credentials disabled permits the separately hosted dashboard origin.
            credentials: false
        }
    });

    // Optional JWT authentication: no token connects as a guest (socket.user = null),
    // a bad token is rejected so the client can drop it and reconnect as a guest.
    // Cap new connections per IP and concurrent connections per IP
    io.use((socket, next) => {
        const ip = socketIp(socket, config.trustProxy);
        socket.clientIp = ip;
        if (!connectLimit(ip).allowed) {
            return next(new Error('Too many connections'));
        }
        if ((openByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
            return next(new Error('Too many connections'));
        }
        next();
    });

    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            socket.user = null;
            return next();
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.user = decoded; // Attach user info to socket
            next();
        } catch (err) {
            console.log(`[WebSocket] Rejected connection: Invalid token`);
            return next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`[WebSocket] Client connected: ${socket.id} (User: ${socket.user?.username || 'guest'})`);

        openByIp.set(socket.clientIp, (openByIp.get(socket.clientIp) || 0) + 1);

        // Per-socket throttle on every client event; auth events get a much tighter budget
        socket.use(([event], next) => {
            const key = `${socket.clientIp}`;
            const isAuth = event === 'login' || event === 'register';
            const result = isAuth ? authEventLimit(key) : eventLimit(socket.id);
            if (!result.allowed) {
                return next(new Error('Rate limit exceeded'));
            }
            next();
        });

        socket.on('error', () => { /* rate-limit / middleware errors; nothing to do */ });

        socket.emit('status', { message: 'Connected to Meridian' });

        // Handle initial Snapshot Request
        socket.on('get_market_snapshot', async () => {
            // console.log(`[WebSocket] Sending snapshot to ${socket.id}`); // Verbose
            try {
                // 1. Get static info from DB - ALL active markets (not just watched)
                const markets = await marketRegistry.getActiveMarkets();

                // 2. Get live prices from ClobListener cache
                // We need to map conditionId -> cached prices
                // ClobListener.subscribedAssets map values have { conditionId, outcome, lastPrice, ... }
                const liveAssets = clobListener.getAssets();

                // Build a map of conditionId -> object with yesPrice/noPrice
                const conditionPriceMap = new Map();

                liveAssets.forEach(asset => {
                    if (!conditionPriceMap.has(asset.conditionId)) {
                        conditionPriceMap.set(asset.conditionId, { YES: 0.5, NO: 0.5 });
                    }
                    if (asset.lastPrice) {
                        conditionPriceMap.get(asset.conditionId)[asset.outcome] = asset.lastPrice;
                    }
                });


                // Enhance markets with asset IDs and Prices
                // Optimization: 'markets' are now cached objects from Registry with 'parsed_clob_token_ids'
                const enhancedMarkets = markets.map(m => {
                    // Prices: Try DB first, then live cache, then 0.5 default
                    const cachedPrices = conditionPriceMap.get(m.condition_id) || {};

                    const yesPrice = m.yes_price || cachedPrices.YES || 0.5;
                    const noPrice = m.no_price || cachedPrices.NO || 0.5;

                    // Asset IDs: 
                    // Use the pre-parsed array from Registry cache (parsed_clob_token_ids)
                    // or fallback to DB columns if populated
                    let yesAssetId = m.yes_asset_id;
                    let noAssetId = m.no_asset_id;

                    // If DB columns are null, use the pre-parsed array (no need to JSON.parse anymore!)
                    if (!yesAssetId && m.parsed_clob_token_ids && m.parsed_clob_token_ids.length >= 2) {
                        yesAssetId = m.parsed_clob_token_ids[0];
                        noAssetId = m.parsed_clob_token_ids[1];
                    }

                    return {
                        ...m,
                        yes_asset_id: yesAssetId,
                        no_asset_id: noAssetId,
                        yes_price: yesPrice,
                        no_price: noPrice
                    };
                });

                socket.emit('market_snapshot', { markets: enhancedMarkets });
            } catch (err) {
                console.error("Error fetching snapshot:", err);
            }
        });

        // Handle Tag Locations Request
        socket.on('get_tag_locations', async () => {
            try {
                const tagLocations = await marketRegistry.getTagLocations();
                socket.emit('tag_locations', tagLocations);
            } catch (err) {
                console.error("Error fetching tag locations:", err);
            }
        });

        socket.on('register', async (data) => {
            const { username, password } = data;
            try {
                const user = await marketRegistry.registerUser(username, password);
                socket.emit('register_response', { success: true, user });
            } catch (err) {
                socket.emit('register_response', { success: false, error: err.message });
            }
        });

        socket.on('login', async (data) => {
            const { username, password } = data;
            try {
                const user = await marketRegistry.authenticateUser(username, password);
                if (user) {
                    socket.emit('login_response', { success: true, user });
                } else {
                    socket.emit('login_response', { success: false, error: 'Invalid credentials' });
                }
            } catch (err) {
                socket.emit('login_response', { success: false, error: err.message });
            }
        });

        // Pins belong to the authenticated user; the id comes from the verified
        // token, never from the client payload.
        socket.on('get_pins', async () => {
            const userId = socket.user?.id;
            if (!userId) return;
            try {
                const pins = await marketRegistry.getUserPins(userId);
                // We also need to fetch the full 'Trade' objects or at least ensure the frontend can map these IDs to markets.
                // For 'PinnedFeed', the frontend relies on `pinnedIds` (Set) and listens to stream.
                // So sending just IDs is enough for it to filter the stream.
                socket.emit('pins_response', { pins });
            } catch (err) {
                console.error("Error fetching pins:", err);
            }
        });

        socket.on('toggle_pin', async (data) => {
            const userId = socket.user?.id;
            const { conditionId } = data || {};
            if (!userId || !conditionId) return;
            try {
                const isPinned = await marketRegistry.toggleUserPin(userId, conditionId);
                socket.emit('pin_toggled', { conditionId, isPinned });
            } catch (err) {
                console.error("Error toggling pin:", err);
            }
        });

        socket.on('command', async (data) => {
            const { command, id } = data;
            console.log(`[WebSocket] Received command: ${command}`);

            try {
                let response;
                switch (command.toLowerCase().trim()) {
                    case 'ping':
                        response = 'pong';
                        break;

                    case 'status':
                        const activeCount = (await marketRegistry.getWatchedMarkets()).length;
                        response = {
                            status: 'running',
                            uptime: process.uptime(),
                            activeMarkets: activeCount,
                            service: 'meridian'
                        };
                        break;

                    case 'markets':
                        const markets = await marketRegistry.getWatchedMarkets();
                        response = {
                            count: markets.length,
                            markets: markets.map(m => ({
                                conditionId: m.condition_id,
                                slug: m.slug,
                                question: m.question
                            }))
                        };
                        break;

                    default:
                        response = `Unknown command: ${command}`;
                }

                socket.emit('command_response', { id, command, response });

            } catch (error) {
                console.error(`Error processing command ${command}:`, error);
                socket.emit('command_response', { id, command, error: error.message });
            }
        });

        socket.on('disconnect', () => {
            const open = (openByIp.get(socket.clientIp) || 1) - 1;
            if (open <= 0) openByIp.delete(socket.clientIp);
            else openByIp.set(socket.clientIp, open);
            console.log(`[WebSocket] Client disconnected: ${socket.id}`);
        });
    });

    // Subscribe to Redis events and forward them to all connected clients
    subscribeToEvents((type, payload) => {
        // Emit broadly with the type as the event name, or generic 'event'
        // console.log(`[WebSocket] Forwarding event: ${type}`); // Verbose
        io.emit('event', { type, payload, timestamp: Date.now() });

        // Also emit specific events for easier handling
        io.emit(type, payload);
    });

    console.log('[WebSocket] Initialized');
    return io;
}
