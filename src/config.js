import dotenv from 'dotenv';

dotenv.config();

function createRedisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (process.env.NODE_ENV === 'production' && !process.env.REDIS_HOST) {
      throw new Error('REDIS_URL (or REDIS_HOST) is not set');
    }
    return {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    };
  }

  let url;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL is not a valid URL (expected redis:// or rediss://)');
  }
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379'),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {})
  };
}

const redisConnection = createRedisConnection();

// Resolves the Postgres connection string and TLS settings.
// TLS mode comes from `sslmode` in DATABASE_URL or DATABASE_SSL
// ('disable' | 'require'). Set DATABASE_SSL_CA (PEM) to verify the server cert.
function createDbConnection() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { connectionString: '', ssl: false };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string');
  }

  const mode = (url.searchParams.get('sslmode') || process.env.DATABASE_SSL || '').toLowerCase();
  // pg interprets sslmode itself; strip it so the settings below are authoritative
  url.searchParams.delete('sslmode');

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let ssl;
  if (mode === 'disable' || (isLocal && !mode)) {
    ssl = false;
  } else if (process.env.DATABASE_SSL_CA) {
    ssl = { ca: process.env.DATABASE_SSL_CA, rejectUnauthorized: true };
  } else {
    ssl = { rejectUnauthorized: false };
  }

  return { connectionString: url.toString(), ssl };
}

const dbConnection = createDbConnection();

export const config = {
  port: process.env.PORT || 3000,
  minAmountThreshold: parseFloat(process.env.MIN_AMOUNT_THRESHOLD || '1000'),
  discordToken: process.env.DISCORD_TOKEN || '',
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  discordEnabled: Boolean(process.env.DISCORD_TOKEN),
  clobWsUrl: process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  redisHost: redisConnection.host,
  redisPort: redisConnection.port,
  redisConnection,
  adminApiKey: process.env.ADMIN_API_KEY || 'changeme',
  // Set TRUST_PROXY=1 when behind Cloudflare/nginx so rate limits key on the real client IP
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  // Comma-separated dashboard origins allowed by CORS; '*' when unset
  dashboardOrigins: (process.env.DASHBOARD_ORIGIN || '*').split(',').map(o => o.trim()).filter(Boolean),

  // Customization
  colors: {
    buy: 0x2ECC71,  // Green
    sell: 0xE74C3C, // Red
    event: 0x0099FF // Blue
  },
  db: {
    connectionString: dbConnection.connectionString,
    ssl: dbConnection.ssl,
    // Individual settings are only for a local Postgres; DATABASE_URL takes precedence
    host: process.env.POSTGRES_HOST || '',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'admin',
    password: process.env.POSTGRES_PASSWORD || 'adminpassword',
    database: process.env.POSTGRES_DB || 'polymarket'
  },
  polymarket: {
    appUrl: 'https://polymarket.com',
    gammaApiUrl: 'https://gamma-api.polymarket.com'
  },

  // Signal Engine Configuration
  signals: {
    volumeAnomalyThreshold: parseFloat(process.env.SIGNAL_VOLUME_THRESHOLD || '2.0'),
    velocityThreshold: parseFloat(process.env.SIGNAL_VELOCITY_THRESHOLD || '5.0'),
    regionalSurgeMinMarkets: parseInt(process.env.SIGNAL_SURGE_MIN_MARKETS || '3'),
    whaleThreshold: parseFloat(process.env.SIGNAL_WHALE_THRESHOLD || process.env.MIN_AMOUNT_THRESHOLD || '1000'),
    slidingWindowMs: parseInt(process.env.SIGNAL_SLIDING_WINDOW_MS || '60000'),
    volumeWindowMs: parseInt(process.env.SIGNAL_VOLUME_WINDOW_MS || '300000')
  }
};
