const express = require('express');
const pino = require('pino');

const router = express.Router();
const logger = pino({ name: 'WebhookRoutes' });

// Middleware to log all webhook requests
router.use((req, res, next) => {
  logger.info('🔗 Webhook request received:', {
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body,
    query: req.query,
    ip: req.ip
  });
  next();
});

// Recording completion webhook
router.post('/recording-complete', async (req, res) => {
  try {
    const recordingData = req.body;
    
    logger.info('🎙️ Recording completion webhook received:', {
      callSid: recordingData.call_sid,
      recordingUrl: recordingData.recording_url,
      duration: recordingData.duration,
      from: recordingData.from,
      to: recordingData.to
    });

    // Validate required fields
    if (!recordingData.call_sid || !recordingData.recording_url) {
      logger.error('❌ Invalid recording data - missing required fields');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: call_sid, recording_url'
      });
    }

    // Get post-processing service from app context
    const postProcessingService = req.app.get('postProcessingService');
    
    if (!postProcessingService) {
      logger.error('❌ Post-processing service not available');
      return res.status(503).json({
        success: false,
        error: 'Post-processing service not available'
      });
    }

    // Queue the recording for post-processing
    const result = await postProcessingService.handleRecordingComplete(recordingData);
    
    logger.info('✅ Recording queued for post-processing:', {
      callSid: recordingData.call_sid,
      jobId: result.jobId
    });

    res.json({
      success: true,
      message: 'Recording queued for post-processing',
      jobId: result.jobId,
      callSid: recordingData.call_sid
    });

  } catch (error) {
    logger.error('❌ Recording webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Call status webhook (for monitoring)
router.post('/call-status', async (req, res) => {
  try {
    const callData = req.body;
    
    logger.info('📞 Call status webhook received:', {
      callSid: callData.call_sid,
      callStatus: callData.call_status,
      direction: callData.direction,
      from: callData.from,
      to: callData.to,
      duration: callData.duration
    });

    // If call is completed and has recording, we might trigger post-processing
    if (callData.call_status === 'completed' && callData.recording_url) {
      logger.info('🎬 Call completed with recording, triggering post-processing');
      
      const postProcessingService = req.app.get('postProcessingService');
      if (postProcessingService) {
        await postProcessingService.handleRecordingComplete({
          call_sid: callData.call_sid,
          recording_url: callData.recording_url,
          duration: callData.duration,
          from: callData.from,
          to: callData.to,
          account_sid: callData.account_sid
        });
      }
    }

    res.json({
      success: true,
      message: 'Call status processed',
      callSid: callData.call_sid,
      status: callData.call_status
    });

  } catch (error) {
    logger.error('❌ Call status webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Transcript webhook (for real-time transcripts from Jambonz)
router.post('/transcript', async (req, res) => {
  try {
    const transcriptData = req.body;
    
    logger.info('📝 Real-time transcript webhook received:', {
      callSid: transcriptData.call_sid,
      reason: transcriptData.reason,
      hasTranscript: !!transcriptData.speech?.alternatives?.[0]?.transcript
    });

    // Process real-time transcript
    if (transcriptData.speech?.alternatives?.[0]?.transcript) {
      const transcript = transcriptData.speech.alternatives[0].transcript;
      const confidence = transcriptData.speech.alternatives[0].confidence;
      
      logger.info('🎤 Real-time transcript captured:', {
        callSid: transcriptData.call_sid,
        transcript: transcript,
        confidence: confidence,
        language: transcriptData.speech.language_code,
        vendor: transcriptData.speech.vendor?.name
      });

      // Get transcript processor from app context
      const transcriptProcessor = req.app.get('transcriptProcessor');
      
      if (transcriptProcessor) {
        // Process the real-time transcript
        await transcriptProcessor.processSTTEvent({
          call_sid: transcriptData.call_sid,
          text: transcript,
          confidence: confidence,
          language: transcriptData.speech.language_code,
          vendor: transcriptData.speech.vendor?.name || 'google',
          is_final: transcriptData.speech.is_final,
          timestamp: new Date().toISOString()
        });
      }
    }

    res.json({
      success: true,
      message: 'Transcript processed',
      callSid: transcriptData.call_sid
    });

  } catch (error) {
    logger.error('❌ Transcript webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check for webhooks
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'transcript-listener-webhooks',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /webhooks/recording-complete',
      'POST /webhooks/call-status', 
      'POST /webhooks/transcript',
      'GET /webhooks/health'
    ]
  });
});

// Test endpoint for development
router.post('/test-recording', async (req, res) => {
  try {
    logger.info('🧪 Test recording webhook triggered');
    
    const testData = {
      call_sid: req.body.call_sid || 'test-call-' + Date.now(),
      recording_url: req.body.recording_url || 'https://example.com/test-recording.wav',
      duration: req.body.duration || 25.5,
      from: req.body.from || '01521206630',
      to: req.body.to || '01757158044',
      account_sid: req.body.account_sid || 'test-account'
    };

    const postProcessingService = req.app.get('postProcessingService');
    
    if (postProcessingService) {
      const result = await postProcessingService.handleRecordingComplete(testData);
      
      res.json({
        success: true,
        message: 'Test recording queued for post-processing',
        jobId: result.jobId,
        testData
      });
    } else {
      res.status(503).json({
        success: false,
        error: 'Post-processing service not available'
      });
    }

  } catch (error) {
    logger.error('❌ Test recording webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
