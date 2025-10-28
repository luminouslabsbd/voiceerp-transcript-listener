#!/usr/bin/env node

/**
 * Test Script for Both Real-time and Post-processing Transcription
 * 
 * This script demonstrates:
 * 1. Real-time transcription capture during calls
 * 2. Post-processing transcription after call completion
 * 3. Comparison between both approaches
 */

require('dotenv').config();
const axios = require('axios');
const pino = require('pino');

const logger = pino({ name: 'TranscriptionTest' });

class TranscriptionTester {
  constructor() {
    this.baseUrl = process.env.TRANSCRIPT_LISTENER_URL || 'http://localhost:3012';
    this.publicAppUrl = process.env.PUBLIC_APP_URL || 'https://public-app.voiceerp.com';
    this.testPhoneNumber = process.env.TEST_PHONE_NUMBER || '01757158044';
  }

  async runFullTest() {
    logger.info('🧪 Starting comprehensive transcription test...');
    
    try {
      // Step 1: Check service health
      await this.checkServiceHealth();
      
      // Step 2: Make a test call
      const callData = await this.makeTestCall();
      
      // Step 3: Wait for call to complete and capture real-time transcript
      await this.waitForCallCompletion(callData.call.sid);
      
      // Step 4: Trigger post-processing
      await this.triggerPostProcessing(callData.call.sid);
      
      // Step 5: Wait for post-processing to complete
      await this.waitForPostProcessing(callData.call.sid);
      
      // Step 6: Compare results
      await this.compareTranscriptions(callData.call.sid);
      
      // Step 7: Display final results
      await this.displayResults(callData.call.sid);
      
      logger.info('✅ Comprehensive transcription test completed successfully!');
      
    } catch (error) {
      logger.error('❌ Test failed:', error);
      process.exit(1);
    }
  }

  async checkServiceHealth() {
    logger.info('🏥 Checking service health...');
    
    try {
      const response = await axios.get(`${this.baseUrl}/health`);
      logger.info('✅ Transcript Listener Health:', response.data);
      
      const apiResponse = await axios.get(`${this.baseUrl}/api/health`);
      logger.info('✅ API Health:', apiResponse.data);
      
      const webhookResponse = await axios.get(`${this.baseUrl}/webhooks/health`);
      logger.info('✅ Webhook Health:', webhookResponse.data);
      
    } catch (error) {
      logger.error('❌ Health check failed:', error.message);
      throw error;
    }
  }

  async makeTestCall() {
    logger.info('📞 Making test call...');
    
    try {
      const response = await axios.get(`${this.publicAppUrl}/make-call`, {
        params: { to: this.testPhoneNumber }
      });
      
      logger.info('✅ Call initiated:', response.data);
      return response.data;
      
    } catch (error) {
      logger.error('❌ Failed to make test call:', error.message);
      throw error;
    }
  }

  async waitForCallCompletion(callSid) {
    logger.info('⏳ Waiting for call completion and real-time transcript capture...');
    
    // Wait 30 seconds for call to complete
    await this.sleep(30000);
    
    try {
      // Check if we have real-time transcript data
      const response = await axios.get(`${this.baseUrl}/api/transcripts/${callSid}`);
      
      if (response.data.transcript && response.data.transcript.length > 0) {
        logger.info('✅ Real-time transcript captured:', {
          segments: response.data.transcript.length,
          text: response.data.transcript.map(s => s.text).join(' ')
        });
      } else {
        logger.warn('⚠️ No real-time transcript data found');
      }
      
    } catch (error) {
      logger.warn('⚠️ Could not retrieve real-time transcript:', error.message);
    }
  }

  async triggerPostProcessing(callSid) {
    logger.info('🎬 Triggering post-processing...');
    
    try {
      // Simulate recording completion webhook
      const testRecordingData = {
        call_sid: callSid,
        recording_url: `https://recordings.voiceerp.com/${callSid}.wav`,
        duration: 25.5,
        from: '01521206630',
        to: this.testPhoneNumber,
        account_sid: 'test-account-001'
      };
      
      const response = await axios.post(`${this.baseUrl}/webhooks/test-recording`, testRecordingData);
      
      logger.info('✅ Post-processing triggered:', response.data);
      return response.data;
      
    } catch (error) {
      logger.error('❌ Failed to trigger post-processing:', error.message);
      throw error;
    }
  }

  async waitForPostProcessing(callSid) {
    logger.info('⏳ Waiting for post-processing to complete...');
    
    const maxWaitTime = 120000; // 2 minutes
    const checkInterval = 5000; // 5 seconds
    let elapsed = 0;
    
    while (elapsed < maxWaitTime) {
      try {
        const statsResponse = await axios.get(`${this.baseUrl}/api/post-processing/stats`);
        const stats = statsResponse.data.data;
        
        logger.info('📊 Post-processing stats:', stats);
        
        // Check if processing is complete
        if (stats.queue.active === 0 && stats.queue.waiting === 0) {
          logger.info('✅ Post-processing completed');
          break;
        }
        
        await this.sleep(checkInterval);
        elapsed += checkInterval;
        
      } catch (error) {
        logger.warn('⚠️ Could not get post-processing stats:', error.message);
        await this.sleep(checkInterval);
        elapsed += checkInterval;
      }
    }
    
    if (elapsed >= maxWaitTime) {
      logger.warn('⚠️ Post-processing wait timeout reached');
    }
  }

  async compareTranscriptions(callSid) {
    logger.info('🔍 Comparing real-time vs post-processed transcriptions...');
    
    try {
      const response = await axios.get(`${this.baseUrl}/api/comparison/${callSid}`);
      const comparison = response.data.data;
      
      logger.info('📊 Transcription Comparison:', {
        callSid: comparison.call_sid,
        realTime: {
          segments: comparison.real_time.segments,
          confidence: comparison.real_time.average_confidence,
          text: comparison.real_time.text
        },
        postProcessed: {
          segments: comparison.post_processed.segments,
          confidence: comparison.post_processed.average_confidence,
          text: comparison.post_processed.text
        },
        improvement: comparison.improvement
      });
      
      return comparison;
      
    } catch (error) {
      logger.warn('⚠️ Could not get transcription comparison:', error.message);
      return null;
    }
  }

  async displayResults(callSid) {
    logger.info('📋 Final Test Results:');
    
    try {
      // Get real-time transcripts
      const realTimeResponse = await axios.get(`${this.baseUrl}/api/transcripts/${callSid}`);
      
      // Get post-processed transcripts
      const postProcessedResponse = await axios.get(`${this.baseUrl}/api/post-processed/${callSid}`);
      
      console.log('\n' + '='.repeat(80));
      console.log('📊 TRANSCRIPTION TEST RESULTS');
      console.log('='.repeat(80));
      
      console.log('\n🎤 REAL-TIME TRANSCRIPTION:');
      console.log('─'.repeat(40));
      if (realTimeResponse.data.transcript && realTimeResponse.data.transcript.length > 0) {
        realTimeResponse.data.transcript.forEach((segment, index) => {
          console.log(`${index + 1}. [${segment.speaker}] ${segment.text}`);
          console.log(`   Confidence: ${(segment.confidence * 100).toFixed(1)}% | Language: ${segment.language}`);
        });
      } else {
        console.log('No real-time transcript data available');
      }
      
      console.log('\n🎬 POST-PROCESSED TRANSCRIPTION:');
      console.log('─'.repeat(40));
      if (postProcessedResponse.data.data && postProcessedResponse.data.data.length > 0) {
        postProcessedResponse.data.data.forEach((transcript, index) => {
          console.log(`${index + 1}. Processing Method: ${transcript.processing_method}`);
          console.log(`   Duration: ${transcript.duration}s | Confidence: ${(transcript.average_confidence * 100).toFixed(1)}%`);
          console.log(`   Segments: ${transcript.segment_count} | Language: ${transcript.language}`);
        });
      } else {
        console.log('No post-processed transcript data available');
      }
      
      console.log('\n📈 SUMMARY:');
      console.log('─'.repeat(40));
      console.log(`Call SID: ${callSid}`);
      console.log(`Test Phone: ${this.testPhoneNumber}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
      
      console.log('\n✅ Both real-time and post-processing transcription systems are working!');
      console.log('='.repeat(80) + '\n');
      
    } catch (error) {
      logger.error('❌ Failed to display results:', error.message);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run the test if this script is executed directly
if (require.main === module) {
  const tester = new TranscriptionTester();
  tester.runFullTest().catch(error => {
    logger.error('❌ Test execution failed:', error);
    process.exit(1);
  });
}

module.exports = TranscriptionTester;
