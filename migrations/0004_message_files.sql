-- Files attached to a saved user turn (M5.2).
--
-- A JSON array of { id, name, type, size, kind } (src/shared/files.ts FileRef),
-- or NULL when the turn had none. It is a snapshot for drawing the turn's
-- attachment chips and for re-reading the files as context on later turns;
-- the files themselves live in R2 under u/{user_id}/ and are looked up
-- through that prefix, so an id here can never reach another user's file.
ALTER TABLE messages ADD COLUMN files TEXT;
