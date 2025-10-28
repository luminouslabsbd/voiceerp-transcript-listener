/**
 * Performance Monitor
 * 
 * Monitors system performance and tracks metrics:
 * - Event processing times
 * - Memory usage
 * - Queue statistics
 * - Database performance
 * - System health
 */

const { EventEmitter } = require('events');

class PerformanceMonitor extends EventEmitter {
  constructor(logger) {
    super();
    
    this.logger = logger;
    this.isRunning = false;
    
    // Performance metrics
    this.metrics = {
      eventProcessing: new Map(),
      memoryUsage: [],
      queueStats: new Map(),
      databaseStats: [],
      systemHealth: new Map()
    };
    
    // Monitoring intervals
    this.intervals = {
      performance: null,
      health: null,
      cleanup: null
    };
    
    // Configuration
    this.config = {
      performanceInterval: parseInt(process.env.PERFORMANCE_LOG_INTERVAL) || 60000, // 1 minute
      healthInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000, // 30 seconds
      cleanupInterval: 300000, // 5 minutes
      maxMetricHistory: 1000
    };
    
    // Performance thresholds
    this.thresholds = {
      eventProcessingMs: 1000, // 1 second
      memoryUsageMB: 512, // 512 MB
      queueBacklog: 100,
      databaseResponseMs: 500 // 500ms
    };
  }

  start() {
    if (this.isRunning) return;
    
    this.logger.info('🔄 Starting Performance Monitor...');
    
    // Start monitoring intervals
    this.intervals.performance = setInterval(() => {
      this.reportPerformanceMetrics();
    }, this.config.performanceInterval);
    
    this.intervals.health = setInterval(() => {
      this.checkSystemHealth();
    }, this.config.healthInterval);
    
    this.intervals.cleanup = setInterval(() => {
      this.cleanupOldMetrics();
    }, this.config.cleanupInterval);
    
    this.isRunning = true;
    this.logger.info('✅ Performance Monitor started');
  }

  stop() {
    if (!this.isRunning) return;
    
    this.logger.info('🛑 Stopping Performance Monitor...');
    
    // Clear intervals
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });
    
    this.isRunning = false;
    this.logger.info('✅ Performance Monitor stopped');
  }

  // Event Processing Metrics
  trackEventProcessing(eventType, processingTimeMs) {
    const timestamp = Date.now();
    
    if (!this.metrics.eventProcessing.has(eventType)) {
      this.metrics.eventProcessing.set(eventType, []);
    }
    
    const eventMetrics = this.metrics.eventProcessing.get(eventType);
    eventMetrics.push({
      timestamp: timestamp,
      processingTime: processingTimeMs
    });
    
    // Keep only recent metrics
    if (eventMetrics.length > this.config.maxMetricHistory) {
      eventMetrics.splice(0, eventMetrics.length - this.config.maxMetricHistory);
    }
    
    // Check for performance issues
    if (processingTimeMs > this.thresholds.eventProcessingMs) {
      this.logger.warn(`⚠️ Slow event processing: ${eventType} took ${processingTimeMs}ms`);
      this.emit('performance_warning', {
        type: 'slow_event_processing',
        eventType: eventType,
        processingTime: processingTimeMs,
        threshold: this.thresholds.eventProcessingMs
      });
    }
  }

  // Memory Usage Tracking
  trackMemoryUsage() {
    const memUsage = process.memoryUsage();
    const timestamp = Date.now();
    
    const memoryData = {
      timestamp: timestamp,
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024) // MB
    };
    
    this.metrics.memoryUsage.push(memoryData);
    
    // Keep only recent metrics
    if (this.metrics.memoryUsage.length > this.config.maxMetricHistory) {
      this.metrics.memoryUsage.shift();
    }
    
    // Check for memory issues
    if (memoryData.heapUsed > this.thresholds.memoryUsageMB) {
      this.logger.warn(`⚠️ High memory usage: ${memoryData.heapUsed}MB`);
      this.emit('performance_warning', {
        type: 'high_memory_usage',
        memoryUsage: memoryData,
        threshold: this.thresholds.memoryUsageMB
      });
    }
    
    return memoryData;
  }

  // Queue Statistics
  trackQueueStats(queueName, stats) {
    const timestamp = Date.now();
    
    if (!this.metrics.queueStats.has(queueName)) {
      this.metrics.queueStats.set(queueName, []);
    }
    
    const queueMetrics = this.metrics.queueStats.get(queueName);
    queueMetrics.push({
      timestamp: timestamp,
      ...stats
    });
    
    // Keep only recent metrics
    if (queueMetrics.length > this.config.maxMetricHistory) {
      queueMetrics.shift();
    }
    
    // Check for queue backlog
    const totalBacklog = (stats.waiting || 0) + (stats.active || 0);
    if (totalBacklog > this.thresholds.queueBacklog) {
      this.logger.warn(`⚠️ Queue backlog: ${queueName} has ${totalBacklog} jobs`);
      this.emit('performance_warning', {
        type: 'queue_backlog',
        queueName: queueName,
        backlog: totalBacklog,
        threshold: this.thresholds.queueBacklog
      });
    }
  }

  // Database Performance
  trackDatabaseOperation(operation, durationMs) {
    const timestamp = Date.now();
    
    this.metrics.databaseStats.push({
      timestamp: timestamp,
      operation: operation,
      duration: durationMs
    });
    
    // Keep only recent metrics
    if (this.metrics.databaseStats.length > this.config.maxMetricHistory) {
      this.metrics.databaseStats.shift();
    }
    
    // Check for slow database operations
    if (durationMs > this.thresholds.databaseResponseMs) {
      this.logger.warn(`⚠️ Slow database operation: ${operation} took ${durationMs}ms`);
      this.emit('performance_warning', {
        type: 'slow_database_operation',
        operation: operation,
        duration: durationMs,
        threshold: this.thresholds.databaseResponseMs
      });
    }
  }

  // System Health Check
  checkSystemHealth() {
    const timestamp = Date.now();
    
    // Check memory usage
    const memoryData = this.trackMemoryUsage();
    
    // Check CPU usage (simplified)
    const cpuUsage = process.cpuUsage();
    
    // System health status
    const healthStatus = {
      timestamp: timestamp,
      memory: {
        status: memoryData.heapUsed < this.thresholds.memoryUsageMB ? 'healthy' : 'warning',
        heapUsed: memoryData.heapUsed,
        threshold: this.thresholds.memoryUsageMB
      },
      uptime: process.uptime(),
      pid: process.pid
    };
    
    this.metrics.systemHealth.set('overall', healthStatus);
    
    // Emit health status
    this.emit('health_check', healthStatus);
  }

  // Performance Reporting
  reportPerformanceMetrics() {
    const report = this.generatePerformanceReport();
    
    this.logger.info('📊 Performance Report:', {
      timestamp: new Date().toISOString(),
      ...report
    });
    
    this.emit('performance_report', report);
  }

  generatePerformanceReport() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Event processing stats
    const eventStats = {};
    for (const [eventType, metrics] of this.metrics.eventProcessing.entries()) {
      const recentMetrics = metrics.filter(m => m.timestamp > oneMinuteAgo);
      if (recentMetrics.length > 0) {
        const processingTimes = recentMetrics.map(m => m.processingTime);
        eventStats[eventType] = {
          count: recentMetrics.length,
          avgProcessingTime: Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length),
          maxProcessingTime: Math.max(...processingTimes),
          minProcessingTime: Math.min(...processingTimes)
        };
      }
    }
    
    // Memory stats
    const recentMemory = this.metrics.memoryUsage.filter(m => m.timestamp > oneMinuteAgo);
    const memoryStats = recentMemory.length > 0 ? {
      current: recentMemory[recentMemory.length - 1],
      avg: {
        heapUsed: Math.round(recentMemory.reduce((sum, m) => sum + m.heapUsed, 0) / recentMemory.length),
        rss: Math.round(recentMemory.reduce((sum, m) => sum + m.rss, 0) / recentMemory.length)
      }
    } : null;
    
    // Queue stats
    const queueStats = {};
    for (const [queueName, metrics] of this.metrics.queueStats.entries()) {
      const recentMetrics = metrics.filter(m => m.timestamp > oneMinuteAgo);
      if (recentMetrics.length > 0) {
        const latest = recentMetrics[recentMetrics.length - 1];
        queueStats[queueName] = {
          waiting: latest.waiting || 0,
          active: latest.active || 0,
          completed: latest.completed || 0,
          failed: latest.failed || 0
        };
      }
    }
    
    // Database stats
    const recentDbOps = this.metrics.databaseStats.filter(m => m.timestamp > oneMinuteAgo);
    const databaseStats = recentDbOps.length > 0 ? {
      totalOperations: recentDbOps.length,
      avgResponseTime: Math.round(recentDbOps.reduce((sum, op) => sum + op.duration, 0) / recentDbOps.length),
      slowOperations: recentDbOps.filter(op => op.duration > this.thresholds.databaseResponseMs).length
    } : null;
    
    return {
      eventProcessing: eventStats,
      memory: memoryStats,
      queues: queueStats,
      database: databaseStats,
      uptime: Math.round(process.uptime()),
      timestamp: now
    };
  }

  // Cleanup old metrics
  cleanupOldMetrics() {
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    
    // Clean event processing metrics
    for (const [eventType, metrics] of this.metrics.eventProcessing.entries()) {
      const filtered = metrics.filter(m => m.timestamp > cutoffTime);
      this.metrics.eventProcessing.set(eventType, filtered);
    }
    
    // Clean memory metrics
    this.metrics.memoryUsage = this.metrics.memoryUsage.filter(m => m.timestamp > cutoffTime);
    
    // Clean queue metrics
    for (const [queueName, metrics] of this.metrics.queueStats.entries()) {
      const filtered = metrics.filter(m => m.timestamp > cutoffTime);
      this.metrics.queueStats.set(queueName, filtered);
    }
    
    // Clean database metrics
    this.metrics.databaseStats = this.metrics.databaseStats.filter(m => m.timestamp > cutoffTime);
    
    this.logger.debug('🧹 Cleaned up old performance metrics');
  }

  // Get current metrics
  getMetrics() {
    return {
      eventProcessing: Object.fromEntries(this.metrics.eventProcessing),
      memoryUsage: this.metrics.memoryUsage.slice(-10), // Last 10 entries
      queueStats: Object.fromEntries(this.metrics.queueStats),
      databaseStats: this.metrics.databaseStats.slice(-10), // Last 10 entries
      systemHealth: Object.fromEntries(this.metrics.systemHealth)
    };
  }

  // Get performance summary
  getPerformanceSummary() {
    return this.generatePerformanceReport();
  }
}

module.exports = PerformanceMonitor;
