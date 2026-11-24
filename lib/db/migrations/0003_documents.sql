CREATE TABLE IF NOT EXISTS documents (
  id serial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled',
  emoji varchar(16) NOT NULL DEFAULT '📝',
  slug varchar(120) NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_user_updated ON documents (user_id, updated_at);
