UPDATE threads
SET type = 'question'
WHERE type = 'assumption';

UPDATE threads
SET type = 'scope_change'
WHERE type = 'scope_extension';
