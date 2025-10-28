/**
 * Transcript Processor
 * 
 * Processes transcript events from FreeSWITCH and manages:
 * - Real-time transcript storage
 * - Background job queuing
 * - Batch processing for recordings
 * - Performance optimization with Bull queues
 */

const Bull = require('bull');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

class TranscriptProcessor {
  constructor(logger, databaseManager) {
    this.logger = logger;
    this.db = databaseManager;
    
    // Bull queues for async processing
    this.queues = {};
    this.isInitialized = false;
    
    // In-memory cache for active calls
    this.activeCallTranscripts = new Map();
    
    // Performance tracking
    this.processedEvents = 0;
    this.lastPerformanceReport = Date.now();
  }

  async initialize() {
    try {
      this.logger.info('🔄 Initializing Transcript Processor...');

      // Initialize Redis connection for Bull queues
      const redisConfig = {
        host: process.env.REDIS_HOST || '172.10.0.3',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB) || 2
      };

      // Create processing queues
      this.queues.tts = new Bull('tts-processing', { redis: redisConfig });
      this.queues.stt = new Bull('stt-processing', { redis: redisConfig });
      this.queues.audio = new Bull('audio-processing', { redis: redisConfig });
      this.queues.recording = new Bull('recording-processing', { redis: redisConfig });
      this.queues.batch = new Bull('batch-processing', { redis: redisConfig });

      // Setup queue processors
      this.setupQueueProcessors();
      
      // Setup queue monitoring
      this.setupQueueMonitoring();

      this.isInitialized = true;
      this.logger.info('✅ Transcript Processor initialized');

    } catch (error) {
      this.logger.error('❌ Failed to initialize Transcript Processor:', error);
      throw error;
    }
  }

  setupQueueProcessors() {
    const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_JOBS) || 5;

    // TTS event processor
    this.queues.tts.process('tts-event', maxConcurrency, async (job) => {
      return await this.processTTSJob(job.data);
    });

    // STT event processor
    this.queues.stt.process('stt-event', maxConcurrency, async (job) => {
      return await this.processSTTJob(job.data);
    });

    // Audio event processor
    this.queues.audio.process('audio-event', maxConcurrency, async (job) => {
      return await this.processAudioJob(job.data);
    });

    // Recording processor (batch STT)
    this.queues.recording.process('recording-batch', 2, async (job) => {
      return await this.processRecordingJob(job.data);
    });

    // Batch operations processor
    this.queues.batch.process('batch-insert', maxConcurrency, async (job) => {
      return await this.processBatchInsert(job.data);
    });
  }

  setupQueueMonitoring() {
    // Monitor queue completion
    Object.entries(this.queues).forEach(([queueName, queue]) => {
      queue.on('completed', (job) => {
        this.logger.debug(`✅ ${queueName} job ${job.id} completed in ${job.finishedOn - job.processedOn}ms`);
      });

      queue.on('failed', (job, err) => {
        this.logger.error(`❌ ${queueName} job ${job.id} failed:`, err);
      });

      queue.on('stalled', (job) => {
        this.logger.warn(`⚠️ ${queueName} job ${job.id} stalled`);
      });
    });
  }

  // Public methods for event processing
  async processTTSEvent(eventData) {
    try {
      // Add to queue for async processing
      await this.queues.tts.add('tts-event', eventData, {
        priority: 10, // High priority for real-time events
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });

      // Also store in memory cache for immediate access
      this.addToCallCache(eventData.callSid, eventData);
      
      this.trackProcessedEvent('TTS');

    } catch (error) {
      this.logger.error('❌ Failed to process TTS event:', error);
    }
  }

  async processSTTEvent(eventData) {
    try {
      // Add to queue for async processing
      await this.queues.stt.add('stt-event', eventData, {
        priority: 10, // High priority for real-time events
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });

      // Also store in memory cache for immediate access
      this.addToCallCache(eventData.callSid, eventData);
      
      this.trackProcessedEvent('STT');

    } catch (error) {
      this.logger.error('❌ Failed to process STT event:', error);
    }
  }

  async processAudioEvent(eventData) {
    try {
      // Add to queue for async processing
      await this.queues.audio.add('audio-event', eventData, {
        priority: 5, // Medium priority
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 }
      });

      this.trackProcessedEvent('AUDIO');

    } catch (error) {
      this.logger.error('❌ Failed to process audio event:', error);
    }
  }

  async processRecordingComplete(recordingData) {
    try {
      // Queue for batch STT processing
      await this.queues.recording.add('recording-batch', recordingData, {
        priority: 3, // Lower priority - not time critical
        attempts: 2,
        delay: 5000, // Wait 5 seconds for file to be fully written
        backoff: { type: 'exponential', delay: 10000 }
      });

      this.trackProcessedEvent('RECORDING');

    } catch (error) {
      this.logger.error('❌ Failed to process recording completion:', error);
    }
  }

  async processCallComplete(callData) {
    try {
      this.logger.info(`📊 Processing call completion: ${callData.callSid}`);

      // Get cached transcript data
      const cachedTranscript = this.activeCallTranscripts.get(callData.callSid);
      
      if (cachedTranscript && cachedTranscript.length > 0) {
        // Batch insert all transcript segments
        await this.queues.batch.add('batch-insert', {
          type: 'call_complete',
          callSid: callData.callSid,
          callData: callData,
          transcriptSegments: cachedTranscript
        }, {
          priority: 8,
          attempts: 3
        });
      }

      // Clean up memory cache
      this.activeCallTranscripts.delete(callData.callSid);
      
      this.trackProcessedEvent('CALL_COMPLETE');

    } catch (error) {
      this.logger.error('❌ Failed to process call completion:', error);
    }
  }

  // Queue job processors
  async processTTSJob(eventData) {
    const startTime = Date.now();
    
    try {
      // Create transcript segment
      const segment = {
        id: uuidv4(),
        call_sid: eventData.callSid,
        segment_type: 'tts',
        text: eventData.text,
        speaker: eventData.speaker || 'agent',
        start_time: eventData.timestamp,
        end_time: null, // Will be updated when TTS completes
        confidence: eventData.confidence || 1.0,
        language: eventData.language || 'bn-IN',
        vendor: eventData.vendor || 'system',
        source_type: 'tts_generated',
        metadata: JSON.stringify({
          voice: eventData.voice,
          vendor: eventData.vendor,
          language: eventData.language
        }),
        created_at: new Date()
      };

      // Store in database
      await this.db.insertTranscriptSegment(segment);
      
      this.logger.debug(`✅ TTS segment stored: ${eventData.callSid}`);
      
      return {
        processed: true,
        segmentId: segment.id,
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      this.logger.error('❌ TTS job processing failed:', error);
      throw error;
    }
  }

  async processSTTJob(eventData) {
    const startTime = Date.now();
    
    try {
      // Create transcript segment
      const segment = {
        id: uuidv4(),
        call_sid: eventData.callSid,
        segment_type: 'stt',
        text: eventData.text,
        speaker: eventData.speaker || 'caller',
        start_time: eventData.timestamp,
        end_time: eventData.timestamp, // STT is instantaneous
        confidence: eventData.confidence || 0.8,
        language: eventData.language || 'bn-BD',
        vendor: eventData.vendor || 'google',
        source_type: 'stt_realtime',
        metadata: JSON.stringify({
          vendor: eventData.vendor,
          language: eventData.language,
          model: 'streaming'
        }),
        created_at: new Date()
      };

      // Store in database
      await this.db.insertTranscriptSegment(segment);
      
      this.logger.debug(`✅ STT segment stored: ${eventData.callSid}`);
      
      return {
        processed: true,
        segmentId: segment.id,
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      this.logger.error('❌ STT job processing failed:', error);
      throw error;
    }
  }

  async processAudioJob(eventData) {
    const startTime = Date.now();

    try {
      // Create audio event record
      const audioEvent = {
        id: uuidv4(),
        call_sid: eventData.callSid,
        event_type: eventData.type,
        file_path: eventData.filePath,
        file_name: eventData.fileName,
        duration: eventData.duration || null,
        timestamp: eventData.timestamp,
        metadata: JSON.stringify({
          speaker: eventData.speaker,
          type: eventData.type
        }),
        created_at: new Date()
      };

      // Store in database
      await this.db.insertAudioEvent(audioEvent);

      this.logger.debug(`✅ Audio event stored: ${eventData.callSid} - ${eventData.type}`);

      return {
        processed: true,
        eventId: audioEvent.id,
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      this.logger.error('❌ Audio job processing failed:', error);
      throw error;
    }
  }

  async processRecordingJob(recordingData) {
    const startTime = Date.now();

    try {
      this.logger.info(`🎙️ Processing recording for batch STT: ${recordingData.callSid}`);

      // Check if Google Cloud Speech is available
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        this.logger.warn('⚠️ Google Cloud credentials not configured, skipping batch STT');
        return { processed: false, reason: 'No Google Cloud credentials' };
      }

      const speech = require('@google-cloud/speech');
      const client = new speech.SpeechClient();
      const fs = require('fs').promises;

      // Check if recording file exists
      try {
        await fs.access(recordingData.recordingPath);
      } catch (error) {
        this.logger.error(`❌ Recording file not found: ${recordingData.recordingPath}`);
        return { processed: false, reason: 'Recording file not found' };
      }

      // Read audio file
      const audioBytes = await fs.readFile(recordingData.recordingPath);

      // Configure STT request for Bengali phone calls
      const request = {
        audio: {
          content: audioBytes.toString('base64')
        },
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 8000,
          languageCode: 'bn-BD',
          model: 'phone_call',
          useEnhanced: true,
          enableWordTimeOffsets: true,
          enableSpeakerDiarization: true,
          diarizationSpeakerCount: 2,
          maxAlternatives: 1,
          profanityFilter: false,
          enableAutomaticPunctuation: true
        }
      };

      // Process with Google STT
      const [response] = await client.recognize(request);

      if (!response.results || response.results.length === 0) {
        this.logger.warn(`⚠️ No speech detected in recording: ${recordingData.callSid}`);
        return { processed: true, segments: 0 };
      }

      // Process results and create enhanced transcript segments
      const segments = [];
      let segmentIndex = 0;

      for (const result of response.results) {
        const alternative = result.alternatives[0];

        if (alternative.transcript && alternative.transcript.trim()) {
          // Determine speaker (simplified - could be enhanced with better diarization)
          const speakerTag = result.speakerTag || (segmentIndex % 2 === 0 ? 1 : 2);
          const speaker = speakerTag === 1 ? 'caller' : 'agent';

          const segment = {
            id: uuidv4(),
            call_sid: recordingData.callSid,
            segment_type: 'stt_batch',
            text: alternative.transcript,
            speaker: speaker,
            start_time: recordingData.timestamp + (alternative.words?.[0]?.startTime?.seconds || 0) * 1000,
            end_time: recordingData.timestamp + (alternative.words?.[alternative.words.length - 1]?.endTime?.seconds || 0) * 1000,
            confidence: alternative.confidence || 0.9,
            language: 'bn-BD',
            vendor: 'google',
            source_type: 'stt_batch',
            metadata: JSON.stringify({
              vendor: 'google',
              model: 'phone_call',
              enhanced: true,
              speakerTag: speakerTag,
              wordCount: alternative.words?.length || 0,
              recordingPath: recordingData.recordingPath,
              recordingDuration: recordingData.duration
            }),
            created_at: new Date()
          };

          segments.push(segment);
          segmentIndex++;
        }
      }

      // Batch insert all segments
      if (segments.length > 0) {
        await this.db.insertTranscriptSegments(segments);
        this.logger.info(`✅ Batch STT completed: ${recordingData.callSid} - ${segments.length} segments`);
      }

      return {
        processed: true,
        segments: segments.length,
        processingTime: Date.now() - startTime,
        recordingDuration: recordingData.duration
      };

    } catch (error) {
      this.logger.error('❌ Recording batch processing failed:', error);
      throw error;
    }
  }

  async processBatchInsert(batchData) {
    const startTime = Date.now();

    try {
      switch (batchData.type) {
        case 'call_complete':
          await this.processBatchCallComplete(batchData);
          break;

        default:
          this.logger.warn(`⚠️ Unknown batch type: ${batchData.type}`);
      }

      return {
        processed: true,
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      this.logger.error('❌ Batch insert processing failed:', error);
      throw error;
    }
  }

  async processBatchCallComplete(batchData) {
    const { callSid, callData, transcriptSegments } = batchData;

    try {
      // Create call transcript record
      const callTranscript = {
        id: uuidv4(),
        call_sid: callSid,
        caller_number: callData.callerNumber,
        destination_number: callData.destinationNumber,
        start_time: new Date(callData.startTime),
        answer_time: callData.answerTime ? new Date(callData.answerTime) : null,
        end_time: new Date(callData.endTime),
        duration: Math.round((callData.endTime - callData.startTime) / 1000),
        hangup_cause: callData.hangupCause,
        total_segments: transcriptSegments.length,
        languages: [...new Set(transcriptSegments.map(s => s.language))].join(','),
        status: 'completed',
        created_at: new Date()
      };

      // Insert call transcript
      await this.db.insertCallTranscript(callTranscript);

      // Batch insert all cached segments
      if (transcriptSegments.length > 0) {
        const segments = transcriptSegments.map(segment => ({
          id: uuidv4(),
          call_transcript_id: callTranscript.id,
          call_sid: callSid,
          segment_type: segment.type === 'tts_start' ? 'tts' : segment.type.replace('_detected', ''),
          text: segment.text,
          speaker: segment.speaker,
          start_time: new Date(segment.timestamp),
          end_time: new Date(segment.timestamp),
          confidence: segment.confidence,
          language: segment.language,
          vendor: segment.vendor,
          source_type: segment.type,
          metadata: JSON.stringify(segment),
          created_at: new Date()
        }));

        await this.db.insertTranscriptSegments(segments);
      }

      this.logger.info(`✅ Call transcript completed: ${callSid} - ${transcriptSegments.length} segments`);

    } catch (error) {
      this.logger.error('❌ Batch call complete processing failed:', error);
      throw error;
    }
  }

  // Utility methods
  addToCallCache(callSid, eventData) {
    if (!this.activeCallTranscripts.has(callSid)) {
      this.activeCallTranscripts.set(callSid, []);
    }
    
    this.activeCallTranscripts.get(callSid).push({
      ...eventData,
      cached_at: Date.now()
    });

    // Limit cache size per call (keep last 100 events)
    const cache = this.activeCallTranscripts.get(callSid);
    if (cache.length > 100) {
      cache.splice(0, cache.length - 100);
    }
  }

  trackProcessedEvent(eventType) {
    this.processedEvents++;
    
    // Report performance every minute
    if (Date.now() - this.lastPerformanceReport > 60000) {
      this.reportPerformance();
      this.lastPerformanceReport = Date.now();
    }
  }

  reportPerformance() {
    const queueStats = {};
    
    Object.entries(this.queues).forEach(([name, queue]) => {
      queueStats[name] = {
        waiting: queue.waiting,
        active: queue.active,
        completed: queue.completed,
        failed: queue.failed
      };
    });

    this.logger.info(`📊 Transcript Processor Performance:`, {
      processedEvents: this.processedEvents,
      activeCalls: this.activeCallTranscripts.size,
      queueStats: queueStats
    });

    // Reset counter
    this.processedEvents = 0;
  }

  isRedisConnected() {
    return this.isInitialized && Object.keys(this.queues).length > 0;
  }

  async shutdown() {
    this.logger.info('🛑 Shutting down Transcript Processor...');
    
    // Close all queues
    for (const [name, queue] of Object.entries(this.queues)) {
      await queue.close();
      this.logger.info(`✅ ${name} queue closed`);
    }
    
    // Clear memory cache
    this.activeCallTranscripts.clear();
    
    this.logger.info('✅ Transcript Processor shutdown complete');
  }

  getStats() {
    const queueStats = {};
    
    Object.entries(this.queues).forEach(([name, queue]) => {
      queueStats[name] = {
        waiting: queue.waiting || 0,
        active: queue.active || 0,
        completed: queue.completed || 0,
        failed: queue.failed || 0
      };
    });

    return {
      isInitialized: this.isInitialized,
      activeCalls: this.activeCallTranscripts.size,
      processedEvents: this.processedEvents,
      queueStats: queueStats
    };
  }
}

module.exports = TranscriptProcessor;
