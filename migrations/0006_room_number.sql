-- Adds the mortal's room number, shown to their angel.
ALTER TABLE pairings ADD COLUMN mortal_room_number TEXT;
ALTER TABLE pairings_backup ADD COLUMN mortal_room_number TEXT;
