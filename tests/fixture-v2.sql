CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER, parent_id TEXT);
CREATE TABLE session AS SELECT * FROM session_v2;
INSERT INTO session VALUES ('ses_legacy', '/legacy', 'Legacy only', 2900000000000, 2900000000000, NULL, NULL);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
CREATE TABLE fixture_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE fixture_part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TRIGGER fixture_message_insert AFTER INSERT ON fixture_message BEGIN
  INSERT INTO session_message VALUES (NEW.id, NEW.session_id, json_extract(NEW.data, '$.role'), COALESCE((SELECT MAX(seq) + 1 FROM session_message WHERE session_id = NEW.session_id), 0), NEW.time_created, NEW.time_updated, json_remove(NEW.data, '$.role'));
END;
CREATE TRIGGER fixture_part_insert AFTER INSERT ON fixture_part BEGIN
  UPDATE session_message SET data = CASE
    WHEN type = 'user' AND json_extract(NEW.data, '$.type') = 'text' THEN json_set(data, '$.text', json_extract(NEW.data, '$.text'))
    ELSE json_insert(json_set(data, '$.content', json(COALESCE(json_extract(data, '$.content'), '[]'))), '$.content[#]', json(CASE WHEN json_extract(NEW.data, '$.type') = 'tool' THEN json_set(json_remove(NEW.data, '$.tool'), '$.name', json_extract(NEW.data, '$.tool'), '$.time.created', NEW.time_created) ELSE NEW.data END)) END,
    time_updated = NEW.time_updated WHERE id = NEW.message_id;
END;
CREATE TRIGGER fixture_message_delete AFTER DELETE ON fixture_message BEGIN
  DELETE FROM session_message WHERE id = OLD.id;
END;
