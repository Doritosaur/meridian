import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { safeFloat, safeJsonParse, formatCompactUSD, formatUSD } from '../utils/number.js';

export function createTradeEmbed(data) {
    const isBuy = data.tradeType === 'BUY';
    const color = isBuy ? config.colors.buy : config.colors.sell;
    let title = `${data.tradeType} Detected`;
    if (data.value) {
        const valueStr = Math.round(safeFloat(data.value)).toLocaleString();
        title = `$${valueStr} ${data.tradeType} -> ${data.outcome}`;
    }

    const marketLink = `${config.polymarket.appUrl}/market/${data.marketName}`;
    const marketTitle = data.question || data.marketName || 'Unnamed Market';

    let dateStr = 'Unknown';
    if (data.endDate) {
        try {
            const dateDate = new Date(data.endDate);
            dateStr = dateDate.toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
        } catch (e) { dateStr = data.endDate; }
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setAuthor({
            name: marketTitle,
            iconURL: data.image || `${config.polymarket.appUrl}/favicon.ico`,
            url: marketLink
        })
        .setFooter({ text: 'Meridian', iconURL: `${config.polymarket.appUrl}/images/brand/icon-blue.png` })
        .setTimestamp(new Date(data.timestamp));

    if (data.type === 'trade') {
        const priceVal = safeFloat(data.price);
        const priceStr = formatUSD(priceVal);
        const amountStr = formatCompactUSD(data.amount);
        const valueStr = formatCompactUSD(data.value);

        const vol24Str = data.volume24hr ? formatCompactUSD(data.volume24hr) : 'N/A';
        const volTotalStr = data.volume ? formatCompactUSD(data.volume) : 'N/A';
        const liqStr = data.liquidity ? formatCompactUSD(data.liquidity) : 'N/A';

        let probStr = `${(priceVal * 100).toFixed(2)}%`;
        if (data.outcomePrices && data.outcomes) {
            try {
                probStr = data.outcomes
                    .map((o, i) => `${o}: ${(safeFloat(data.outcomePrices[i]) * 100).toFixed(2)}%`)
                    .join(' | ');
            } catch (e) { /* fallback */ }
        }

        embed.addFields(
            { name: 'Outcome', value: `${data.outcome}`, inline: true },
            { name: 'Price', value: `${priceStr}`, inline: true },
            { name: 'Amount', value: `${amountStr}`, inline: true },

            { name: 'Value', value: `${valueStr}`, inline: true },
            { name: 'Ends', value: `${dateStr}`, inline: true },
            { name: '24h Vol', value: `${vol24Str}`, inline: true },

            { name: 'Total Vol', value: `${volTotalStr}`, inline: true },
            { name: 'Liquidity', value: `${liqStr}`, inline: true },

            { name: 'Outcomes', value: `${probStr}`, inline: true }
        );

    } else if (data.type === 'large_order') {
        embed.addFields(
            { name: 'Details', value: `**${data.tradeType}** ${data.outcome} | **$${data.price}** | ${safeFloat(data.amount).toLocaleString()}`, inline: false }
        );
    }
    return embed;
}

export function createEventEmbed(data) {
    const markets = data.markets || [];
    const endDate = data.endDate ? new Date(data.endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown';

    const volStr = formatCompactUSD(data.volume);
    const liqStr = formatCompactUSD(data.liquidity);

    const embed = new EmbedBuilder()
        .setTitle(data.title)
        .setAuthor({
            name: 'Polymarket Event',
            iconURL: data.image || data.icon || `${config.polymarket.appUrl}/favicon.ico`,
            url: `${config.polymarket.appUrl}/event/${data.slug}`
        })
        .setURL(`${config.polymarket.appUrl}/event/${data.slug}`)
        .setColor(config.colors.event)
        .addFields(
            { name: '💰 Volume', value: volStr, inline: true },
            { name: '💧 Liquidity', value: liqStr, inline: true },
            { name: '📅 Ends', value: endDate, inline: true },
        )
        .setFooter({ text: `Event Slug: ${data.slug}` });

    // Limit to 20 fields remaining
    const displayMarkets = markets.slice(0, 20);

    displayMarkets.forEach(m => {
        let priceStr = "N/A";
        if (m.outcomePrices) {
            try {
                let prices = safeJsonParse(m.outcomePrices);
                const yesPrice = safeFloat(prices[0]);
                const noPrice = safeFloat(prices[1]);
                priceStr = `Yes: $${yesPrice.toFixed(2)} | No: $${noPrice.toFixed(2)}`;
            } catch (e) { priceStr = "Error parsing prices"; }
        }

        // If it's a group market, use groupItemTitle, else question
        const name = m.groupItemTitle || m.question;
        embed.addFields({ name: name, value: priceStr, inline: false });
    });

    if (markets.length > 25) {
        embed.setFooter({ text: `Showing top 25 of ${markets.length} markets. | Event: ${data.slug}` });
    }

    return embed;
}
