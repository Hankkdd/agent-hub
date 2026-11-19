CREATE TABLE `document_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`import_request_id` text NOT NULL,
	`source` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`selection_start` integer NOT NULL,
	`selection_end` integer NOT NULL,
	`original_text` text NOT NULL,
	`original_sha256` text NOT NULL,
	`replacement_text` text NOT NULL,
	`status` text NOT NULL,
	`accepted_revision_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`base_revision_id`) REFERENCES `document_revisions`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`accepted_revision_id`) REFERENCES `document_revisions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "document_suggestion_source" CHECK("document_suggestions"."source" = 'manual_import'),
	CONSTRAINT "document_suggestion_import_key" CHECK(length("document_suggestions"."import_request_id") BETWEEN 16 AND 96 AND "document_suggestions"."import_request_id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "document_suggestion_range" CHECK(typeof("document_suggestions"."selection_start") = 'integer' AND typeof("document_suggestions"."selection_end") = 'integer' AND "document_suggestions"."selection_start" >= 0 AND "document_suggestions"."selection_end" > "document_suggestions"."selection_start" AND "document_suggestions"."selection_end" <= 9007199254740991),
	CONSTRAINT "document_suggestion_original" CHECK(typeof("document_suggestions"."original_text") = 'text' AND length(CAST("document_suggestions"."original_text" AS BLOB)) BETWEEN 1 AND 16384 AND instr("document_suggestions"."original_text", char(0)) = 0 AND instr("document_suggestions"."original_text", char(13)) = 0),
	CONSTRAINT "document_suggestion_hash" CHECK(length("document_suggestions"."original_sha256") = 64 AND "document_suggestions"."original_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_suggestion_replacement" CHECK(typeof("document_suggestions"."replacement_text") = 'text' AND length(CAST("document_suggestions"."replacement_text" AS BLOB)) <= 65536 AND instr("document_suggestions"."replacement_text", char(0)) = 0 AND instr("document_suggestions"."replacement_text", char(13)) = 0),
	CONSTRAINT "document_suggestion_state" CHECK(("document_suggestions"."status" = 'pending' AND "document_suggestions"."accepted_revision_id" IS NULL AND "document_suggestions"."resolved_at" IS NULL) OR ("document_suggestions"."status" = 'accepted' AND "document_suggestions"."accepted_revision_id" IS NOT NULL AND "document_suggestions"."resolved_at" IS NOT NULL) OR ("document_suggestions"."status" = 'rejected' AND "document_suggestions"."accepted_revision_id" IS NULL AND "document_suggestions"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_suggestions_import_identity` ON `document_suggestions` (`document_id`,`import_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_suggestions_accepted_revision` ON `document_suggestions` (`accepted_revision_id`);--> statement-breakpoint
CREATE INDEX `document_suggestions_document_created` ON `document_suggestions` (`document_id`,`created_at`,`id`);
--> statement-breakpoint
-- Custom guards are not represented in Drizzle snapshots. Preserve them in future migrations.
CREATE TRIGGER document_suggestions_insert_guard BEFORE INSERT ON document_suggestions
BEGIN
  SELECT RAISE(ABORT, 'document_suggestion_duplicate') WHERE
    EXISTS (SELECT 1 FROM document_suggestions WHERE id = NEW.id) OR
    EXISTS (SELECT 1 FROM document_suggestions WHERE document_id = NEW.document_id AND import_request_id = NEW.import_request_id);
  SELECT RAISE(ABORT, 'document_suggestion_initial_state') WHERE
    NEW.status != 'pending' OR NEW.accepted_revision_id IS NOT NULL OR NEW.resolved_at IS NOT NULL;
  SELECT RAISE(ABORT, 'document_suggestion_base') WHERE NOT EXISTS (
    SELECT 1 FROM document_revisions WHERE id = NEW.base_revision_id AND document_id = NEW.document_id AND instr(content, char(13)) = 0
  );
END;
--> statement-breakpoint
CREATE TRIGGER document_suggestions_no_delete BEFORE DELETE ON document_suggestions
BEGIN
  SELECT RAISE(ABORT, 'document_suggestion_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER document_suggestions_update_guard BEFORE UPDATE ON document_suggestions
BEGIN
  SELECT RAISE(ABORT, 'document_suggestion_immutable') WHERE
    OLD.status != 'pending' OR NEW.status NOT IN ('accepted', 'rejected') OR
    NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR
    NEW.import_request_id IS NOT OLD.import_request_id OR NEW.source IS NOT OLD.source OR
    NEW.base_revision_id IS NOT OLD.base_revision_id OR
    NEW.selection_start IS NOT OLD.selection_start OR NEW.selection_end IS NOT OLD.selection_end OR
    NEW.original_text IS NOT OLD.original_text OR NEW.original_sha256 IS NOT OLD.original_sha256 OR
    NEW.replacement_text IS NOT OLD.replacement_text OR NEW.created_at IS NOT OLD.created_at;
  -- Guard before REPLACE can implicitly delete another suggestion's receipt.
  SELECT RAISE(ABORT, 'document_suggestion_duplicate_receipt') WHERE NEW.accepted_revision_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM document_suggestions WHERE accepted_revision_id = NEW.accepted_revision_id AND id != OLD.id
  );
  SELECT RAISE(ABORT, 'document_suggestion_receipt') WHERE NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM document_revisions accepted JOIN document_revisions base ON base.id = OLD.base_revision_id
    WHERE accepted.id = NEW.accepted_revision_id AND accepted.document_id = OLD.document_id
      AND accepted.revision_number = base.revision_number + 1 AND accepted.restored_from_revision_id IS NULL
      AND accepted.title = base.title AND accepted.content_format = base.content_format
  );
END;
