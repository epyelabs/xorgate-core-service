CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"s3_key" text,
	"size_bytes" integer,
	"duration_ms" integer,
	"task_arn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "auto_record" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recordings_device_stream_status_idx" ON "recordings" USING btree ("device_id","stream_key","status");--> statement-breakpoint
CREATE INDEX "recordings_device_created_idx" ON "recordings" USING btree ("device_id","created_at");