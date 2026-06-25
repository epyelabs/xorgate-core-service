-- Rename the "Project" domain concept to "Workspace".
-- Hand-authored data-preserving rename (drizzle-kit emits a destructive drop+create
-- for table/column renames). Metadata-only ALTERs: fast and transactional.
ALTER TABLE "projects" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "devices" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "device_registrations" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER INDEX "projects_pkey" RENAME TO "workspaces_pkey";--> statement-breakpoint
ALTER INDEX "projects_org_slug_idx" RENAME TO "workspaces_org_slug_idx";--> statement-breakpoint
ALTER INDEX "devices_project_serial_idx" RENAME TO "devices_workspace_serial_idx";--> statement-breakpoint
ALTER INDEX "devices_project_idx" RENAME TO "devices_workspace_idx";--> statement-breakpoint
ALTER INDEX "device_registrations_project_status_idx" RENAME TO "device_registrations_workspace_status_idx";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "projects_organization_id_organizations_id_fk" TO "workspaces_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "devices" RENAME CONSTRAINT "devices_project_id_projects_id_fk" TO "devices_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "device_registrations" RENAME CONSTRAINT "device_registrations_project_id_projects_id_fk" TO "device_registrations_workspace_id_workspaces_id_fk";
