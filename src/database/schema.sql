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
    width INTEGER,
    height INTEGER,
    orientation INTEGER DEFAULT 1,
    rotation INTEGER DEFAULT 0,
    camera_model TEXT,
    camera_make TEXT,
    is_favorite INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    tags TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_date_taken ON images(date_taken);
CREATE INDEX IF NOT EXISTS idx_date_added ON images(date_added);
CREATE INDEX IF NOT EXISTS idx_is_favorite ON images(is_favorite);
CREATE INDEX IF NOT EXISTS idx_is_deleted ON images(is_deleted);
CREATE INDEX IF NOT EXISTS idx_filename ON images(filename);
CREATE INDEX IF NOT EXISTS idx_filepath ON images(filepath);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES 
    ('slideshow_mode', 'sequential', strftime('%s', 'now')),
    ('slideshow_interval', '10', strftime('%s', 'now')),
    ('slideshow_order', 'date', strftime('%s', 'now')),
    ('filter_favorites_only', '0', strftime('%s', 'now')),
    ('current_image_id', '0', strftime('%s', 'now'));


