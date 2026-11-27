-- Additive optimistic concurrency control; preserve all existing teams and records.
ALTER TABLE `Team` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
