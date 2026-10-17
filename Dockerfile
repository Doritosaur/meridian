FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --production

# Copy source code
COPY src ./src

# Expose the API port
EXPOSE 3000

# Start the bot
CMD ["bun", "run", "start:all"]
