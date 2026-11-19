-- Expression indexes use a custom migration: drizzle-kit cannot serialize this expression correctly.
-- Legacy events remain outside this partial index. Start and final may share a callId.
CREATE UNIQUE INDEX `events_invocation_identity` ON `events` (`type`, json_extract(`payload`, '$.callId'))
WHERE `type` IN ('invocation_started', 'invocation_finished');
