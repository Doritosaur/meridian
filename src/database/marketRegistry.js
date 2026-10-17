import pg from 'pg';
const { Pool } = pg;
import { config } from '../config.js';
import crypto from 'crypto';

class MarketRegistry {
    constructor() {
        const poolConfig = config.db.connectionString
            ? { connectionString: config.db.connectionString, ssl: config.db.ssl }
            : {
                host: config.db.host,
                port: config.db.port,
                user: config.db.user,
                password: config.db.password,
                database: config.db.database
            };

        this.pool = new Pool(poolConfig);

        // Error handling for idle clients
        this.pool.on('error', (err, client) => {
            console.error('Unexpected error on idle client', err);
            process.exit(-1);
        });

        this.marketsCache = null;
    }

    async initialize() {
        if (!config.db.connectionString && !config.db.host) {
            throw new Error('No database configured: set DATABASE_URL (or POSTGRES_HOST for a local Postgres).');
        }
        await this.waitForDatabase();
        await this.initializeSchema();
    }

    async waitForDatabase(retries = 10, delay = 2000) {
        for (let i = 0; i < retries; i++) {
            try {
                const client = await this.pool.connect();
                client.release();
                console.log('[Registry] Database connected successfully.');
                return;
            } catch (err) {
                console.log(`[Registry] Waiting for database... (${i + 1}/${retries}) - ${err.message}`);
                await new Promise(res => setTimeout(res, delay));
            }
        }
        throw new Error('Could not connect to database after multiple retries.');
    }

    async initializeSchema() {
        const client = await this.pool.connect();
        const schemaLockName = 'polymarket-bot-schema-v2';
        let schemaLockAcquired = false;
        let transactionStarted = false;

        try {
            // Gateway and ingestion start concurrently in the single-container
            // deployment. Serialize DDL to avoid PostgreSQL catalog races while
            // CREATE TABLE IF NOT EXISTS is running in both processes.
            await client.query('SELECT pg_advisory_lock(hashtext($1))', [schemaLockName]);
            schemaLockAcquired = true;

            await client.query('BEGIN');
            transactionStarted = true;

            // 1. MARKETS
            await client.query(`
                CREATE TABLE IF NOT EXISTS markets (
                    id SERIAL PRIMARY KEY,
                    condition_id VARCHAR(255) NOT NULL UNIQUE,
                    slug TEXT,
                    event_slug TEXT,
                    description TEXT,
                    threshold NUMERIC(10, 2),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    active BOOLEAN DEFAULT TRUE,
                    watched BOOLEAN DEFAULT FALSE,
                    end_date TEXT,
                    image TEXT,
                    group_date TEXT,
                    tags TEXT[],
                    volume NUMERIC(18, 4) DEFAULT 0,
                    liquidity NUMERIC(18, 4) DEFAULT 0
                );
            `);

            // 2. MARKET_TOKENS (Normalized)
            await client.query(`
                CREATE TABLE IF NOT EXISTS market_tokens (
                    id SERIAL PRIMARY KEY,
                    condition_id VARCHAR(255) REFERENCES markets(condition_id) ON DELETE CASCADE,
                    token_id VARCHAR(255) NOT NULL UNIQUE,
                    outcome VARCHAR(50),
                    price NUMERIC(10, 6),
                    liquidity NUMERIC(18, 4),
                    active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 3. SETTINGS (Scoped)
            await client.query(`
                CREATE TABLE IF NOT EXISTS settings (
                    id SERIAL PRIMARY KEY,
                    scope VARCHAR(50) DEFAULT 'global', -- global, guild, user
                    scope_id VARCHAR(255), -- NULL for global, guild_id, or user_id
                    key VARCHAR(255) NOT NULL,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(scope, scope_id, key)
                );
            `);

            // 4. SUBSCRIPTIONS (Strengthened Targeting)
            await client.query(`
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id SERIAL PRIMARY KEY,
                    guild_id VARCHAR(255) NOT NULL,
                    channel_id VARCHAR(255) NOT NULL,
                    target_type VARCHAR(50) NOT NULL, -- 'market' or 'event'
                    target_id VARCHAR(255) NOT NULL, -- condition_id or event_slug
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(guild_id, channel_id, target_type, target_id)
                );
            `);

            // 5. USERS (Enhanced Security)
            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role VARCHAR(50) DEFAULT 'user', -- admin, user
                    disabled BOOLEAN DEFAULT FALSE,
                    last_login TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 6. USER_PINS (References Users & Markets)
            await client.query(`
                CREATE TABLE IF NOT EXISTS user_pins (
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    condition_id VARCHAR(255) REFERENCES markets(condition_id) ON DELETE CASCADE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, condition_id)
                );
            `);

            // 7. SYSTEM_EVENTS (Observability)
            await client.query(`
                CREATE TABLE IF NOT EXISTS system_events (
                    id SERIAL PRIMARY KEY,
                    type VARCHAR(50) NOT NULL, -- alert_sent, whale_detected, error
                    reference_id VARCHAR(255), -- condition_id or token_id
                    payload JSONB,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 8. TAGS (Dynamic tag→location mapping)
            await client.query(`
                CREATE TABLE IF NOT EXISTS tags (
                    id SERIAL PRIMARY KEY,
                    slug VARCHAR(255) UNIQUE NOT NULL,
                    label VARCHAR(255),
                    lat REAL,
                    lng REAL,
                    auto_inferred BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 9. SIGNALS (Signal history persistence)
            await client.query(`
                CREATE TABLE IF NOT EXISTS signals (
                    id SERIAL PRIMARY KEY,
                    signal_id VARCHAR(100) UNIQUE NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    condition_id VARCHAR(255),
                    region VARCHAR(100),
                    lat REAL,
                    lng REAL,
                    value NUMERIC(18, 4),
                    metadata JSONB,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 10. USER_SIGNAL_CONFIG (User-configurable signal thresholds)
            await client.query(`
                CREATE TABLE IF NOT EXISTS user_signal_config (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    signal_type VARCHAR(50) NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    threshold NUMERIC(18, 4),
                    min_severity VARCHAR(20) DEFAULT 'low',
                    regions TEXT[],
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, signal_type)
                );
            `);

            // Indices
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);
                CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);
                CREATE INDEX IF NOT EXISTS idx_markets_event_slug ON markets(event_slug);
                CREATE INDEX IF NOT EXISTS idx_markets_created_at ON markets(created_at);
                CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
                CREATE INDEX IF NOT EXISTS idx_markets_watched ON markets(watched);
                CREATE INDEX IF NOT EXISTS idx_markets_tags_gin ON markets USING GIN (tags);
                CREATE INDEX IF NOT EXISTS idx_market_tokens_token_id ON market_tokens(token_id);
                CREATE INDEX IF NOT EXISTS idx_market_tokens_condition_id ON market_tokens(condition_id);
                CREATE INDEX IF NOT EXISTS idx_subscriptions_composite ON subscriptions(guild_id, channel_id);
                CREATE INDEX IF NOT EXISTS idx_subscriptions_target ON subscriptions(target_type, target_id);
                CREATE INDEX IF NOT EXISTS idx_user_pins_user_id ON user_pins(user_id);
                CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
                CREATE INDEX IF NOT EXISTS idx_system_events_payload ON system_events USING GIN (payload);
                CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
                CREATE INDEX IF NOT EXISTS idx_signals_region ON signals(region);
                CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
                CREATE INDEX IF NOT EXISTS idx_signals_metadata ON signals USING GIN (metadata);
                CREATE INDEX IF NOT EXISTS idx_user_signal_config_user ON user_signal_config(user_id);
            `);

            await client.query('COMMIT');
            transactionStarted = false;
            console.log('Database schema initialized (Refactored v2)');
        } catch (e) {
            if (transactionStarted) {
                await client.query('ROLLBACK');
            }
            throw e;
        } finally {
            if (schemaLockAcquired) {
                await client.query('SELECT pg_advisory_unlock(hashtext($1))', [schemaLockName]);
            }
            client.release();
        }
    }

    // --- Subscriptions ---

    async subscribe(guildId, channelId, targetType, targetId) {
        // targetId is condition_id (market) or event_slug (event)
        const query = `
            INSERT INTO subscriptions (guild_id, channel_id, target_type, target_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (guild_id, channel_id, target_type, target_id) DO NOTHING
        `;
        const res = await this.pool.query(query, [guildId, channelId, targetType, targetId]);
        return (res.rowCount || 0) > 0;
    }

    async unsubscribe(guildId, channelId, targetType, targetId) {
        const query = `
            DELETE FROM subscriptions 
            WHERE guild_id = $1 AND channel_id = $2 AND target_type = $3 AND target_id = $4
        `;
        const res = await this.pool.query(query, [guildId, channelId, targetType, targetId]);
        return (res.rowCount || 0) > 0;
    }

    async getSubscribers(targetId) {
        const query = `
            SELECT DISTINCT channel_id, guild_id FROM subscriptions
            WHERE target_id = $1
        `;
        const res = await this.pool.query(query, [targetId]);
        return res.rows;
    }

    async hasSubscribers(targetId) {
        const query = `
            SELECT 1 FROM subscriptions WHERE target_id = $1 LIMIT 1
        `;
        const res = await this.pool.query(query, [targetId]);
        return res.rows.length > 0;
    }

    // --- Settings (Scoped) ---

    async getSetting(key, scope = 'global', scopeId = null) {
        // Fallback Strategy: Check Specific Scope -> Check Global
        // For simplicity, let's just query exactly what is asked.
        const query = `
            SELECT value FROM settings 
            WHERE key = $1 AND scope = $2 AND scope_id IS NOT DISTINCT FROM $3
        `;
        // IS NOT DISTINCT FROM allows comparing NULLs correctly
        const res = await this.pool.query(query, [key, scope, scopeId]);

        if (res.rows.length > 0) return res.rows[0].value;

        // If not found in scope, try global (if we weren't already looking for global)
        if (scope !== 'global') {
            const globalRes = await this.pool.query(`
                SELECT value FROM settings WHERE key = $1 AND scope = 'global'
            `, [key]);
            if (globalRes.rows.length > 0) return globalRes.rows[0].value;
        }

        return null;
    }

    async setSetting(key, value, scope = 'global', scopeId = null) {
        const query = `
            INSERT INTO settings (key, value, scope, scope_id, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT(scope, scope_id, key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = EXCLUDED.updated_at
        `;
        await this.pool.query(query, [key, String(value), scope, scopeId]);
    }

    // --- Data Ingestion (Refactored for Market Tokens) ---

    async addMarket(conditionId, slug = null, description = null, clobTokenIds = null, eventSlug = null, threshold = null, endDate = null, image = null, groupDate = null) {
        // Wrapper for upsert to keep API somewhat compatible or similar logic
        const marketObj = {
            conditionId, slug, description, clobTokenIds, eventSlug, threshold, endDate, image, groupDate
        };
        // marketCache will be invalidated in upsertMarkets
        const res = await this.upsertMarkets([marketObj]);
        if (res.length > 0) {
            return await this.getMarket(conditionId);
        }
        return null;
    }

    async upsertMarkets(markets, options = { fullSync: false, setWatched: true }) {
        const globalDefaultThreshold = await this.getSetting('minAmountThreshold');
        const defaultThreshold = globalDefaultThreshold ? parseFloat(globalDefaultThreshold) : null;

        const client = await this.pool.connect();
        this.marketsCache = null; // Invalidate cache

        try {
            await client.query('BEGIN');

            if (options.fullSync) {
                await client.query('UPDATE markets SET active = FALSE WHERE active = TRUE');
            }

            const marketsBatch = [];
            const tokensBatch = [];
            const activeConditionIds = [];

            for (const market of markets) {
                let { threshold } = market;
                if (threshold === null || threshold === undefined) {
                    threshold = defaultThreshold;
                }
                const normalizedConditionId = this.normalizeConditionId(market.conditionId);
                const tags = Array.isArray(market.tags) ? market.tags : null;

                marketsBatch.push({
                    condition_id: normalizedConditionId,
                    slug: market.slug,
                    description: market.description,
                    event_slug: market.eventSlug,
                    threshold: threshold,
                    end_date: market.endDate,
                    image: market.image,
                    group_date: market.groupDate,
                    tags: tags,
                    volume: market.volume || 0,
                    liquidity: market.liquidity || 0,
                    watched_val: options.setWatched ? true : false // Default for access in query
                });

                activeConditionIds.push(normalizedConditionId);

                // Handle Tokens & Prices
                if (market.clobTokenIds) {
                    let tokens = [];
                    let prices = [];
                    try {
                        tokens = typeof market.clobTokenIds === 'string'
                            ? JSON.parse(market.clobTokenIds)
                            : market.clobTokenIds;

                        prices = typeof market.outcomePrices === 'string'
                            ? JSON.parse(market.outcomePrices)
                            : (market.outcomePrices || []);
                    } catch (e) {
                        console.warn(`Failed to parse clobTokenIds/prices for ${normalizedConditionId}`, e);
                    }

                    if (Array.isArray(tokens) && tokens.length >= 2) {
                        const yesId = tokens[0]?.toString();
                        const noId = tokens[1]?.toString(); // Fixed: was tokens[0] in legacy code sometimes? No used 1.

                        // Parse prices safely (ensure float)
                        const yesPrice = prices[0] ? parseFloat(prices[0]) : null;
                        const noPrice = prices[1] ? parseFloat(prices[1]) : null;

                        if (yesId) tokensBatch.push({ condition_id: normalizedConditionId, token_id: yesId, outcome: 'YES', price: yesPrice });
                        if (noId) tokensBatch.push({ condition_id: normalizedConditionId, token_id: noId, outcome: 'NO', price: noPrice });
                    }
                }
            }

            // 1. Batch Insert Markets
            if (marketsBatch.length > 0) {
                await client.query(`
                    INSERT INTO markets (condition_id, slug, description, event_slug, threshold, end_date, image, group_date, tags, volume, liquidity, active, watched, updated_at)
                    SELECT 
                        condition_id, slug, description, event_slug, threshold, end_date, image, group_date, tags, volume, liquidity, 
                        TRUE as active, 
                        watched_val as watched, 
                        CURRENT_TIMESTAMP
                    FROM jsonb_to_recordset($1::jsonb) AS x(
                        condition_id text, slug text, description text, event_slug text, threshold real, 
                        end_date text, image text, group_date text, tags text[], volume real, liquidity real, watched_val boolean
                    )
                    ON CONFLICT(condition_id) DO UPDATE SET
                        slug = COALESCE(EXCLUDED.slug, markets.slug),
                        description = COALESCE(EXCLUDED.description, markets.description),
                        event_slug = COALESCE(EXCLUDED.event_slug, markets.event_slug),
                        threshold = COALESCE(EXCLUDED.threshold, markets.threshold),
                        end_date = COALESCE(EXCLUDED.end_date, markets.end_date),
                        image = COALESCE(EXCLUDED.image, markets.image),
                        group_date = COALESCE(EXCLUDED.group_date, markets.group_date),
                        tags = COALESCE(EXCLUDED.tags, markets.tags),
                        volume = EXCLUDED.volume,
                        liquidity = EXCLUDED.liquidity,
                        active = TRUE,
                        watched = CASE WHEN $2 = true THEN EXCLUDED.watched ELSE markets.watched END,
                        updated_at = CURRENT_TIMESTAMP
                `, [JSON.stringify(marketsBatch), options.setWatched]);
            }

            // 2. Batch Insert Tokens
            if (tokensBatch.length > 0) {
                await client.query(`
                    INSERT INTO market_tokens (condition_id, token_id, outcome, price, active)
                    SELECT condition_id, token_id, outcome, price, TRUE
                    FROM jsonb_to_recordset($1::jsonb) AS x(
                        condition_id text, token_id text, outcome text, price real
                    )
                    ON CONFLICT (token_id) DO UPDATE SET
                        active = TRUE,
                        price = COALESCE(EXCLUDED.price, market_tokens.price),
                        condition_id = EXCLUDED.condition_id
                `, [JSON.stringify(tokensBatch)]);
            }

            await client.query('COMMIT');
            return activeConditionIds;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    normalizeConditionId(conditionId) {
        if (typeof conditionId === 'string') {
            if (conditionId.startsWith('0x')) {
                return conditionId.toLowerCase();
            }
            return '0x' + conditionId.toLowerCase();
        }
        return conditionId;
    }

    async removeMarket(conditionId) {
        const normalizedConditionId = this.normalizeConditionId(conditionId);
        this.marketsCache = null; // Invalidate cache
        await this.pool.query('BEGIN');
        try {
            const res = await this.pool.query(`
                UPDATE markets 
                SET active = FALSE, watched = FALSE, updated_at = CURRENT_TIMESTAMP
                WHERE condition_id = $1
            `, [normalizedConditionId]);

            // Also deactivate tokens?
            await this.pool.query(`
                UPDATE market_tokens SET active = FALSE WHERE condition_id = $1
            `, [normalizedConditionId]);

            await this.pool.query('COMMIT');

            if (res.rowCount === 0) throw new Error(`Market ${conditionId} not found`);
            return true;
        } catch (e) {
            await this.pool.query('ROLLBACK');
            throw e;
        }
    }

    async setMarketWatched(conditionId, watched) {
        this.marketsCache = null; // Invalidate cache
        const normalizedConditionId = this.normalizeConditionId(conditionId);
        const val = watched ? true : false;
        const res = await this.pool.query(`
            UPDATE markets SET watched = $1, updated_at = CURRENT_TIMESTAMP WHERE condition_id = $2
        `, [val, normalizedConditionId]);
        if (res.rowCount === 0) throw new Error(`Market ${conditionId} not found`);
        return true;
    }

    async setMarketThreshold(conditionId, amount) {
        this.marketsCache = null; // Invalidate cache
        const normalizedConditionId = this.normalizeConditionId(conditionId);
        const res = await this.pool.query(`
            UPDATE markets SET threshold = $1, updated_at = CURRENT_TIMESTAMP WHERE condition_id = $2
        `, [amount, normalizedConditionId]);
        if (res.rowCount === 0) throw new Error(`Market ${conditionId} not found`);
        return true;
    }

    async setEventThreshold(eventSlug, amount) {
        this.marketsCache = null; // Invalidate cache
        const res = await this.pool.query(`
            UPDATE markets SET threshold = $1, updated_at = CURRENT_TIMESTAMP WHERE event_slug = $2 AND active = TRUE
        `, [amount, eventSlug]);
        return res.rowCount;
    }

    async deactivateStaleMarkets(activeConditionIds) {
        if (!activeConditionIds || activeConditionIds.length === 0) return 0;

        this.marketsCache = null; // Invalidate cache
        const normalizedIds = activeConditionIds.map(id => this.normalizeConditionId(id));

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            console.log(`[Registry] Deactivating stale markets (Active count: ${normalizedIds.length})...`);

            // 1. Find markets to deactivate (for logging/events) - Optional but good for debugging
            // skipping for performance, just update.

            // 2. Update markets
            // WHERE active = 1 AND condition_id NOT IN (...)
            const res = await client.query(`
                UPDATE markets 
                SET active = FALSE, watched = FALSE, updated_at = CURRENT_TIMESTAMP
                WHERE active = TRUE AND condition_id != ALL($1)
            `, [normalizedIds]);

            // 3. Deactivate tokens
            if (res.rowCount > 0) {
                await client.query(`
                    UPDATE market_tokens 
                    SET active = FALSE 
                    WHERE condition_id IN (
                        SELECT condition_id FROM markets WHERE active = FALSE AND updated_at = CURRENT_TIMESTAMP
                    )
                `);
            }

            await client.query('COMMIT');
            console.log(`[Registry] Deactivated ${res.rowCount} stale markets.`);
            return res.rowCount;
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('[Registry] Failed to deactivate stale markets:', e);
            throw e;
        } finally {
            client.release();
        }
    }

    async pruneWatchedMarkets(keepConditionIds) {
        if (!keepConditionIds) return 0;
        const normalizedIds = keepConditionIds.map(id => this.normalizeConditionId(id));

        const client = await this.pool.connect();
        try {
            // Set watched=0 for markets that are:
            // 1. Currently watched=1
            // 2. NOT in the new 'keep' list (Top X)
            // 3. NOT pinned by any user (safeguard)
            const res = await client.query(`
                UPDATE markets 
                SET watched = 0, updated_at = CURRENT_TIMESTAMP
                WHERE watched = 1 
                AND condition_id != ALL($1)
                AND condition_id NOT IN (SELECT DISTINCT condition_id FROM user_pins)
                AND slug NOT IN (SELECT target_id FROM subscriptions WHERE target_type = 'market')
                RETURNING condition_id
            `, [normalizedIds]);

            if (res.rowCount > 0) {
                console.log(`[Registry] Pruned ${res.rowCount} markets from watch list.`);
            }
            return res.rows.map(r => r.condition_id);
        } catch (e) {
            console.error('[Registry] Failed to prune watched markets:', e);
            return [];
        } finally {
            client.release();
        }
    }

    // --- Search & Retrieval ---

    async findMarketBySlugPartial(partialSlug) {
        const res = await this.pool.query(`
            SELECT * FROM markets WHERE slug LIKE $1 AND active = 1 LIMIT 1
        `, [`%${partialSlug}%`]);
        return res.rows[0];
    }

    async getWatchedMarkets() {
        if (this.marketsCache) {
            return this.marketsCache;
        }

        // Need to recreate the "clob_token_ids" string or array for compatibility if needed
        // Or updated callers to use market_tokens.
        // For now, let's aggregate tokens back into an array to keep compatibility with existing consumers
        // doing JSON.parse(clob_token_ids).
        const res = await this.pool.query(`
            SELECT m.*, 
                   COALESCE(json_agg(t.token_id ORDER BY t.outcome DESC) FILTER (WHERE t.token_id IS NOT NULL), '[]') as clob_token_ids_json,
                   MAX(CASE WHEN t.outcome = 'YES' THEN t.price END) as yes_price,
                   MAX(CASE WHEN t.outcome = 'NO' THEN t.price END) as no_price,
                   MAX(CASE WHEN t.outcome = 'YES' THEN t.token_id END) as yes_asset_id,
                   MAX(CASE WHEN t.outcome = 'NO' THEN t.token_id END) as no_asset_id
            FROM markets m
            LEFT JOIN market_tokens t ON m.condition_id = t.condition_id
            WHERE m.watched = 1 AND m.active = 1
            GROUP BY m.id
            ORDER BY m.created_at DESC
        `);

        // Map back to expected format AND PRE-PARSE JSON
        this.marketsCache = res.rows.map(row => ({
            ...row,
            clob_token_ids: JSON.stringify(row.clob_token_ids_json), // Keep for legacy if needed, or remove if unused
            parsed_clob_token_ids: row.clob_token_ids_json // Ready-to-use array
        }));

        return this.marketsCache;
    }

    async getActiveMarkets() {
        // For frontend: Return ALL active markets (not just watched)
        const res = await this.pool.query(`
            SELECT m.*, 
                   json_agg(t.token_id ORDER BY t.outcome DESC) as clob_token_ids_json,
                   MAX(CASE WHEN t.outcome = 'YES' THEN t.price END) as yes_price,
                   MAX(CASE WHEN t.outcome = 'NO' THEN t.price END) as no_price,
                   MAX(CASE WHEN t.outcome = 'YES' THEN t.token_id END) as yes_asset_id,
                   MAX(CASE WHEN t.outcome = 'NO' THEN t.token_id END) as no_asset_id
            FROM markets m
            LEFT JOIN market_tokens t ON m.condition_id = t.condition_id
            WHERE m.active = TRUE
            GROUP BY m.id
            ORDER BY m.created_at DESC
        `);

        return res.rows.map(row => ({
            ...row,
            clob_token_ids: JSON.stringify(row.clob_token_ids_json),
            parsed_clob_token_ids: row.clob_token_ids_json
        }));
    }

    async getMarket(conditionId) {
        const normalizedConditionId = this.normalizeConditionId(conditionId);
        const res = await this.pool.query(`
            SELECT m.*, 
                   json_agg(t.token_id ORDER BY t.outcome DESC) as clob_token_ids_json
            FROM markets m
            LEFT JOIN market_tokens t ON m.condition_id = t.condition_id
            WHERE m.condition_id = $1
            GROUP BY m.id
        `, [normalizedConditionId]);

        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            ...row,
            clob_token_ids: JSON.stringify(row.clob_token_ids_json)
        };
    }

    async getMarketsByConditionIds(conditionIds) {
        if (!conditionIds || conditionIds.length === 0) return [];
        const normalizedIds = conditionIds.map(id => this.normalizeConditionId(id));

        const res = await this.pool.query(`
            SELECT m.*, 
                   json_agg(t.token_id ORDER BY t.outcome DESC) as clob_token_ids_json
            FROM markets m
            LEFT JOIN market_tokens t ON m.condition_id = t.condition_id
            WHERE m.condition_id = ANY($1)
            GROUP BY m.id
        `, [normalizedIds]);

        return res.rows.map(row => ({
            ...row,
            clob_token_ids: JSON.stringify(row.clob_token_ids_json)
        }));
    }

    // --- Users ---

    async registerUser(username, password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        const storedPassword = `${salt}:${hash}`;

        try {
            const res = await this.pool.query(
                `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, username, role`,
                [username, storedPassword]
            );
            return res.rows[0];
        } catch (error) {
            if (error.code === '23505') throw new Error('Username already taken');
            throw error;
        }
    }

    async authenticateUser(username, password) {
        const res = await this.pool.query(`SELECT id, username, password_hash, role, disabled FROM users WHERE username = $1`, [username]);
        if (res.rows.length === 0) return null;

        const user = res.rows[0];
        if (user.disabled) throw new Error('Account disabled');

        const [salt, key] = user.password_hash.split(':');
        const derivedKey = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');

        if (key === derivedKey) {
            // Update last_login
            await this.pool.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`, [user.id]);
            return { id: user.id, username: user.username, role: user.role };
        }
        return null;
    }

    async toggleUserPin(userId, conditionId) {
        const normalized = this.normalizeConditionId(conditionId);

        // First, verify user exists to prevent FK violations from stale auth tokens
        const userCheck = await this.pool.query(`SELECT id FROM users WHERE id = $1`, [userId]);
        if (userCheck.rows.length === 0) {
            throw new Error(`User ID ${userId} not found. Please log out and log in again.`);
        }

        const check = await this.pool.query(
            `SELECT 1 FROM user_pins WHERE user_id = $1 AND condition_id = $2`,
            [userId, normalized]
        );

        if (check.rows.length > 0) {
            await this.pool.query(`DELETE FROM user_pins WHERE user_id = $1 AND condition_id = $2`, [userId, normalized]);
            return false;
        } else {
            await this.pool.query(`INSERT INTO user_pins (user_id, condition_id) VALUES ($1, $2)`, [userId, normalized]);
            return true;
        }
    }

    async getUserPins(userId) {
        const res = await this.pool.query(`SELECT condition_id FROM user_pins WHERE user_id = $1`, [userId]);
        return res.rows.map(r => r.condition_id);
    }

    // --- Observability ---

    async logSystemEvent(type, referenceId, payload) {
        try {
            await this.pool.query(`
                INSERT INTO system_events (type, reference_id, payload) VALUES ($1, $2, $3)
            `, [type, referenceId, JSON.stringify(payload)]);
        } catch (e) {
            console.error('Failed to log system event', e);
        }
    }

    // Legacy support methods if needed...
    async getMarketsByEventSlug(eventSlug) {
        const res = await this.pool.query(`
            SELECT m.*, 
                   json_agg(t.token_id ORDER BY t.outcome DESC) as clob_token_ids_json
            FROM markets m
            LEFT JOIN market_tokens t ON m.condition_id = t.condition_id
            WHERE m.event_slug = $1 AND m.active = 1
            GROUP BY m.id
        `, [eventSlug]);
        return res.rows.map(row => ({
            ...row,
            clob_token_ids: JSON.stringify(row.clob_token_ids_json)
        }));
        return res.rows;
    }
    // --- Tags ---

    async upsertTags(tagSlugs) {
        if (!tagSlugs || tagSlugs.length === 0) return;

        const uniqueSlugs = [...new Set(tagSlugs.filter(Boolean))];

        for (const slug of uniqueSlugs) {
            await this.pool.query(`
                INSERT INTO tags (slug)
                VALUES ($1)
                ON CONFLICT (slug) DO NOTHING
            `, [slug]);
        }
    }

    async getTagLocations() {
        // Deprecated: Coordinate source of truth moved to frontend (GeoMapper.ts)
        return {};
    }

    async close() {
        await this.pool.end();
    }

    // --- Signals ---

    async saveSignal(signal) {
        try {
            await this.pool.query(`
                INSERT INTO signals (signal_id, type, severity, condition_id, region, lat, lng, value, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (signal_id) DO NOTHING
            `, [
                signal.id,
                signal.type,
                signal.severity,
                signal.conditionId,
                signal.region,
                signal.coordinates?.lat,
                signal.coordinates?.lng,
                signal.value,
                JSON.stringify(signal.metadata)
            ]);
        } catch (e) {
            console.error('[Registry] Failed to save signal:', e);
        }
    }

    async getRecentSignals(limit = 100, filters = {}) {
        let query = `
            SELECT * FROM signals 
            WHERE 1=1
        `;
        const params = [];
        let paramIdx = 1;

        if (filters.type) {
            query += ` AND type = $${paramIdx++}`;
            params.push(filters.type);
        }
        if (filters.region) {
            query += ` AND region = $${paramIdx++}`;
            params.push(filters.region);
        }
        if (filters.minSeverity) {
            const severityOrder = ['low', 'medium', 'high', 'critical'];
            const minIdx = severityOrder.indexOf(filters.minSeverity);
            if (minIdx >= 0) {
                const validSeverities = severityOrder.slice(minIdx);
                query += ` AND severity = ANY($${paramIdx++})`;
                params.push(validSeverities);
            }
        }
        if (filters.since) {
            query += ` AND created_at >= $${paramIdx++}`;
            params.push(new Date(filters.since));
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
        params.push(limit);

        const res = await this.pool.query(query, params);
        return res.rows;
    }

    async pruneOldSignals(retentionDays = 7) {
        const res = await this.pool.query(`
            DELETE FROM signals 
            WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
        `);
        if (res.rowCount > 0) {
            console.log(`[Registry] Pruned ${res.rowCount} old signals.`);
        }
        return res.rowCount;
    }

    // --- User Signal Configuration ---

    async getUserSignalConfig(userId) {
        const res = await this.pool.query(`
            SELECT * FROM user_signal_config WHERE user_id = $1
        `, [userId]);

        // Convert to map by signal_type
        const configMap = {};
        for (const row of res.rows) {
            configMap[row.signal_type] = {
                enabled: row.enabled,
                threshold: row.threshold ? parseFloat(row.threshold) : null,
                minSeverity: row.min_severity,
                regions: row.regions
            };
        }
        return configMap;
    }

    async setUserSignalConfig(userId, signalType, config) {
        await this.pool.query(`
            INSERT INTO user_signal_config (user_id, signal_type, enabled, threshold, min_severity, regions, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, signal_type) DO UPDATE SET
                enabled = COALESCE($3, user_signal_config.enabled),
                threshold = COALESCE($4, user_signal_config.threshold),
                min_severity = COALESCE($5, user_signal_config.min_severity),
                regions = COALESCE($6, user_signal_config.regions),
                updated_at = CURRENT_TIMESTAMP
        `, [
            userId,
            signalType,
            config.enabled ?? true,
            config.threshold ?? null,
            config.minSeverity ?? 'low',
            config.regions ?? null
        ]);
    }
}

export const marketRegistry = new MarketRegistry();
