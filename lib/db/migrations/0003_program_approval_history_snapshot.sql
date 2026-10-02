ALTER TABLE program_approval_history
  ADD COLUMN state_snapshot jsonb;

UPDATE program_approval_history
SET state_snapshot = jsonb_build_object(
  'snapshotUnavailableForLegacyRevision', true,
  'revision', revision,
  'sourceVersion', source_version,
  'action', action
)
WHERE state_snapshot IS NULL;

ALTER TABLE program_approval_history
  ALTER COLUMN state_snapshot SET NOT NULL;