# VoiceERP Transcript Listener Dockerfile
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S transcript -u 1001 -G nodejs

# Create directories and set permissions
RUN mkdir -p /app/logs /app/tmp && \
    chown -R transcript:nodejs /app

# Switch to non-root user
USER transcript

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3012}/health || exit 1

# Expose port
EXPOSE 3012

# Start the application
CMD ["node", "server.js"]
