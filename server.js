#!/usr/bin/env node

/**
 * VoiceERP Transcript Listener
 * Real-time transcript capture using FreeSWITCH Event Socket
 * 
 * This service monitors FreeSWITCH events to capture:
 * - TTS (Text-to-Speech) events in real-time
 * - STT (Speech-to-Text) results from user speech
 * - Audio playback events
 * - Call recording events
 * 
 * Zero impact on call performance - completely separate process
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const pino = require('pino');
const { createServer } = require('http');
const WebSocket = require('ws');

// Import our core modules
const FreeSWITCHListener = require('./lib/FreeSWITCHListener');
const TranscriptProcessor = require('./lib/TranscriptProcessor');
const DatabaseManager = require('./lib/DatabaseManager');
const PerformanceMonitor = require('./lib/PerformanceMonitor');
const PostProcessingService = require('./lib/PostProcessingService');
const APIRouter = require('./routes/api');
const WebhookRouter = require('./routes/webhooks');

// Initialize logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  } : undefined
});

class TranscriptListenerServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.wsServer = null;
    this.freeswitchListener = null;
    this.transcriptProcessor = null;
    this.dbManager = null;
    this.performanceMonitor = null;
    this.isShuttingDown = false;
    
    this.setupExpress();
    this.setupWebSocket();
    this.setupGracefulShutdown();
  }

  setupExpress() {
    // Security and performance middleware
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(cors({
      origin: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
      credentials: true
    }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Add logger to app locals
    this.app.locals.logger = logger;

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      const health = {
        status: 'ok',
        service: 'voiceerp-transcript-listener',
        version: require('./package.json').version,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connections: {
          freeswitch: this.freeswitchListener?.isConnected() || false,
          database: this.dbManager?.isConnected() || false,
          redis: this.transcriptProcessor?.isRedisConnected() || false
        }
      };

      const isHealthy = health.connections.freeswitch && 
                       health.connections.database && 
                       health.connections.redis;

      res.status(isHealthy ? 200 : 503).json(health);
    });

    // API routes
    this.app.use('/api', APIRouter);

    // Webhook routes
    this.app.use('/webhooks', WebhookRouter);

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
      });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.originalUrl} not found`
      });
    });
  }

  setupWebSocket() {
    this.server = createServer(this.app);
    
    // WebSocket server for real-time transcript updates
    this.wsServer = new WebSocket.Server({ 
      server: this.server,
      path: '/ws/transcripts'
    });

    this.wsServer.on('connection', (ws, req) => {
      logger.info(`🔌 WebSocket connection established from ${req.socket.remoteAddress}`);
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (error) {
          logger.error('Invalid WebSocket message:', error);
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        logger.info('🔌 WebSocket connection closed');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to VoiceERP Transcript Listener',
        timestamp: Date.now()
      }));
    });
  }

  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        // Subscribe to specific call transcripts
        if (data.callSid) {
          ws.callSid = data.callSid;
          logger.info(`🔔 WebSocket subscribed to call: ${data.callSid}`);
        }
        break;
      
      case 'unsubscribe':
        delete ws.callSid;
        logger.info('🔕 WebSocket unsubscribed from call updates');
        break;
      
      default:
        ws.send(JSON.stringify({ error: 'Unknown message type' }));
    }
  }

  broadcastTranscriptUpdate(callSid, transcriptData) {
    if (!this.wsServer) return;

    const message = JSON.stringify({
      type: 'transcript_update',
      callSid: callSid,
      data: transcriptData,
      timestamp: Date.now()
    });

    this.wsServer.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && 
          (client.callSid === callSid || !client.callSid)) {
        client.send(message);
      }
    });
  }

  async initialize() {
    try {
      logger.info('🚀 Initializing VoiceERP Transcript Listener...');

      // Initialize database manager
      this.dbManager = new DatabaseManager(logger);
      await this.dbManager.initialize();
      logger.info('✅ Database manager initialized');

      // Initialize transcript processor
      this.transcriptProcessor = new TranscriptProcessor(logger, this.dbManager);
      await this.transcriptProcessor.initialize();
      logger.info('✅ Transcript processor initialized');

      // Initialize performance monitor
      this.performanceMonitor = new PerformanceMonitor(logger);
      this.performanceMonitor.start();
      logger.info('✅ Performance monitor started');

      // Initialize post-processing service (if enabled)
      if (process.env.ENABLE_POST_PROCESSING === 'true') {
        const postProcessingConfig = {
          recordingPath: process.env.RECORDING_STORAGE_PATH || '/tmp/recordings',
          googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
          postProcessingDelay: parseInt(process.env.POST_PROCESSING_QUEUE_DELAY) || 30,
          redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT) || 6379,
            password: process.env.REDIS_PASSWORD || '',
            db: parseInt(process.env.REDIS_DB) || 2
          }
        };

        this.postProcessingService = new PostProcessingService(postProcessingConfig, this.dbManager);
        await this.postProcessingService.start();
        logger.info('✅ Post-processing service started');

        // Make services available to routes
        this.app.set('postProcessingService', this.postProcessingService);
        this.app.set('transcriptProcessor', this.transcriptProcessor);
      }

      // Initialize FreeSWITCH listener
      this.freeswitchListener = new FreeSWITCHListener(
        logger,
        this.transcriptProcessor,
        this.performanceMonitor,
        this.broadcastTranscriptUpdate.bind(this)
      );
      await this.freeswitchListener.connect();
      logger.info('✅ FreeSWITCH listener connected');

      logger.info('🎯 VoiceERP Transcript Listener fully initialized!');
      
    } catch (error) {
      logger.error('❌ Failed to initialize transcript listener:', error);
      process.exit(1);
    }
  }

  async start() {
    const port = process.env.PORT || 3012;
    const host = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for Docker access

    await this.initialize();

    this.server.listen(port, host, () => {
      logger.info(`🎯 VoiceERP Transcript Listener running on ${host}:${port}`);
      logger.info(`📊 Health check: http://localhost:${port}/health`);
      logger.info(`🔌 WebSocket: ws://localhost:${port}/ws/transcripts`);
      logger.info(`📡 FreeSWITCH: ${process.env.FREESWITCH_HOST}:${process.env.FREESWITCH_PORT}`);
    });
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

      try {
        // Close WebSocket server
        if (this.wsServer) {
          this.wsServer.close();
          logger.info('✅ WebSocket server closed');
        }

        // Close HTTP server
        if (this.server) {
          this.server.close();
          logger.info('✅ HTTP server closed');
        }

        // Disconnect FreeSWITCH listener
        if (this.freeswitchListener) {
          await this.freeswitchListener.disconnect();
          logger.info('✅ FreeSWITCH listener disconnected');
        }

        // Stop transcript processor
        if (this.transcriptProcessor) {
          await this.transcriptProcessor.shutdown();
          logger.info('✅ Transcript processor stopped');
        }

        // Stop post-processing service
        if (this.postProcessingService) {
          await this.postProcessingService.stop();
          logger.info('✅ Post-processing service stopped');
        }

        // Close database connections
        if (this.dbManager) {
          await this.dbManager.close();
          logger.info('✅ Database connections closed');
        }

        // Stop performance monitor
        if (this.performanceMonitor) {
          this.performanceMonitor.stop();
          logger.info('✅ Performance monitor stopped');
        }

        logger.info('🎯 Graceful shutdown completed');
        process.exit(0);

      } catch (error) {
        logger.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart
  }
}

// Start the server
if (require.main === module) {
  const server = new TranscriptListenerServer();
  server.start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = TranscriptListenerServer;
