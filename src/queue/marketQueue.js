import { Queue, Worker } from 'bullmq';
import { config } from '../config.js';
import { marketRegistry } from '../database/marketRegistry.js';
import { clobListener } from '../clob/clobListener.js';

const connection = config.redisConnection;

export const marketQueue = new Queue('market-fetch-queue', { connection });

let worker;

// Gamma resets connections on large responses / transient network blips, so retry with backoff
async function fetchPageWithRetry(url, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (err) {
            if (attempt >= attempts) throw err;
            const delay = 1000 * 2 ** (attempt - 1);
            console.warn(`[MarketFetch] Attempt ${attempt}/${attempts} failed (${err.message}); retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function fetchAllActiveMarkets(onBatch) {
    let offset = 0;
    const limit = 250; // Smaller pages are less likely to be reset mid-response
    let hasMore = true;
    let batch = [];
    const BATCH_SIZE = 500; // Upsert every 500 markets to save memory

    while (hasMore) {
        try {
            const url = `${config.polymarket.gammaApiUrl}/events?active=true&closed=false&limit=${limit}&offset=${offset}`;
            console.log(`[MarketFetch] Fetching offset ${offset}...`);
            const events = await fetchPageWithRetry(url);

            if (!Array.isArray(events) || events.length === 0) {
                hasMore = false;
                break;
            }

            for (const event of events) {
                if (!event.markets) continue;

                // Extract tags from event level (array of {label, slug})
                // Extract tags from event level (array of {label, slug})
                // Use label (e.g. "Politics") for better UI display, fallback to slug
                const eventTags = Array.isArray(event.tags)
                    ? event.tags.map(t => t.label || t.slug).filter(Boolean)
                    : [];

                for (const market of event.markets) {
                    if (market.active && !market.closed) {
                        let clobTokenIds = market.clobTokenIds;
                        if (Array.isArray(clobTokenIds)) {
                            clobTokenIds = JSON.stringify(clobTokenIds);
                        }

                        batch.push({
                            conditionId: market.conditionId,
                            slug: market.slug,
                            description: market.description || event.description,
                            clobTokenIds: clobTokenIds,
                            outcomePrices: market.outcomePrices, // Add this
                            eventSlug: event.slug,
                            threshold: null,
                            endDate: market.endDateIso || market.endDate,
                            image: market.image || event.image,
                            groupDate: market.groupItemTitle,
                            tags: eventTags, // Add tags from event
                            volume: market.volume,
                            liquidity: market.liquidity,
                            active: true
                        });

                        if (batch.length >= BATCH_SIZE) {
                            await onBatch(batch);
                            batch = []; // Clear memory
                            // Yield to event loop
                            await new Promise(r => setImmediate(r));
                        }
                    }
                }
            }

            if (events.length < limit) {
                hasMore = false;
            } else {
                offset += limit;
                // Small delay to be nice to API
                await new Promise(r => setTimeout(r, 100));
            }

        } catch (err) {
            console.error(`[MarketFetch] Error fetching page at offset ${offset}:`, err.message);
            // Don't throw entire job for one failed page, try to continue or break? 
            // In strict mode we might throw, but for stability let's break or retry.
            // Let's throw to be safe for now, manual restart needed.
            throw err;
        }
    }

    // Process remaining
    if (batch.length > 0) {
        await onBatch(batch);
    }
}

async function startMarketWorker() {
    if (worker) return; // Already started

    worker = new Worker('market-fetch-queue', async (job) => {
        console.log(`[MarketFetch] Starting sync job: ${job.name} (ID: ${job.id})`);
        try {
            let totalSynced = 0;

            const allActiveConditionIds = new Set();
            const allDiscoveredTags = new Set(); // Track all tags for DB sync

            await fetchAllActiveMarkets(async (batch) => {
                if (batch.length === 0) return;
                try {
                    // Perform upsert for this batch
                    // IMPORTANT: Set active=1 but DO NOT set watched=1
                    await marketRegistry.upsertMarkets(batch, { fullSync: false, setWatched: false });

                    // FEED DIRECTLY TO LISTENER
                    // Convert batch to listener format
                    const marketsForListener = batch.map(m => ({
                        conditionId: m.conditionId,
                        slug: m.slug,
                        threshold: m.threshold,
                        clobTokenIds: m.clobTokenIds // string or object
                    }));
                    await clobListener.addMarkets(marketsForListener);

                    // Track active IDs and discovered tags
                    batch.forEach(m => {
                        allActiveConditionIds.add(m.conditionId);
                        if (m.tags && Array.isArray(m.tags)) {
                            m.tags.forEach(tag => allDiscoveredTags.add(tag));
                        }
                    });

                    totalSynced += batch.length;
                    console.log(`[MarketFetch] Synced batch of ${batch.length} markets (Total: ${totalSynced})`);
                } catch (dbErr) {
                    console.error(`[MarketFetch] Batch upsert failed (Batch Size: ${batch.length}):`, dbErr);
                }
            });

            console.log(`[MarketFetch] Sync cycle complete. Total synced: ${totalSynced}`);

            // SYNC DISCOVERED TAGS TO DB
            if (allDiscoveredTags.size > 0) {
                await marketRegistry.upsertTags(Array.from(allDiscoveredTags));
                console.log(`[MarketFetch] Synced ${allDiscoveredTags.size} unique tags to database.`);
            }

            // CLEANUP ZOMBIES
            if (totalSynced > 0 && allActiveConditionIds.size > 0) {
                const removedCount = await marketRegistry.deactivateStaleMarkets(Array.from(allActiveConditionIds));
                if (removedCount > 0) {
                    console.log(`[MarketFetch] Cleanup: Deactivated ${removedCount} zombie markets.`);
                    // Optional: Broadcast event to trigger CLOB reload?
                    // broadcast('ZOMBIE_CLEANUP', { count: removedCount }); 
                }
            }

        } catch (error) {
            console.error(`[MarketFetch] Job failed:`, error);
            throw error;
        }
    }, {
        connection,
        limiter: {
            max: 1,
            duration: 5000
        }
    });

    worker.on('failed', (job, err) => {
        console.error(`[MarketFetch] Job ${job.id} failed: ${err.message}`);
    });

    console.log('[MarketFetch] Worker started.');
}

export async function initializeMarketFetcher() {
    // 0. Drain any backlog of jobs from previous crash loops
    await marketQueue.drain();
    console.log('[MarketFetch] Drained queue backlog.');

    // 1. Clean up old repeatable jobs to prevent duplicates
    const repeatableJobs = await marketQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        if (job.name === 'fetch-active-markets-job') {
            await marketQueue.removeRepeatableByKey(job.key);
        }
    }

    // 2. Start the worker NOW (fresh slate)
    await startMarketWorker();

    // 3. Schedule new repeatable job
    await marketQueue.add(
        'fetch-active-markets-job',
        {},
        {
            repeat: {
                every: 10 * 60 * 1000
            },
            jobId: 'market-fetch-periodic' // Ensures uniqueness
        }
    );
    console.log('[MarketFetch] Scheduled repeatable market fetch job (every 10m).');

    // 4. Trigger immediate sync (since we drained, queue is empty)
    await marketQueue.add('fetch-active-markets-now', {}, {
        removeOnComplete: true
    });
    console.log('[MarketFetch] Triggered immediate initial sync.');
}

export async function closeMarketQueue() {
    await marketQueue.close();
    if (worker) {
        await worker.close();
    }
}
