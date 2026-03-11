ALTER TABLE threads ADD COLUMN freshness TEXT NOT NULL DEFAULT 'active';

ALTER TABLE file_briefs ADD COLUMN freshness TEXT NOT NULL DEFAULT 'active';
