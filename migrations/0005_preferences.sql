-- Adds one free-form preferences field. Existing likes/dislikes are preserved in it.
ALTER TABLE pairings ADD COLUMN mortal_preferences TEXT;
ALTER TABLE pairings_backup ADD COLUMN mortal_preferences TEXT;

UPDATE pairings SET mortal_preferences = CASE
  WHEN mortal_likes IS NOT NULL AND mortal_dislikes IS NOT NULL THEN 'Likes: ' || mortal_likes || char(10) || 'Dislikes: ' || mortal_dislikes
  WHEN mortal_likes IS NOT NULL THEN 'Likes: ' || mortal_likes
  WHEN mortal_dislikes IS NOT NULL THEN 'Dislikes: ' || mortal_dislikes
  ELSE NULL END;
UPDATE pairings_backup SET mortal_preferences = CASE
  WHEN mortal_likes IS NOT NULL AND mortal_dislikes IS NOT NULL THEN 'Likes: ' || mortal_likes || char(10) || 'Dislikes: ' || mortal_dislikes
  WHEN mortal_likes IS NOT NULL THEN 'Likes: ' || mortal_likes
  WHEN mortal_dislikes IS NOT NULL THEN 'Dislikes: ' || mortal_dislikes
  ELSE NULL END;
