#!/usr/bin/env node

const modesl = require('modesl');

console.log('🔌 Testing FreeSWITCH Event Socket Connection...');

const connection = new modesl.Connection('localhost', 8022, 'JambonzR0ck$', () => {
  console.log('✅ Connected to FreeSWITCH Event Socket!');
  
  // Subscribe to events
  connection.events('json', 'ALL', () => {
    console.log('✅ Subscribed to all events');
  });
  
  // Test command
  connection.api('status', (response) => {
    console.log('📊 FreeSWITCH Status:', response.getBody());
  });
});

connection.on('error', (error) => {
  console.error('❌ Connection error:', error);
});

connection.on('esl::event::*', (event) => {
  console.log('📡 Event received:', event.getHeader('Event-Name'));
});

connection.on('esl::end', () => {
  console.log('🔌 Connection ended');
  process.exit(0);
});

// Keep the process alive
setTimeout(() => {
  console.log('⏰ Test timeout - closing connection');
  connection.disconnect();
}, 10000);

console.log('⏳ Waiting for connection...');
