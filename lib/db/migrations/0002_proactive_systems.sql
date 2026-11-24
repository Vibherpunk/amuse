ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS tracking_item_id integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracking_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "kind" varchar(16) DEFAULT 'todo' NOT NULL,
  "content" text NOT NULL,
  "due_at" timestamp with time zone,
  "due_text" text,
  "status" varchar(16) DEFAULT 'open' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "source_ref" text,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracking_items_user_status" ON "tracking_items" ("user_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracking_items_user_idem" ON "tracking_items" ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "source" varchar(24) NOT NULL,
  "external_key" text NOT NULL,
  "state_hash" varchar(64) NOT NULL,
  "day_key" varchar(10) NOT NULL,
  "status" varchar(16) DEFAULT 'seen' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proactive_events_dedupe" ON "proactive_events" ("user_id", "source", "external_key", "state_hash", "day_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_deliveries" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "source" varchar(32) NOT NULL,
  "message_id" integer NOT NULL,
  "tracking_item_id" integer,
  "summary" text DEFAULT '' NOT NULL,
  "dreamed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_deliveries_user_day" ON "proactive_deliveries" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_clues" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "matter" text NOT NULL,
  "kind" varchar(64) NOT NULL,
  "time_window" varchar(64),
  "leaning" varchar(24) DEFAULT 'follow_up_later' NOT NULL,
  "seen" integer DEFAULT 1 NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_clues_user" ON "proactive_clues" ("user_id", "last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_rule_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rationale" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_rule_versions_user" ON "proactive_rule_versions" ("user_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_files_content_fts_idx" ON "workspace_files" USING GIN (to_tsvector('english', "content"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_content_fts_idx" ON "messages" USING GIN (to_tsvector('english', "content"));
