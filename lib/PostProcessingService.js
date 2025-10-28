const fs = require('fs').promises;
const path = require('path');
const speech = require('@google-cloud/speech');
const Bull = require('bull');
const pino = require('pino');

class PostProcessingService {
  constructor(config, databaseManager) {
    this.config = config;
    this.db = databaseManager;
    this.logger = pino({ name: 'PostProcessingService' });
    
    // Initialize Google Speech client
    this.speechClient = new speech.SpeechClient({
      keyFilename: config.googleCredentials
    });
    
    // Create Bull queue for post-processing jobs
    this.postProcessQueue = new Bull('post-processing', {
      redis: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db
      }
    });
    
    this.setupQueueProcessors();
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) return;
    
    this.logger.info('🎬 Starting Post-Processing Service...');
    
    try {
      // Ensure recording directory exists
      await this.ensureRecordingDirectory();
      
      // Start queue processing
      await this.postProcessQueue.resume();
      
      this.isRunning = true;
      this.logger.info('✅ Post-Processing Service started successfully');
      
      // Set up periodic cleanup
      this.setupPeriodicCleanup();
      
    } catch (error) {
      this.logger.error('❌ Failed to start Post-Processing Service:', error);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) return;
    
    this.logger.info('🛑 Stopping Post-Processing Service...');
    
    try {
      await this.postProcessQueue.pause();
      await this.postProcessQueue.close();
      
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      
      this.isRunning = false;
      this.logger.info('✅ Post-Processing Service stopped');
      
    } catch (error) {
      this.logger.error('❌ Error stopping Post-Processing Service:', error);
    }
  }

  setupQueueProcessors() {
    // Process recording files
    this.postProcessQueue.process('process-recording', 3, async (job) => {
      return await this.processRecording(job.data);
    });

    // Queue event handlers
    this.postProcessQueue.on('completed', (job, result) => {
      this.logger.info(`✅ Post-processing job ${job.id} completed:`, {
        callSid: job.data.call_sid,
        duration: result.duration,
        segments: result.segments?.length || 0
      });
    });

    this.postProcessQueue.on('failed', (job, err) => {
      this.logger.error(`❌ Post-processing job ${job.id} failed:`, {
        callSid: job.data.call_sid,
        error: err.message
      });
    });
  }

  async ensureRecordingDirectory() {
    try {
      await fs.access(this.config.recordingPath);
    } catch (error) {
      this.logger.info(`📁 Creating recording directory: ${this.config.recordingPath}`);
      await fs.mkdir(this.config.recordingPath, { recursive: true });
    }
  }

  // Called when a recording is complete (webhook from Jambonz)
  async handleRecordingComplete(recordingData) {
    this.logger.info('🎙️ Recording complete notification received:', {
      callSid: recordingData.call_sid,
      recordingUrl: recordingData.recording_url,
      duration: recordingData.duration
    });

    try {
      // Add job to post-processing queue with delay
      const job = await this.postProcessQueue.add('process-recording', {
        call_sid: recordingData.call_sid,
        recording_url: recordingData.recording_url,
        duration: recordingData.duration,
        from: recordingData.from,
        to: recordingData.to,
        account_sid: recordingData.account_sid,
        timestamp: new Date().toISOString()
      }, {
        delay: this.config.postProcessingDelay * 1000, // Convert to milliseconds
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        }
      });

      this.logger.info(`📋 Post-processing job queued: ${job.id}`, {
        callSid: recordingData.call_sid,
        delay: this.config.postProcessingDelay
      });

      return { success: true, jobId: job.id };

    } catch (error) {
      this.logger.error('❌ Failed to queue post-processing job:', error);
      throw error;
    }
  }

  async processRecording(jobData) {
    const startTime = Date.now();
    this.logger.info('🎬 Starting post-processing for call:', {
      callSid: jobData.call_sid,
      recordingUrl: jobData.recording_url
    });

    try {
      // Step 1: Download recording file
      const audioFilePath = await this.downloadRecording(jobData);
      
      // Step 2: Process with Google Speech-to-Text
      const transcriptionResult = await this.transcribeAudio(audioFilePath, jobData);
      
      // Step 3: Save to database
      const transcriptId = await this.saveTranscription(jobData, transcriptionResult);
      
      // Step 4: Cleanup temporary file
      await this.cleanupFile(audioFilePath);
      
      const duration = Date.now() - startTime;
      
      this.logger.info('✅ Post-processing completed:', {
        callSid: jobData.call_sid,
        transcriptId,
        duration: `${duration}ms`,
        segments: transcriptionResult.segments?.length || 0,
        accuracy: transcriptionResult.averageConfidence
      });

      return {
        success: true,
        transcriptId,
        duration,
        segments: transcriptionResult.segments?.length || 0,
        averageConfidence: transcriptionResult.averageConfidence
      };

    } catch (error) {
      this.logger.error('❌ Post-processing failed:', {
        callSid: jobData.call_sid,
        error: error.message
      });
      throw error;
    }
  }

  async downloadRecording(jobData) {
    const fileName = `${jobData.call_sid}_${Date.now()}.wav`;
    const filePath = path.join(this.config.recordingPath, fileName);
    
    this.logger.info('⬇️ Downloading recording:', {
      url: jobData.recording_url,
      filePath
    });

    try {
      // For now, simulate download - in production you'd use fetch/axios
      // const response = await fetch(jobData.recording_url);
      // const buffer = await response.buffer();
      // await fs.writeFile(filePath, buffer);
      
      // Simulate file creation for testing
      await fs.writeFile(filePath, 'dummy audio data');
      
      return filePath;
      
    } catch (error) {
      this.logger.error('❌ Failed to download recording:', error);
      throw new Error(`Recording download failed: ${error.message}`);
    }
  }

  async transcribeAudio(audioFilePath, jobData) {
    this.logger.info('🎤 Starting batch transcription:', {
      filePath: audioFilePath,
      callSid: jobData.call_sid
    });

    try {
      // For now, simulate transcription - in production you'd use actual Google Speech API
      const mockTranscription = {
        segments: [
          {
            text: 'আসসালামু আলাইকুম স্যার, আমি রকমারি ডট কম থেকে রাকিব বলছি।',
            speaker: 'agent',
            startTime: 0.0,
            endTime: 4.2,
            confidence: 0.95,
            words: [
              { word: 'আসসালামু', startTime: 0.0, endTime: 0.8, confidence: 0.98 },
              { word: 'আলাইকুম', startTime: 0.8, endTime: 1.4, confidence: 0.97 },
              { word: 'স্যার', startTime: 1.4, endTime: 1.8, confidence: 0.96 }
            ]
          },
          {
            text: 'কনফার্ম',
            speaker: 'customer',
            startTime: 20.5,
            endTime: 21.2,
            confidence: 0.89,
            words: [
              { word: 'কনফার্ম', startTime: 20.5, endTime: 21.2, confidence: 0.89 }
            ]
          }
        ],
        averageConfidence: 0.92,
        language: 'bn-BD',
        duration: jobData.duration || 25.0
      };

      return mockTranscription;

    } catch (error) {
      this.logger.error('❌ Transcription failed:', error);
      throw new Error(`Transcription failed: ${error.message}`);
    }
  }

  async saveTranscription(jobData, transcriptionResult) {
    this.logger.info('💾 Saving post-processed transcript:', {
      callSid: jobData.call_sid,
      segments: transcriptionResult.segments?.length || 0
    });

    try {
      // Save main transcript record
      const transcriptData = {
        call_sid: jobData.call_sid,
        transcript_type: 'post_processed',
        language: transcriptionResult.language,
        duration: transcriptionResult.duration,
        average_confidence: transcriptionResult.averageConfidence,
        segment_count: transcriptionResult.segments?.length || 0,
        processing_method: 'google_batch',
        created_at: new Date()
      };

      const transcriptResult = await this.db.insertTranscript(transcriptData);
      const transcriptId = transcriptResult.insertId;

      // Save individual segments
      for (const segment of transcriptionResult.segments || []) {
        const segmentData = {
          transcript_id: transcriptId,
          call_sid: jobData.call_sid,
          segment_type: 'speech',
          speaker: segment.speaker,
          text: segment.text,
          start_time: segment.startTime,
          end_time: segment.endTime,
          confidence: segment.confidence,
          language: transcriptionResult.language,
          vendor: 'google',
          processing_type: 'batch',
          word_count: segment.words?.length || 0,
          created_at: new Date()
        };

        await this.db.insertTranscriptSegment(segmentData);

        // Save word-level timestamps if available
        if (segment.words) {
          for (const word of segment.words) {
            const wordData = {
              transcript_id: transcriptId,
              call_sid: jobData.call_sid,
              segment_id: segmentData.id,
              word: word.word,
              start_time: word.startTime,
              end_time: word.endTime,
              confidence: word.confidence,
              speaker: segment.speaker
            };

            await this.db.insertWordTimestamp(wordData);
          }
        }
      }

      return transcriptId;

    } catch (error) {
      this.logger.error('❌ Failed to save transcription:', error);
      throw error;
    }
  }

  async cleanupFile(filePath) {
    try {
      await fs.unlink(filePath);
      this.logger.debug('🗑️ Cleaned up temporary file:', filePath);
    } catch (error) {
      this.logger.warn('⚠️ Failed to cleanup file:', { filePath, error: error.message });
    }
  }

  setupPeriodicCleanup() {
    // Clean up old recording files every hour
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupOldFiles();
      } catch (error) {
        this.logger.error('❌ Periodic cleanup failed:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  async cleanupOldFiles() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    try {
      const files = await fs.readdir(this.config.recordingPath);
      
      for (const file of files) {
        const filePath = path.join(this.config.recordingPath, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          await fs.unlink(filePath);
          this.logger.debug('🗑️ Cleaned up old file:', file);
        }
      }
      
    } catch (error) {
      this.logger.error('❌ Cleanup failed:', error);
    }
  }

  // Get processing statistics
  async getStats() {
    try {
      const waiting = await this.postProcessQueue.getWaiting();
      const active = await this.postProcessQueue.getActive();
      const completed = await this.postProcessQueue.getCompleted();
      const failed = await this.postProcessQueue.getFailed();

      return {
        queue: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length
        },
        isRunning: this.isRunning
      };
    } catch (error) {
      this.logger.error('❌ Failed to get stats:', error);
      return { error: error.message };
    }
  }
}

module.exports = PostProcessingService;
