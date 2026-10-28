import express from 'express';
import jwt from 'jsonwebtoken';
import { marketRegistry } from './database/marketRegistry.js';
import { config } from './config.js';
import { getEvent, getMarket } from './utils/gammaClient.js';
import { publishEvent, EventType } from './utils/broadcast.js';
import { expressRateLimit } from './utils/rateLimit.js';

const JWT_SECRET = process.env.JWT_SECRET || 'polymarket-bot-secret-change-me';
const JWT_EXPIRES_IN = '7d';

export function createServer() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '10kb' }));

  const globalLimit = expressRateLimit({ windowMs: 60_000, max: 120 });
  const authLimit = expressRateLimit({ windowMs: 15 * 60_000, max: 20 });
  const registerLimit = expressRateLimit({ windowMs: 60 * 60_000, max: 5 });
  const adminLimit = expressRateLimit({ windowMs: 60_000, max: 30 });

  app.use('/api', globalLimit);

  // Enable CORS for dashboard
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (config.dashboardOrigins.includes('*')) {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin && config.dashboardOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });


  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });



  // ============ AUTH ENDPOINTS ============
  app.post('/api/auth/login', authLimit, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password required' });
      }

      const user = await marketRegistry.authenticateUser(username, password);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      res.json({ success: true, user: { id: user.id, username: user.username }, token });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/auth/register', registerLimit, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password required' });
      }

      const user = await marketRegistry.registerUser(username, password);
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      res.json({ success: true, user: { id: user.id, username: user.username }, token });
    } catch (error) {
      if (error.message.includes('already exists')) {
        return res.status(409).json({ success: false, error: 'Username already exists' });
      }
      console.error('Register error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ============ ADMIN MIDDLEWARE ============
  // Middleware for API Key Authentication
  const requireAuth = (req, res, next) => {
    adminLimit(req, res, () => checkApiKey(req, res, next));
  };

  const checkApiKey = (req, res, next) => {
    const apiKey = req.get('x-api-key');
    if (!apiKey || apiKey !== config.adminApiKey) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key' });
    }
    next();
  };

  app.delete('/api/events/:slug', requireAuth, async (req, res) => {
    try {
      const { slug } = req.params;

      const markets = await marketRegistry.getMarketsByEventSlug(slug);

      if (markets.length === 0) {
        return res.status(404).json({
          success: false,
          error: `No active markets found for event: ${slug} (or event not tracked)`
        });
      }
      let removedCount = 0;
      const removedConditionIds = [];

      for (const market of markets) {
        try {
          await marketRegistry.removeMarket(market.condition_id);
          removedCount++;
          removedConditionIds.push(market.condition_id);
        } catch (err) {
          console.error(`Error processing removal for ${market.condition_id}:`, err);
        }
      }

      if (removedCount === 0) {
        return res.status(404).json({
          success: false,
          error: `Event exists, but we are not tracking any of its markets.`
        });
      }

      // 3. Notify Ingest and Dashboard
      if (removedConditionIds.length > 0) {
        publishEvent(EventType.MARKET_REMOVED, {
          conditionIds: removedConditionIds,
          slug,
          source: {
            guildId: req.body.guildId,
            guildName: req.body.guildName,
            channelId: req.body.channelId,
            channelName: req.body.channelName,
            user: req.body.user
          }
        });
      }

      res.json({
        success: true,
        message: `Successfully removed ${removedCount} markets for event: ${slug}`,
        removedCount
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });


  app.post('/api/events/:slug', requireAuth, async (req, res) => {
    try {
      const { slug } = req.params;

      if (!slug) {
        return res.status(400).json({
          success: false,
          error: 'Slug is required'
        });
      }

      let data = await getEvent(slug);
      let isSingleMarket = false;

      // Fallback: If event not found, try finding a single market
      if (!data) {
        const marketData = await getMarket(slug);
        if (marketData) {
          data = {
            ...marketData,
            slug: marketData.slug,
            markets: [marketData]
          };
          isSingleMarket = true;
        }
      }

      if (!data) {
        return res.status(404).json({
          success: false,
          error: `Event or Market '${slug}' not found`
        });
      }

      let addedCount = 0;
      const addedMarkets = [];

      if (data.markets && Array.isArray(data.markets)) {
        for (const market of data.markets) {
          if (market.conditionId) {
            try {
              const name = market.slug || market.question || 'Unknown Market';
              const description = market.question || market.description || name;
              const clobTokenIds = market.clobTokenIds;

              const image = market.image || data.image || null;
              const endDate = market.endDate || data.endDate || null;
              const groupDate = market.groupItemTitle || null;
              await marketRegistry.addMarket(market.conditionId, name, description, clobTokenIds, slug, null, endDate, image, groupDate);

              addedCount++;
              addedMarkets.push(market.conditionId);
            } catch (err) {
              console.warn(`Failed to auto-add market ${market.conditionId}:`, err.message);
            }
          }
        }
      }

      if (addedCount > 0) {
        // Notify Ingest and Dashboard
        publishEvent(EventType.MARKET_ADDED, {
          conditionIds: addedMarkets,
          slug,
          source: {
            guildId: req.body.guildId,
            guildName: req.body.guildName,
            channelId: req.body.channelId,
            channelName: req.body.channelName,
            user: req.body.user
          }
        });
      }

      res.json({
        success: true,
        addedCount,
        addedMarkets,
        data
      });
    } catch (error) {
      console.error('Error fetching event by slug:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return app;
}


