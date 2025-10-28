-- VoiceERP Transcript Listener Database Schema
-- Separate database for transcript storage (independent from main VoiceERP DB)

CREATE DATABASE IF NOT EXISTS voiceerp_transcripts 
CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE voiceerp_transcripts;

-- Call Transcripts Table (Main transcript record for each call)
CREATE TABLE call_transcripts (
    id VARCHAR(36) PRIMARY KEY,
    call_sid VARCHAR(100) NOT NULL UNIQUE,
    caller_number VARCHAR(50),
    destination_number VARCHAR(50),
    start_time DATETIME NOT NULL,
    answer_time DATETIME,
    end_time DATETIME,
    duration INT UNSIGNED, -- Duration in seconds
    hangup_cause VARCHAR(50),
    total_segments INT UNSIGNED DEFAULT 0,
    languages VARCHAR(100), -- Comma-separated list of detected languages
    status ENUM('active', 'completed', 'failed') DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_call_sid (call_sid),
    INDEX idx_start_time (start_time),
    INDEX idx_status (status),
    INDEX idx_caller_number (caller_number),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transcript Segments Table (Individual speech segments)
CREATE TABLE transcript_segments (
    id VARCHAR(36) PRIMARY KEY,
    call_transcript_id VARCHAR(36),
    call_sid VARCHAR(100) NOT NULL,
    segment_type ENUM('tts', 'stt', 'stt_batch', 'audio', 'system') NOT NULL,
    text TEXT NOT NULL,
    speaker ENUM('caller', 'agent', 'system') NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    confidence DECIMAL(3,2) DEFAULT 0.80, -- 0.00 to 1.00
    language VARCHAR(10) DEFAULT 'bn-BD',
    vendor VARCHAR(50), -- google, elevenlabs, system, etc.
    source_type VARCHAR(50), -- tts_generated, stt_realtime, stt_batch, etc.
    metadata JSON, -- Additional metadata (voice, model, etc.)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (call_transcript_id) REFERENCES call_transcripts(id) ON DELETE CASCADE,
    INDEX idx_call_sid (call_sid),
    INDEX idx_call_transcript_id (call_transcript_id),
    INDEX idx_segment_type (segment_type),
    INDEX idx_speaker (speaker),
    INDEX idx_start_time (start_time),
    INDEX idx_source_type (source_type),
    INDEX idx_language (language),
    INDEX idx_created_at (created_at),
    FULLTEXT idx_text_search (text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audio Events Table (Audio file playback events)
CREATE TABLE audio_events (
    id VARCHAR(36) PRIMARY KEY,
    call_sid VARCHAR(100) NOT NULL,
    event_type ENUM('audio_start', 'audio_complete', 'recording_start', 'recording_complete') NOT NULL,
    file_path TEXT,
    file_name VARCHAR(255),
    duration DECIMAL(10,3), -- Duration in seconds with millisecond precision
    timestamp DATETIME NOT NULL,
    metadata JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_call_sid (call_sid),
    INDEX idx_event_type (event_type),
    INDEX idx_timestamp (timestamp),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transcript Jobs Table (Background job tracking)
CREATE TABLE transcript_jobs (
    id VARCHAR(36) PRIMARY KEY,
    call_sid VARCHAR(100) NOT NULL,
    job_type ENUM('tts_processing', 'stt_processing', 'batch_stt', 'call_complete') NOT NULL,
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    priority INT DEFAULT 5,
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    error_message TEXT,
    job_data JSON,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_call_sid (call_sid),
    INDEX idx_job_type (job_type),
    INDEX idx_status (status),
    INDEX idx_priority (priority),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Performance Metrics Table (System performance tracking)
CREATE TABLE performance_metrics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    metric_type VARCHAR(50) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DECIMAL(15,6),
    metric_unit VARCHAR(20),
    timestamp DATETIME NOT NULL,
    metadata JSON,
    
    INDEX idx_metric_type (metric_type),
    INDEX idx_metric_name (metric_name),
    INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System Health Table (Service health monitoring)
CREATE TABLE system_health (
    id INT AUTO_INCREMENT PRIMARY KEY,
    service_name VARCHAR(50) NOT NULL,
    status ENUM('healthy', 'degraded', 'unhealthy') NOT NULL,
    response_time_ms INT,
    error_count INT DEFAULT 0,
    last_error TEXT,
    metadata JSON,
    checked_at DATETIME NOT NULL,
    
    INDEX idx_service_name (service_name),
    INDEX idx_status (status),
    INDEX idx_checked_at (checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create views for common queries
CREATE VIEW v_recent_transcripts AS
SELECT 
    ct.id,
    ct.call_sid,
    ct.caller_number,
    ct.destination_number,
    ct.start_time,
    ct.end_time,
    ct.duration,
    ct.total_segments,
    ct.status,
    COUNT(ts.id) as actual_segments,
    GROUP_CONCAT(DISTINCT ts.language) as detected_languages,
    GROUP_CONCAT(DISTINCT ts.speaker) as speakers
FROM call_transcripts ct
LEFT JOIN transcript_segments ts ON ct.id = ts.call_transcript_id
WHERE ct.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOURS)
GROUP BY ct.id
ORDER BY ct.start_time DESC;

CREATE VIEW v_transcript_summary AS
SELECT 
    ct.call_sid,
    ct.caller_number,
    ct.start_time,
    ct.duration,
    GROUP_CONCAT(
        CONCAT(ts.speaker, ': ', SUBSTRING(ts.text, 1, 100))
        ORDER BY ts.start_time
        SEPARATOR '\n'
    ) as conversation_preview
FROM call_transcripts ct
JOIN transcript_segments ts ON ct.id = ts.call_transcript_id
GROUP BY ct.id
ORDER BY ct.start_time DESC;

-- Create stored procedures for common operations
DELIMITER //

CREATE PROCEDURE GetCallTranscript(IN p_call_sid VARCHAR(100))
BEGIN
    SELECT 
        ts.speaker,
        ts.text,
        ts.start_time,
        ts.confidence,
        ts.source_type,
        ts.language
    FROM transcript_segments ts
    JOIN call_transcripts ct ON ts.call_transcript_id = ct.id
    WHERE ct.call_sid = p_call_sid
    ORDER BY ts.start_time ASC;
END //

CREATE PROCEDURE SearchTranscripts(
    IN p_search_text TEXT,
    IN p_start_date DATETIME,
    IN p_end_date DATETIME,
    IN p_limit INT
)
BEGIN
    SELECT DISTINCT
        ct.call_sid,
        ct.caller_number,
        ct.start_time,
        ct.duration,
        ts.text,
        ts.speaker,
        MATCH(ts.text) AGAINST(p_search_text IN NATURAL LANGUAGE MODE) as relevance
    FROM call_transcripts ct
    JOIN transcript_segments ts ON ct.id = ts.call_transcript_id
    WHERE MATCH(ts.text) AGAINST(p_search_text IN NATURAL LANGUAGE MODE)
    AND ct.start_time BETWEEN p_start_date AND p_end_date
    ORDER BY relevance DESC, ct.start_time DESC
    LIMIT p_limit;
END //

DELIMITER ;

-- Insert initial system health record
INSERT INTO system_health (service_name, status, checked_at) 
VALUES ('transcript-listener', 'healthy', NOW());

-- Create user for the transcript service
CREATE USER IF NOT EXISTS 'transcript_user'@'%' IDENTIFIED BY 'transcript_password_2024!';
GRANT SELECT, INSERT, UPDATE, DELETE ON voiceerp_transcripts.* TO 'transcript_user'@'%';
FLUSH PRIVILEGES;
