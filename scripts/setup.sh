#!/bin/bash

# VoiceERP Transcript Listener Setup Script
# This script helps set up the transcript listener service

set -e

echo "🎯 VoiceERP Transcript Listener Setup"
echo "===================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root for security reasons"
   exit 1
fi

# Check Node.js version
print_info "Checking Node.js version..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version | cut -d'v' -f2)
    REQUIRED_VERSION="16.0.0"
    
    if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" = "$REQUIRED_VERSION" ]; then
        print_status "Node.js version $NODE_VERSION is compatible"
    else
        print_error "Node.js version $NODE_VERSION is too old. Required: $REQUIRED_VERSION+"
        exit 1
    fi
else
    print_error "Node.js is not installed"
    exit 1
fi

# Check npm
print_info "Checking npm..."
if command -v npm &> /dev/null; then
    print_status "npm is available"
else
    print_error "npm is not installed"
    exit 1
fi

# Install dependencies
print_info "Installing Node.js dependencies..."
if npm ci; then
    print_status "Dependencies installed successfully"
else
    print_error "Failed to install dependencies"
    exit 1
fi

# Check environment file
print_info "Checking environment configuration..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        print_warning "Created .env file from .env.example"
        print_warning "Please edit .env file with your configuration before starting the service"
    else
        print_error ".env.example file not found"
        exit 1
    fi
else
    print_status "Environment file exists"
fi

# Check required environment variables
print_info "Validating environment configuration..."
source .env

REQUIRED_VARS=(
    "FREESWITCH_HOST"
    "FREESWITCH_PORT" 
    "FREESWITCH_PASSWORD"
    "DB_HOST"
    "DB_USER"
    "DB_PASSWORD"
    "DB_NAME"
    "REDIS_HOST"
    "REDIS_PORT"
)

MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    print_error "Missing required environment variables:"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    print_warning "Please update your .env file"
    exit 1
else
    print_status "All required environment variables are set"
fi

# Test database connection
print_info "Testing database connection..."
if command -v mysql &> /dev/null; then
    if mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" -e "SELECT 1;" &> /dev/null; then
        print_status "Database connection successful"
        
        # Check if transcript database exists
        if mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" -e "USE $DB_NAME;" &> /dev/null; then
            print_status "Transcript database exists"
        else
            print_warning "Transcript database does not exist"
            print_info "You may need to run the database initialization script"
        fi
    else
        print_error "Database connection failed"
        print_warning "Please check your database configuration"
    fi
else
    print_warning "MySQL client not found, skipping database test"
fi

# Test Redis connection
print_info "Testing Redis connection..."
if command -v redis-cli &> /dev/null; then
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping &> /dev/null; then
        print_status "Redis connection successful"
    else
        print_error "Redis connection failed"
        print_warning "Please check your Redis configuration"
    fi
else
    print_warning "Redis CLI not found, skipping Redis test"
fi

# Test FreeSWITCH connection
print_info "Testing FreeSWITCH Event Socket connection..."
if command -v telnet &> /dev/null; then
    if timeout 5 telnet "$FREESWITCH_HOST" "$FREESWITCH_PORT" &> /dev/null; then
        print_status "FreeSWITCH Event Socket is reachable"
    else
        print_error "Cannot connect to FreeSWITCH Event Socket"
        print_warning "Please check FreeSWITCH configuration and network connectivity"
    fi
else
    print_warning "Telnet not found, skipping FreeSWITCH test"
fi

# Create log directory
print_info "Creating log directory..."
mkdir -p logs
print_status "Log directory created"

# Create tmp directory
print_info "Creating tmp directory..."
mkdir -p tmp
print_status "Tmp directory created"

# Set permissions
print_info "Setting permissions..."
chmod 755 logs tmp
print_status "Permissions set"

# Run health check
print_info "Running service health check..."
if npm run health &> /dev/null; then
    print_status "Service health check passed"
else
    print_warning "Service health check failed (this is normal if service is not running)"
fi

echo ""
echo "🎉 Setup completed successfully!"
echo ""
print_info "Next steps:"
echo "1. Review and update .env file if needed"
echo "2. Initialize database: mysql -h\$DB_HOST -u\$DB_USER -p\$DB_PASSWORD < ../infrastructure/mysql/transcript_init.sql"
echo "3. Start the service: npm start"
echo "4. Check health: curl http://localhost:3012/health"
echo ""
print_info "For Docker deployment:"
echo "1. Build image: docker build -t voiceerp-transcript-listener ."
echo "2. Run container: docker-compose up transcript-listener"
echo ""
print_info "Documentation: README.md"
print_info "API Documentation: http://localhost:3012/api/status"
echo ""
print_status "Setup script completed!"
