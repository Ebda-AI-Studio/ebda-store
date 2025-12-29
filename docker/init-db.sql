-- Force Website Builder - Database Initialization
-- This script runs on first database creation

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create schemas for multi-tenant architecture
CREATE SCHEMA IF NOT EXISTS stores;
CREATE SCHEMA IF NOT EXISTS analytics;

-- Grant permissions
GRANT ALL ON SCHEMA stores TO postgres;
GRANT ALL ON SCHEMA analytics TO postgres;

-- Log initialization
DO $$
BEGIN
    RAISE NOTICE 'Force Website Builder database initialized successfully';
END $$;
