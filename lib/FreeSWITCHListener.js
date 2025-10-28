/**
 * FreeSWITCH Event Socket Listener
 * 
 * Connects to FreeSWITCH Event Socket and listens for audio-related events:
 * - TTS events (CHANNEL_EXECUTE with 'speak' application)
 * - STT events (DETECTED_SPEECH)
 * - Audio playback events (PLAYBACK_START, PLAYBACK_STOP)
 * - Recording events (RECORD_START, RECORD_STOP)
 * - Call lifecycle events (CHANNEL_CREATE, CHANNEL_ANSWER, CHANNEL_HANGUP)
 * 
 * Zero impact on call performance - events are generated asynchronously
 */

const ESL = require('modesl');
const { EventEmitter } = require('events');

class FreeSWITCHListener extends EventEmitter {
  constructor(logger, transcriptProcessor, performanceMonitor, broadcastCallback) {
    super();
    
    this.logger = logger;
    this.transcriptProcessor = transcriptProcessor;
    this.performanceMonitor = performanceMonitor;
    this.broadcastCallback = broadcastCallback;
    
    this.connection = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
    this.reconnectDelay = parseInt(process.env.RECONNECT_DELAY) || 5000;
    
    // Event counters for monitoring
    this.eventCounts = new Map();
    this.lastStatsReport = Date.now();
    
    // Active calls tracking
    this.activeCalls = new Map();
  }

  async connect() {
    try {
      const host = process.env.FREESWITCH_HOST || '172.10.0.51';
      const port = parseInt(process.env.FREESWITCH_PORT) || 8021;
      const password = process.env.FREESWITCH_PASSWORD || 'JambonzR0ck$$';

      this.logger.info(`🔌 Connecting to FreeSWITCH Event Socket: ${host}:${port}`);

      this.connection = new ESL.Connection(host, port, password);
      
      this.setupEventHandlers();
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        this.connection.on('esl::ready', () => {
          clearTimeout(timeout);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          this.logger.info('✅ Connected to FreeSWITCH Event Socket');
          this.subscribeToEvents();
          resolve();
        });

        this.connection.on('error', (error) => {
          clearTimeout(timeout);
          this.logger.error('❌ FreeSWITCH connection error:', error);
          reject(error);
        });
      });

    } catch (error) {
      this.logger.error('❌ Failed to connect to FreeSWITCH:', error);
      throw error;
    }
  }

  setupEventHandlers() {
    // Connection events
    this.connection.on('esl::ready', () => {
      this.logger.info('🎯 FreeSWITCH Event Socket ready');
      this.isConnected = true;
    });

    this.connection.on('esl::end', () => {
      this.logger.warn('🔌 FreeSWITCH connection ended');
      this.isConnected = false;
      this.handleDisconnection();
    });

    this.connection.on('error', (error) => {
      this.logger.error('❌ FreeSWITCH connection error:', error);
      this.isConnected = false;
      this.handleDisconnection();
    });

    // Call lifecycle events
    this.connection.on('esl::event::CHANNEL_CREATE', (event) => {
      this.handleChannelCreate(event);
    });

    this.connection.on('esl::event::CHANNEL_ANSWER', (event) => {
      this.handleChannelAnswer(event);
    });

    this.connection.on('esl::event::CHANNEL_HANGUP', (event) => {
      this.handleChannelHangup(event);
    });

    // TTS events
    this.connection.on('esl::event::CHANNEL_EXECUTE', (event) => {
      this.handleChannelExecute(event);
    });

    this.connection.on('esl::event::CHANNEL_EXECUTE_COMPLETE', (event) => {
      this.handleChannelExecuteComplete(event);
    });

    // STT events
    this.connection.on('esl::event::DETECTED_SPEECH', (event) => {
      this.handleDetectedSpeech(event);
    });

    // Audio playback events
    this.connection.on('esl::event::PLAYBACK_START', (event) => {
      this.handlePlaybackStart(event);
    });

    this.connection.on('esl::event::PLAYBACK_STOP', (event) => {
      this.handlePlaybackStop(event);
    });

    // Recording events
    this.connection.on('esl::event::RECORD_START', (event) => {
      this.handleRecordStart(event);
    });

    this.connection.on('esl::event::RECORD_STOP', (event) => {
      this.handleRecordStop(event);
    });
  }

  subscribeToEvents() {
    const events = [
      'CHANNEL_CREATE',
      'CHANNEL_ANSWER',
      'CHANNEL_HANGUP',
      'CHANNEL_EXECUTE',
      'CHANNEL_EXECUTE_COMPLETE',
      'DETECTED_SPEECH',
      'PLAYBACK_START',
      'PLAYBACK_STOP',
      'RECORD_START',
      'RECORD_STOP'
    ];

    this.logger.info(`📡 Subscribing to FreeSWITCH events: ${events.join(', ')}`);
    
    this.connection.subscribe(events);
    
    this.logger.info('✅ Successfully subscribed to FreeSWITCH events');
  }

  // Event handlers
  handleChannelCreate(event) {
    const callSid = this.extractCallSid(event);
    const callerNumber = event.getHeader('Caller-Caller-ID-Number');
    const destinationNumber = event.getHeader('Caller-Destination-Number');
    
    if (callSid) {
      this.activeCalls.set(callSid, {
        callSid: callSid,
        callerNumber: callerNumber,
        destinationNumber: destinationNumber,
        startTime: Date.now(),
        events: []
      });
      
      this.logger.info(`📞 Call created: ${callSid} (${callerNumber} → ${destinationNumber})`);
      this.trackEvent('CHANNEL_CREATE');
    }
  }

  handleChannelAnswer(event) {
    const callSid = this.extractCallSid(event);
    
    if (callSid && this.activeCalls.has(callSid)) {
      const call = this.activeCalls.get(callSid);
      call.answerTime = Date.now();
      
      this.logger.info(`📞 Call answered: ${callSid}`);
      this.trackEvent('CHANNEL_ANSWER');
    }
  }

  handleChannelHangup(event) {
    const callSid = this.extractCallSid(event);
    const hangupCause = event.getHeader('Hangup-Cause');
    
    if (callSid && this.activeCalls.has(callSid)) {
      const call = this.activeCalls.get(callSid);
      call.endTime = Date.now();
      call.hangupCause = hangupCause;
      
      this.logger.info(`📞 Call ended: ${callSid} (${hangupCause})`);
      
      // Process final call data
      this.processCallComplete(call);
      
      // Clean up
      this.activeCalls.delete(callSid);
      this.trackEvent('CHANNEL_HANGUP');
    }
  }

  handleChannelExecute(event) {
    const startTime = Date.now();
    const application = event.getHeader('Application');
    const applicationData = event.getHeader('Application-Data');
    const callSid = this.extractCallSid(event);

    // Track TTS events
    if (application === 'speak' && applicationData && callSid) {
      this.logger.info(`🗣️ TTS Started: ${callSid} - "${this.truncateText(applicationData)}"`);
      
      const ttsData = {
        type: 'tts_start',
        callSid: callSid,
        text: applicationData,
        speaker: 'agent',
        timestamp: Date.now(),
        confidence: 1.0,
        vendor: 'system',
        language: this.extractLanguage(applicationData) || 'bn-IN'
      };

      // Process TTS event
      this.transcriptProcessor.processTTSEvent(ttsData);
      
      // Broadcast to WebSocket clients
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, ttsData);
      }
      
      this.trackEvent('TTS_START');
    }

    // Track other applications
    if (callSid) {
      this.addCallEvent(callSid, {
        type: 'execute',
        application: application,
        data: applicationData,
        timestamp: Date.now()
      });
    }

    this.performanceMonitor?.trackEventProcessing('CHANNEL_EXECUTE', Date.now() - startTime);
  }

  handleChannelExecuteComplete(event) {
    const application = event.getHeader('Application');
    const callSid = this.extractCallSid(event);

    if (application === 'speak' && callSid) {
      this.logger.info(`✅ TTS Completed: ${callSid}`);
      
      const ttsCompleteData = {
        type: 'tts_complete',
        callSid: callSid,
        timestamp: Date.now()
      };

      // Broadcast completion
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, ttsCompleteData);
      }
      
      this.trackEvent('TTS_COMPLETE');
    }
  }

  handleDetectedSpeech(event) {
    const startTime = Date.now();
    const speechResult = event.getHeader('Speech-Result');
    const confidence = event.getHeader('Speech-Confidence');
    const callSid = this.extractCallSid(event);

    if (speechResult && callSid) {
      this.logger.info(`🎤 STT Detected: ${callSid} - "${this.truncateText(speechResult)}" (${confidence})`);
      
      const sttData = {
        type: 'stt_detected',
        callSid: callSid,
        text: speechResult,
        speaker: 'caller',
        timestamp: Date.now(),
        confidence: parseFloat(confidence) || 0.8,
        vendor: 'google',
        language: 'bn-BD'
      };

      // Process STT event
      this.transcriptProcessor.processSTTEvent(sttData);
      
      // Broadcast to WebSocket clients
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, sttData);
      }
      
      this.trackEvent('STT_DETECTED');
    }

    this.performanceMonitor?.trackEventProcessing('DETECTED_SPEECH', Date.now() - startTime);
  }

  handlePlaybackStart(event) {
    const startTime = Date.now();
    const playbackFile = event.getHeader('Playback-File-Path');
    const callSid = this.extractCallSid(event);

    if (playbackFile && callSid) {
      this.logger.info(`🎵 Audio playback started: ${callSid} - ${this.getFileName(playbackFile)}`);

      const audioData = {
        type: 'audio_start',
        callSid: callSid,
        filePath: playbackFile,
        fileName: this.getFileName(playbackFile),
        speaker: 'agent',
        timestamp: Date.now()
      };

      // Process audio playback event
      this.transcriptProcessor.processAudioEvent(audioData);

      // Broadcast to WebSocket clients
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, audioData);
      }

      this.trackEvent('AUDIO_START');
    }

    this.performanceMonitor?.trackEventProcessing('PLAYBACK_START', Date.now() - startTime);
  }

  handlePlaybackStop(event) {
    const playbackFile = event.getHeader('Playback-File-Path');
    const playbackSeconds = event.getHeader('variable_playback_seconds');
    const callSid = this.extractCallSid(event);

    if (playbackFile && callSid) {
      this.logger.info(`✅ Audio playback completed: ${callSid} - ${this.getFileName(playbackFile)} (${playbackSeconds}s)`);

      const audioCompleteData = {
        type: 'audio_complete',
        callSid: callSid,
        filePath: playbackFile,
        fileName: this.getFileName(playbackFile),
        duration: parseFloat(playbackSeconds) || 0,
        timestamp: Date.now()
      };

      // Broadcast completion
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, audioCompleteData);
      }

      this.trackEvent('AUDIO_COMPLETE');
    }
  }

  handleRecordStart(event) {
    const recordingPath = event.getHeader('Record-File-Path');
    const callSid = this.extractCallSid(event);

    if (recordingPath && callSid) {
      this.logger.info(`🎙️ Recording started: ${callSid} - ${recordingPath}`);

      const recordingData = {
        type: 'recording_start',
        callSid: callSid,
        recordingPath: recordingPath,
        timestamp: Date.now()
      };

      // Add to call data
      this.addCallEvent(callSid, recordingData);

      // Broadcast to WebSocket clients
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, recordingData);
      }

      this.trackEvent('RECORDING_START');
    }
  }

  handleRecordStop(event) {
    const startTime = Date.now();
    const recordingPath = event.getHeader('Record-File-Path');
    const recordingSeconds = event.getHeader('variable_record_seconds');
    const callSid = this.extractCallSid(event);

    if (recordingPath && callSid) {
      this.logger.info(`📁 Recording completed: ${callSid} - ${recordingPath} (${recordingSeconds}s)`);

      const recordingData = {
        type: 'recording_complete',
        callSid: callSid,
        recordingPath: recordingPath,
        duration: parseFloat(recordingSeconds) || 0,
        timestamp: Date.now()
      };

      // Process recording for batch transcription
      this.transcriptProcessor.processRecordingComplete(recordingData);

      // Broadcast to WebSocket clients
      if (this.broadcastCallback) {
        this.broadcastCallback(callSid, recordingData);
      }

      this.trackEvent('RECORDING_COMPLETE');
    }

    this.performanceMonitor?.trackEventProcessing('RECORD_STOP', Date.now() - startTime);
  }

  // Utility methods
  extractCallSid(event) {
    return event.getHeader('variable_call_sid') || 
           event.getHeader('Unique-ID') ||
           event.getHeader('Core-UUID');
  }

  extractLanguage(text) {
    // Simple Bengali detection
    if (/[\u0980-\u09FF]/.test(text)) {
      return 'bn-IN';
    }
    return null;
  }

  truncateText(text, maxLength = 50) {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  getFileName(filePath) {
    if (!filePath) return '';
    return filePath.split('/').pop() || filePath;
  }

  trackEvent(eventType) {
    const count = this.eventCounts.get(eventType) || 0;
    this.eventCounts.set(eventType, count + 1);
    
    // Report stats every minute
    if (Date.now() - this.lastStatsReport > 60000) {
      this.reportStats();
      this.lastStatsReport = Date.now();
    }
  }

  addCallEvent(callSid, eventData) {
    if (this.activeCalls.has(callSid)) {
      const call = this.activeCalls.get(callSid);
      call.events.push(eventData);
    }
  }

  async processCallComplete(call) {
    this.logger.info(`📊 Processing completed call: ${call.callSid}`);
    
    // Send call completion data to transcript processor
    await this.transcriptProcessor.processCallComplete(call);
  }

  reportStats() {
    const stats = Object.fromEntries(this.eventCounts);
    const totalEvents = Array.from(this.eventCounts.values()).reduce((a, b) => a + b, 0);
    
    this.logger.info(`📊 Event stats (last minute): Total=${totalEvents}`, stats);
    
    // Reset counters
    this.eventCounts.clear();
  }

  async handleDisconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.emit('max_reconnects_reached');
      return;
    }

    this.reconnectAttempts++;
    this.logger.warn(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(async () => {
      try {
        await this.connect();
        this.logger.info('✅ Reconnected to FreeSWITCH');
      } catch (error) {
        this.logger.error('❌ Reconnection failed:', error);
        this.handleDisconnection();
      }
    }, this.reconnectDelay);
  }

  isConnected() {
    return this.isConnected && this.connection;
  }

  async disconnect() {
    if (this.connection) {
      this.logger.info('🔌 Disconnecting from FreeSWITCH...');
      this.connection.disconnect();
      this.isConnected = false;
    }
  }

  getStats() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      activeCalls: this.activeCalls.size,
      eventCounts: Object.fromEntries(this.eventCounts)
    };
  }
}

module.exports = FreeSWITCHListener;
