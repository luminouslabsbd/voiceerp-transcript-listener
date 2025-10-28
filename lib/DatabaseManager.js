/**
 * Database Manager
 * 
 * Manages database connections and operations for transcript storage
 * Uses connection pooling for optimal performance
 */

const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');

class DatabaseManager {
  constructor(logger) {
    this.logger = logger;
    this.pool = null;
    this.isConnected = false;
  }

  async initialize() {
    try {
      this.logger.info('🔄 Initializing Database Manager...');

      // Create connection pool
      this.pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'transcript_user',
        password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'transcript_password_2024!',
        database: process.env.DB_NAME || 'voiceerp_transcripts',
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
        queueLimit: 0,
        charset: 'utf8mb4',
        timezone: '+00:00',
        // MySQL2 specific options
        waitForConnections: true,
        idleTimeout: 300000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
      });

      // Test connection
      await this.testConnection();
      
      this.isConnected = true;
      this.logger.info('✅ Database Manager initialized');

    } catch (error) {
      this.logger.error('❌ Failed to initialize Database Manager:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      this.logger.info('✅ Database connection test successful');
    } catch (error) {
      this.logger.error('❌ Database connection test failed:', error);
      // For now, don't throw error to allow service to start without DB
      this.logger.warn('⚠️ Continuing without database - transcript storage disabled');
    }
  }

  // Call Transcript Operations
  async insertCallTranscript(callTranscript) {
    try {
      // For now, just log the transcript data instead of inserting
      this.logger.info(`📝 TRANSCRIPT LOG: Call ${callTranscript.call_sid}`, {
        caller: callTranscript.caller_number,
        duration: callTranscript.duration,
        segments: callTranscript.total_segments
      });
      return { insertId: 'mock-id', affectedRows: 1 };

    } catch (error) {
      this.logger.error('❌ Failed to insert call transcript:', error);
      throw error;
    }
  }

  async getCallTranscript(callSid) {
    try {
      const query = `
        SELECT * FROM call_transcripts 
        WHERE call_sid = ?
      `;

      const [rows] = await this.pool.execute(query, [callSid]);
      return rows[0] || null;

    } catch (error) {
      this.logger.error('❌ Failed to get call transcript:', error);
      throw error;
    }
  }

  async updateCallTranscriptStatus(callSid, status, totalSegments = null) {
    try {
      let query = `UPDATE call_transcripts SET status = ?`;
      let values = [status];

      if (totalSegments !== null) {
        query += `, total_segments = ?`;
        values.push(totalSegments);
      }

      query += ` WHERE call_sid = ?`;
      values.push(callSid);

      const [result] = await this.pool.execute(query, values);
      return result;

    } catch (error) {
      this.logger.error('❌ Failed to update call transcript status:', error);
      throw error;
    }
  }

  // Transcript Segment Operations
  async insertTranscriptSegment(segment) {
    try {
      // For now, just log the segment data instead of inserting
      this.logger.info(`🎤 SEGMENT LOG: ${segment.speaker} (${segment.segment_type})`, {
        callSid: segment.call_sid,
        text: segment.text.substring(0, 100) + (segment.text.length > 100 ? '...' : ''),
        confidence: segment.confidence,
        language: segment.language,
        vendor: segment.vendor,
        processingType: segment.processing_type || 'real_time'
      });
      return { insertId: 'mock-segment-id', affectedRows: 1 };

    } catch (error) {
      this.logger.error('❌ Failed to insert transcript segment:', error);
      throw error;
    }
  }

  async insertTranscriptSegments(segments) {
    if (!segments || segments.length === 0) return;

    try {
      // For now, just log the batch segments
      this.logger.info(`📝 BATCH SEGMENTS LOG: ${segments.length} segments`, {
        callSid: segments[0]?.call_sid,
        speakers: [...new Set(segments.map(s => s.speaker))],
        languages: [...new Set(segments.map(s => s.language))],
        totalText: segments.reduce((sum, s) => sum + s.text.length, 0)
      });

      segments.forEach((segment, index) => {
        this.logger.debug(`  ${index + 1}. ${segment.speaker}: ${segment.text.substring(0, 50)}...`);
      });

      return { affectedRows: segments.length };

    } catch (error) {
      this.logger.error('❌ Failed to batch insert transcript segments:', error);
      throw error;
    }
  }

  async getTranscriptSegments(callSid, limit = 1000) {
    try {
      const query = `
        SELECT * FROM transcript_segments 
        WHERE call_sid = ? 
        ORDER BY start_time ASC 
        LIMIT ?
      `;

      const [rows] = await this.pool.execute(query, [callSid, limit]);
      return rows;

    } catch (error) {
      this.logger.error('❌ Failed to get transcript segments:', error);
      throw error;
    }
  }

  // Audio Event Operations
  async insertAudioEvent(audioEvent) {
    try {
      // For now, just log the audio event
      this.logger.info(`🎵 AUDIO EVENT LOG: ${audioEvent.event_type}`, {
        callSid: audioEvent.call_sid,
        fileName: audioEvent.file_name,
        duration: audioEvent.duration
      });
      return { insertId: 'mock-audio-id', affectedRows: 1 };

    } catch (error) {
      this.logger.error('❌ Failed to insert audio event:', error);
      throw error;
    }
  }

  // Search and Query Operations
  async searchTranscripts(searchText, startDate, endDate, limit = 50) {
    try {
      const query = `
        CALL SearchTranscripts(?, ?, ?, ?)
      `;

      const [rows] = await this.pool.execute(query, [searchText, startDate, endDate, limit]);
      return rows[0] || [];

    } catch (error) {
      this.logger.error('❌ Failed to search transcripts:', error);
      throw error;
    }
  }

  async getRecentTranscripts(limit = 50) {
    try {
      const query = `
        SELECT * FROM v_recent_transcripts 
        ORDER BY start_time DESC 
        LIMIT ?
      `;

      const [rows] = await this.pool.execute(query, [limit]);
      return rows;

    } catch (error) {
      this.logger.error('❌ Failed to get recent transcripts:', error);
      throw error;
    }
  }

  async getTranscriptSummary(callSid) {
    try {
      const query = `
        SELECT * FROM v_transcript_summary 
        WHERE call_sid = ?
      `;

      const [rows] = await this.pool.execute(query, [callSid]);
      return rows[0] || null;

    } catch (error) {
      this.logger.error('❌ Failed to get transcript summary:', error);
      throw error;
    }
  }

  // Performance and Health Operations
  async insertPerformanceMetric(metricType, metricName, value, unit, metadata = null) {
    try {
      const query = `
        INSERT INTO performance_metrics (
          metric_type, metric_name, metric_value, metric_unit, 
          timestamp, metadata
        ) VALUES (?, ?, ?, ?, NOW(), ?)
      `;

      const values = [metricType, metricName, value, unit, JSON.stringify(metadata)];
      const [result] = await this.pool.execute(query, values);
      return result;

    } catch (error) {
      this.logger.error('❌ Failed to insert performance metric:', error);
      throw error;
    }
  }

  async updateSystemHealth(serviceName, status, responseTime = null, errorCount = 0, lastError = null) {
    try {
      const query = `
        INSERT INTO system_health (
          service_name, status, response_time_ms, error_count, 
          last_error, checked_at
        ) VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          response_time_ms = VALUES(response_time_ms),
          error_count = VALUES(error_count),
          last_error = VALUES(last_error),
          checked_at = VALUES(checked_at)
      `;

      const values = [serviceName, status, responseTime, errorCount, lastError];
      const [result] = await this.pool.execute(query, values);
      return result;

    } catch (error) {
      this.logger.error('❌ Failed to update system health:', error);
      throw error;
    }
  }

  // Statistics and Analytics
  async getTranscriptStats(startDate, endDate) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_calls,
          SUM(duration) as total_duration,
          AVG(duration) as avg_duration,
          SUM(total_segments) as total_segments,
          AVG(total_segments) as avg_segments_per_call,
          COUNT(DISTINCT languages) as unique_languages
        FROM call_transcripts 
        WHERE start_time BETWEEN ? AND ?
        AND status = 'completed'
      `;

      const [rows] = await this.pool.execute(query, [startDate, endDate]);
      return rows[0] || {};

    } catch (error) {
      this.logger.error('❌ Failed to get transcript stats:', error);
      throw error;
    }
  }

  // Utility Methods
  isConnected() {
    return this.isConnected && this.pool;
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      this.logger.info('✅ Database connections closed');
    }
  }

  async getConnectionStats() {
    if (!this.pool) return null;

    return {
      totalConnections: this.pool.pool.config.connectionLimit,
      activeConnections: this.pool.pool._allConnections.length,
      freeConnections: this.pool.pool._freeConnections.length,
      queuedRequests: this.pool.pool._connectionQueue.length
    };
  }

  // Post-Processing Methods

  // Insert main transcript record (for post-processing)
  async insertTranscript(transcript) {
    try {
      this.logger.info(`📝 TRANSCRIPT LOG: ${transcript.transcript_type}`, {
        callSid: transcript.call_sid,
        language: transcript.language,
        duration: transcript.duration,
        averageConfidence: transcript.average_confidence,
        segmentCount: transcript.segment_count,
        processingMethod: transcript.processing_method
      });
      return { insertId: 'mock-transcript-id', affectedRows: 1 };
    } catch (error) {
      this.logger.error('❌ Failed to insert transcript:', error);
      throw error;
    }
  }

  // Insert word-level timestamps (for post-processing)
  async insertWordTimestamp(wordData) {
    try {
      this.logger.debug(`🔤 WORD LOG: ${wordData.word}`, {
        callSid: wordData.call_sid,
        speaker: wordData.speaker,
        startTime: wordData.start_time,
        endTime: wordData.end_time,
        confidence: wordData.confidence
      });
      return { insertId: 'mock-word-id', affectedRows: 1 };
    } catch (error) {
      this.logger.error('❌ Failed to insert word timestamp:', error);
      throw error;
    }
  }

  // Get post-processed transcripts
  async getPostProcessedTranscripts(callSid = null, limit = 10) {
    try {
      this.logger.info('📋 Getting post-processed transcripts:', {
        callSid,
        limit
      });

      // Mock data for now
      const mockTranscripts = [
        {
          id: 'mock-transcript-1',
          call_sid: callSid || 'sample-call-sid',
          transcript_type: 'post_processed',
          language: 'bn-BD',
          duration: 25.5,
          average_confidence: 0.92,
          segment_count: 2,
          processing_method: 'google_batch',
          created_at: new Date()
        }
      ];

      return callSid ? mockTranscripts.filter(t => t.call_sid === callSid) : mockTranscripts;
    } catch (error) {
      this.logger.error('❌ Failed to get post-processed transcripts:', error);
      throw error;
    }
  }

  // Get transcript comparison (real-time vs post-processed)
  async getTranscriptComparison(callSid) {
    try {
      this.logger.info('🔍 Getting transcript comparison:', { callSid });

      // Mock comparison data
      return {
        call_sid: callSid,
        real_time: {
          segments: 1,
          average_confidence: 0.16,
          processing_time: '< 1s',
          text: 'কনফার্ম'
        },
        post_processed: {
          segments: 2,
          average_confidence: 0.92,
          processing_time: '~30s',
          text: 'আসসালামু আলাইকুম স্যার, আমি রকমারি ডট কম থেকে রাকিব বলছি। কনফার্ম।'
        },
        improvement: {
          confidence_gain: 0.76,
          additional_content: true,
          speaker_identification: true,
          word_timestamps: true
        }
      };
    } catch (error) {
      this.logger.error('❌ Failed to get transcript comparison:', error);
      throw error;
    }
  }
}

module.exports = DatabaseManager;
