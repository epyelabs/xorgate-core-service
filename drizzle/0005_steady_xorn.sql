CREATE TABLE "device_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_model_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"device_id" uuid,
	"serial" text,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_device_model_id_device_models_id_fk" FOREIGN KEY ("device_model_id") REFERENCES "public"."device_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_registrations_code_idx" ON "device_registrations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "device_registrations_project_status_idx" ON "device_registrations" USING btree ("project_id","status");