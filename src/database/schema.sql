-- Images table schema
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_modified INTEGER NOT NULL,
    date_taken TEXT,
    date_added INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    location_city TEXT,
    location_country TEXT,
    geocode_attempted INTEGER DEFAULT 0,
    width INTEGER,
    height INTEGER,
    orientation INTEGER DEFAULT 1,
    rotation INTEGER DEFAULT 0,
    camera_model TEXT,
    camera_make TEXT,
    is_favorite INTEGER DEFAULT 0,
    tags TEXT,
    content_hash TEXT,
    perceptual_hash TEXT,
    hash_computed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_date_taken ON images(date_taken);
CREATE INDEX IF NOT EXISTS idx_date_added ON images(date_added);
CREATE INDEX IF NOT EXISTS idx_is_favorite ON images(is_favorite);
CREATE INDEX IF NOT EXISTS idx_filename ON images(filename);
CREATE INDEX IF NOT EXISTS idx_filepath ON images(filepath);
-- NOTE: idx_content_hash is created in migrate() (after the column is added),
-- NOT here — referencing content_hash in schema.sql would fail on pre-existing
-- DBs whose images table predates the column (exec(schema) runs before migrate()).

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Duplicate detection: rebuilt on each scan
CREATE TABLE IF NOT EXISTS duplicate_group_members (
    group_id INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    group_type TEXT NOT NULL,          -- 'exact' | 'similar'
    is_suggested_keeper INTEGER DEFAULT 0,
    is_oversized INTEGER DEFAULT 0,
    is_auto_eligible INTEGER DEFAULT 0, -- eligible for auto-resolve (exact, or similar within the strict threshold)
    PRIMARY KEY (group_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_dgm_image ON duplicate_group_members(image_id);

