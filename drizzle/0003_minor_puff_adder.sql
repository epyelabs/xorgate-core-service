CREATE TABLE "device_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"iot_thing_name" text NOT NULL,
	"certificate_id" text NOT NULL,
	"certificate_arn" text NOT NULL,
	"policy_name" text NOT NULL,
	"role_alias" text NOT NULL,
	"credential_endpoint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_latest" (
	"device_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"value" double precision,
	"unit" text,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kvs_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"channel_name" text NOT NULL,
	"channel_arn" text NOT NULL,
	"region" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" uuid,
	"stream_key" text NOT NULL,
	"s3_key" text NOT NULL,
	"seq" integer NOT NULL,
	"start_ts" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"keyframe" boolean DEFAULT true NOT NULL,
	"size_bytes" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"init_key" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"codec" text,
	"width" integer,
	"height" integer,
	"fps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_readings" (
	"device_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" double precision,
	"unit" text,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "device_identities" ADD CONSTRAINT "device_identities_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_latest" ADD CONSTRAINT "device_latest_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kvs_channels" ADD CONSTRAINT "kvs_channels_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_session_id_media_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."media_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD CONSTRAINT "media_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_identities_device_idx" ON "device_identities" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_identities_cert_idx" ON "device_identities" USING btree ("certificate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_latest_device_metric_idx" ON "device_latest" USING btree ("device_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "kvs_channels_device_stream_idx" ON "kvs_channels" USING btree ("device_id","stream_key");--> statement-breakpoint
CREATE INDEX "media_segments_device_stream_start_idx" ON "media_segments" USING btree ("device_id","stream_key","start_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "media_segments_s3key_idx" ON "media_segments" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "media_sessions_device_stream_started_idx" ON "media_sessions" USING btree ("device_id","stream_key","started_at");--> statement-breakpoint
CREATE INDEX "telemetry_device_metric_ts_idx" ON "telemetry_readings" USING btree ("device_id","metric","ts");--> statement-breakpoint
CREATE INDEX "telemetry_device_ts_metric_idx" ON "telemetry_readings" USING btree ("device_id","ts","metric");