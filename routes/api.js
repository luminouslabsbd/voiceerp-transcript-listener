/**
 * API Routes for Transcript Listener
 * 
 * Provides REST API endpoints for:
 * - Retrieving transcripts
 * - Searching transcripts
 * - Getting statistics
 * - System monitoring
 */

const express = require('express');
const Joi = require('joi');
const moment = require('moment');
const router = express.Router();

// Validation schemas
const schemas = {
  getTranscript: Joi.object({
    call_sid: Joi.string().required().min(10).max(100)
  }),
  
  searchTranscripts: Joi.object({
    q: Joi.string().required().min(1).max(500),
    start_date: Joi.date().optional(),
    end_date: Joi.date().optional(),
    limit: Joi.number().integer().min(1).max(100).default(50)
  }),
  
  getStats: Joi.object({
    start_date: Joi.date().optional(),
    end_date: Joi.date().optional()
  })
};

// Middleware for validation
const validate = (schema) => {
  return (req, res, next) => {
    const data = { ...req.query, ...req.params, ...req.body };
    const { error, value } = schema.validate(data);
    
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }
    
    req.validated = value;
    next();
  };
};

// Get transcript for a specific call
router.get('/transcripts/:call_sid', validate(schemas.getTranscript), async (req, res) => {
  try {
    const { call_sid } = req.validated;
    const { logger } = req.app.locals;
    
    logger.info(`📋 API: Getting transcript for call ${call_sid}`);
    
    // Get database manager from app (would be injected in real implementation)
    const db = req.app.locals.databaseManager;
    
    // Get call transcript
    const callTranscript = await db.getCallTranscript(call_sid);
    if (!callTranscript) {
      return res.status(404).json({
        error: 'Transcript not found',
        message: `No transcript found for call ${call_sid}`
      });
    }
    
    // Get transcript segments
    const segments = await db.getTranscriptSegments(call_sid);
    
    // Format response
    const response = {
      call: {
        call_sid: callTranscript.call_sid,
        caller_number: callTranscript.caller_number,
        destination_number: callTranscript.destination_number,
        start_time: callTranscript.start_time,
        end_time: callTranscript.end_time,
        duration: callTranscript.duration,
        status: callTranscript.status,
        total_segments: callTranscript.total_segments,
        languages: callTranscript.languages?.split(',') || []
      },
      transcript: segments.map(segment => ({
        id: segment.id,
        speaker: segment.speaker,
        text: segment.text,
        start_time: segment.start_time,
        end_time: segment.end_time,
        confidence: parseFloat(segment.confidence),
        language: segment.language,
        source_type: segment.source_type,
        metadata: segment.metadata ? JSON.parse(segment.metadata) : null
      })),
      summary: {
        total_segments: segments.length,
        speakers: [...new Set(segments.map(s => s.speaker))],
        languages: [...new Set(segments.map(s => s.language))],
        sources: [...new Set(segments.map(s => s.source_type))],
        avg_confidence: segments.length > 0 ? 
          segments.reduce((sum, s) => sum + parseFloat(s.confidence), 0) / segments.length : 0
      }
    };
    
    res.json(response);
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to get transcript:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve transcript'
    });
  }
});

// Search transcripts
router.get('/transcripts/search', validate(schemas.searchTranscripts), async (req, res) => {
  try {
    const { q, start_date, end_date, limit } = req.validated;
    const { logger } = req.app.locals;
    
    logger.info(`🔍 API: Searching transcripts for "${q}"`);
    
    const db = req.app.locals.databaseManager;
    
    // Set default date range if not provided
    const startDate = start_date || moment().subtract(30, 'days').toDate();
    const endDate = end_date || new Date();
    
    // Search transcripts
    const results = await db.searchTranscripts(q, startDate, endDate, limit);
    
    // Format response
    const response = {
      query: q,
      date_range: {
        start: startDate,
        end: endDate
      },
      total_results: results.length,
      results: results.map(result => ({
        call_sid: result.call_sid,
        caller_number: result.caller_number,
        start_time: result.start_time,
        duration: result.duration,
        matched_text: result.text,
        speaker: result.speaker,
        relevance: parseFloat(result.relevance || 0)
      }))
    };
    
    res.json(response);
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to search transcripts:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search transcripts'
    });
  }
});

// Get recent transcripts
router.get('/transcripts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const { logger } = req.app.locals;
    
    logger.info(`📋 API: Getting recent transcripts (limit: ${limit})`);
    
    const db = req.app.locals.databaseManager;
    const transcripts = await db.getRecentTranscripts(limit);
    
    const response = {
      total: transcripts.length,
      transcripts: transcripts.map(transcript => ({
        call_sid: transcript.call_sid,
        caller_number: transcript.caller_number,
        destination_number: transcript.destination_number,
        start_time: transcript.start_time,
        end_time: transcript.end_time,
        duration: transcript.duration,
        status: transcript.status,
        total_segments: transcript.total_segments,
        actual_segments: transcript.actual_segments,
        languages: transcript.detected_languages?.split(',') || [],
        speakers: transcript.speakers?.split(',') || []
      }))
    };
    
    res.json(response);
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to get recent transcripts:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve recent transcripts'
    });
  }
});

// Get transcript statistics
router.get('/stats', validate(schemas.getStats), async (req, res) => {
  try {
    const { start_date, end_date } = req.validated;
    const { logger } = req.app.locals;
    
    // Set default date range if not provided
    const startDate = start_date || moment().subtract(7, 'days').toDate();
    const endDate = end_date || new Date();
    
    logger.info(`📊 API: Getting transcript stats from ${startDate} to ${endDate}`);
    
    const db = req.app.locals.databaseManager;
    const stats = await db.getTranscriptStats(startDate, endDate);
    
    const response = {
      date_range: {
        start: startDate,
        end: endDate
      },
      statistics: {
        total_calls: parseInt(stats.total_calls) || 0,
        total_duration_seconds: parseInt(stats.total_duration) || 0,
        average_duration_seconds: Math.round(parseFloat(stats.avg_duration) || 0),
        total_segments: parseInt(stats.total_segments) || 0,
        average_segments_per_call: Math.round(parseFloat(stats.avg_segments_per_call) || 0),
        unique_languages: parseInt(stats.unique_languages) || 0
      },
      formatted: {
        total_duration: formatDuration(parseInt(stats.total_duration) || 0),
        average_duration: formatDuration(Math.round(parseFloat(stats.avg_duration) || 0))
      }
    };
    
    res.json(response);
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to get transcript stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve transcript statistics'
    });
  }
});

// Get system status
router.get('/status', async (req, res) => {
  try {
    const { logger } = req.app.locals;
    
    // Get components from app locals (would be injected in real implementation)
    const freeswitchListener = req.app.locals.freeswitchListener;
    const transcriptProcessor = req.app.locals.transcriptProcessor;
    const databaseManager = req.app.locals.databaseManager;
    const performanceMonitor = req.app.locals.performanceMonitor;
    
    const status = {
      service: 'voiceerp-transcript-listener',
      version: require('../package.json').version,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components: {
        freeswitch_listener: {
          status: freeswitchListener?.isConnected() ? 'connected' : 'disconnected',
          stats: freeswitchListener?.getStats() || null
        },
        transcript_processor: {
          status: transcriptProcessor?.isRedisConnected() ? 'connected' : 'disconnected',
          stats: transcriptProcessor?.getStats() || null
        },
        database: {
          status: databaseManager?.isConnected() ? 'connected' : 'disconnected',
          stats: await databaseManager?.getConnectionStats() || null
        },
        performance_monitor: {
          status: performanceMonitor?.isRunning ? 'running' : 'stopped',
          summary: performanceMonitor?.getPerformanceSummary() || null
        }
      },
      memory: process.memoryUsage(),
      system: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        pid: process.pid
      }
    };
    
    // Determine overall health
    const componentStatuses = Object.values(status.components).map(c => c.status);
    const isHealthy = componentStatuses.every(s => s === 'connected' || s === 'running');
    
    res.status(isHealthy ? 200 : 503).json({
      ...status,
      overall_status: isHealthy ? 'healthy' : 'degraded'
    });
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to get system status:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve system status'
    });
  }
});

// Export transcript (CSV format)
router.get('/transcripts/:call_sid/export', validate(schemas.getTranscript), async (req, res) => {
  try {
    const { call_sid } = req.validated;
    const format = req.query.format || 'csv';
    const { logger } = req.app.locals;
    
    logger.info(`📤 API: Exporting transcript for call ${call_sid} (format: ${format})`);
    
    const db = req.app.locals.databaseManager;
    
    // Get transcript data
    const callTranscript = await db.getCallTranscript(call_sid);
    if (!callTranscript) {
      return res.status(404).json({
        error: 'Transcript not found',
        message: `No transcript found for call ${call_sid}`
      });
    }
    
    const segments = await db.getTranscriptSegments(call_sid);
    
    if (format === 'csv') {
      // Generate CSV
      const csvHeader = 'Speaker,Text,Start Time,End Time,Confidence,Language,Source\n';
      const csvRows = segments.map(segment => {
        const text = `"${segment.text.replace(/"/g, '""')}"`;
        return [
          segment.speaker,
          text,
          segment.start_time,
          segment.end_time || '',
          segment.confidence,
          segment.language,
          segment.source_type
        ].join(',');
      }).join('\n');
      
      const csv = csvHeader + csvRows;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="transcript_${call_sid}.csv"`);
      res.send(csv);
      
    } else {
      res.status(400).json({
        error: 'Unsupported format',
        message: 'Only CSV format is currently supported'
      });
    }
    
  } catch (error) {
    req.app.locals.logger.error('❌ API: Failed to export transcript:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to export transcript'
    });
  }
});

// Get post-processed transcripts
router.get('/post-processed/:callSid?', async (req, res) => {
  try {
    const { callSid } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    const dbManager = req.app.locals.databaseManager;
    const transcripts = await dbManager.getPostProcessedTranscripts(callSid, limit);

    res.json({
      success: true,
      data: transcripts,
      count: transcripts.length
    });
  } catch (error) {
    req.app.locals.logger.error('❌ Failed to get post-processed transcripts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get transcript comparison (real-time vs post-processed)
router.get('/comparison/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;

    const dbManager = req.app.locals.databaseManager;
    const comparison = await dbManager.getTranscriptComparison(callSid);

    res.json({
      success: true,
      data: comparison
    });
  } catch (error) {
    req.app.locals.logger.error('❌ Failed to get transcript comparison:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get post-processing queue stats
router.get('/post-processing/stats', async (req, res) => {
  try {
    const postProcessingService = req.app.get('postProcessingService');

    if (!postProcessingService) {
      return res.status(503).json({
        success: false,
        error: 'Post-processing service not available'
      });
    }

    const stats = await postProcessingService.getStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    req.app.locals.logger.error('❌ Failed to get post-processing stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Utility functions
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

module.exports = router;
