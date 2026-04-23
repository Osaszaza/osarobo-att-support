-- ================================================================
--  AI Support System — Supabase Setup
--  Run this once in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

-- Conversations: every user ↔ AI exchange
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_message text        NOT NULL,
  ai_response  text        NOT NULL,
  created_at   timestamptz DEFAULT now()
);

-- Summaries: auto-generated every 5 messages
CREATE TABLE IF NOT EXISTS summaries (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  summary_text text        NOT NULL,
  created_at   timestamptz DEFAULT now()
);

-- ── Row Level Security (recommended for production) ─────────────────
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries     ENABLE ROW LEVEL SECURITY;

-- Allow the service/anon key full access (backend uses this key)
-- Tighten these policies before going to production.
CREATE POLICY "allow_all_conversations" ON conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_summaries"     ON summaries     FOR ALL USING (true) WITH CHECK (true);

-- ── Optional: useful indexes ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_created     ON summaries     (created_at DESC);
