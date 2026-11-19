CREATE TABLE `document_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`title` text NOT NULL,
	`content_format` text NOT NULL,
	`content` text NOT NULL,
	`restored_from_revision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`restored_from_revision_id`) REFERENCES `document_revisions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "document_revision_number" CHECK(typeof("document_revisions"."revision_number") = 'integer' AND "document_revisions"."revision_number" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "document_revision_title" CHECK(typeof("document_revisions"."title") = 'text' AND length(trim("document_revisions"."title")) BETWEEN 1 AND 200 AND instr("document_revisions"."title", char(0)) = 0 AND instr("document_revisions"."title", char(10)) = 0 AND instr("document_revisions"."title", char(13)) = 0),
	CONSTRAINT "document_revision_format" CHECK("document_revisions"."content_format" = 'plain_text'),
	CONSTRAINT "document_revision_content" CHECK(typeof("document_revisions"."content") = 'text' AND length(CAST("document_revisions"."content" AS BLOB)) <= 262144 AND instr("document_revisions"."content", char(0)) = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_revisions_document_number` ON `document_revisions` (`document_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_created_at_id` ON `documents` (`created_at`,`id`);
--> statement-breakpoint
-- Custom triggers are not represented by Drizzle snapshots. Preserve them in future migrations.
CREATE TRIGGER document_revisions_no_update BEFORE UPDATE ON document_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_revision_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER document_revisions_no_delete BEFORE DELETE ON document_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_revision_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER document_revisions_insert_guard BEFORE INSERT ON document_revisions
BEGIN
  -- REPLACE can implicitly delete without firing delete triggers. Reject before it can do so.
  SELECT RAISE(ABORT, 'document_revision_duplicate') WHERE
    EXISTS (SELECT 1 FROM document_revisions WHERE id = NEW.id) OR
    EXISTS (SELECT 1 FROM document_revisions WHERE document_id = NEW.document_id AND revision_number = NEW.revision_number);
  SELECT RAISE(ABORT, 'document_revision_sequence') WHERE
    NEW.revision_number != COALESCE((SELECT MAX(revision_number) + 1 FROM document_revisions WHERE document_id = NEW.document_id), 1);
  SELECT RAISE(ABORT, 'document_revision_restore_source') WHERE
    NEW.restored_from_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_revisions WHERE id = NEW.restored_from_revision_id AND document_id = NEW.document_id
    );
END;
