CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"name" varchar(60) NOT NULL,
	"transport" varchar(16) DEFAULT 'http' NOT NULL,
	"url" text NOT NULL,
	"auth_type" varchar(16) DEFAULT 'none' NOT NULL,
	"auth_header" text,
	"credential_id" integer,
	"allowlist" jsonb DEFAULT null,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_user_name" ON "mcp_servers" USING btree ("user_id","name");
