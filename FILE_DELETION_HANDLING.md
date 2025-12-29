# File Deletion Handling

## Overview

The picture frame application properly handles physical file deletions from the filesystem with automatic database cleanup.

## How It Works

### 1. Real-Time File Deletion Detection

When a file is physically deleted from the filesystem:

```
File Deleted → Chokidar Detects → Watcher Triggered → DB Entry Removed
```

**Implementation:**
- `FileWatcher` monitors the photo directory using `chokidar`
- Detects `unlink` events (file deletion)
- Calls `scanner.removeFromIndex(filePath)`
- Database entry is **permanently deleted** (not soft-deleted)

**Code Flow:**
1. `watcher.js` → `handleFileRemoved(filePath)`
2. `scanner.js` → `removeFromIndex(filePath)`  
3. `db.js` → `deleteImageByPath(filepath)` - `DELETE FROM images`

### 2. Orphaned Entry Cleanup

On every reindex/startup, the system checks for "orphaned" database entries (files in DB but no longer on filesystem).

**When It Runs:**
- During `npm run index` (force reindex)
- On server startup if images are missing
- Before indexing new files

**How It Works:**
```javascript
// Checks every image in database
for each image in database:
  if file doesn't exist on filesystem:
    delete from database
```

**Implementation:**
- `scanner.js` → `scanDirectory()` calls cleanup
- `db.js` → `cleanupOrphanedEntries()` checks filesystem
- Removes entries where `fs.existsSync(filepath) === false`

## Database Operations

### Hard Delete (Physical File Removed)
```sql
DELETE FROM images WHERE filepath = ?
```
- **Permanent deletion** from database
- Used when file is physically deleted
- Cannot be recovered

### Soft Delete (User Delete Action)
```sql
UPDATE images SET is_deleted = 1 WHERE id = ?
```
- File still exists on filesystem
- Hidden from slideshow
- Can be recovered
- Used via web interface "Delete" button

## Usage Examples

### Scenario 1: Delete File While Server Running
```bash
# Server is running
rm test_photos/IMG_1234.jpg

# Console output:
# File removed: test_photos/IMG_1234.jpg
# Removed from index: test_photos/IMG_1234.jpg
```

### Scenario 2: Delete Files While Server Stopped
```bash
# Server stopped
rm test_photos/IMG_*.jpg

# Restart server or reindex
npm run index

# Console output:
# Checking for orphaned database entries...
# Cleaning up orphaned entry: test_photos/IMG_1234.jpg
# Cleaned up 5 orphaned database entries
```

### Scenario 3: Move Entire Photo Directory
```bash
# Photos moved to new location
mv /old/photos /new/photos

# Update config.json
{
  "photoDirectory": "/new/photos"
}

# Reindex
npm run index

# Old entries cleaned up, new location indexed
```

## Commands

### Force Cleanup and Reindex
```bash
npm run index
```
- Checks for orphaned entries
- Removes missing files from database
- Reindexes all existing files

### Manual Cleanup (Same as Index)
```bash
npm run cleanup
```

## Configuration

No special configuration needed. The cleanup runs automatically during:
- ✅ File watcher detects deletion (real-time)
- ✅ Reindexing (`npm run index`)
- ✅ Server startup (if needed)

## Logging

The system logs all deletion operations:

```
File removed: test_photos/photo.jpg          # Real-time detection
Removed from index: test_photos/photo.jpg    # DB deletion successful
File not in index: test_photos/photo.jpg     # File wasn't indexed
Cleaning up orphaned entry: photo.jpg        # Startup cleanup
Cleaned up 5 orphaned database entries       # Cleanup summary
```

## Technical Details

### File Watcher (watcher.js)
- **Library:** `chokidar` v3.5.3
- **Events:** `add`, `change`, `unlink`
- **Debounce:** 1 second to prevent duplicate events
- **Queue:** Sequential processing to avoid race conditions

### Database Method (db.js)
```javascript
deleteImageByPath(filepath) {
    const stmt = this.db.prepare('DELETE FROM images WHERE filepath = ?');
    const result = stmt.run(filepath);
    return result.changes > 0; // Returns true if deleted
}
```

### Cleanup Method (db.js)
```javascript
cleanupOrphanedEntries(checkFileExists) {
    // Gets all non-deleted images
    const images = db.query('SELECT id, filepath FROM images WHERE is_deleted = 0');
    
    for (image in images) {
        if (!checkFileExists(image.filepath)) {
            deleteImageByPath(image.filepath);
        }
    }
}
```

## Differences: Hard Delete vs Soft Delete

| Feature | Hard Delete | Soft Delete |
|---------|-------------|-------------|
| **Trigger** | Physical file deleted | User clicks Delete in UI |
| **SQL** | `DELETE FROM` | `UPDATE SET is_deleted=1` |
| **File Status** | Missing from filesystem | Still on filesystem |
| **Recoverable** | ❌ No | ✅ Yes (via SQL) |
| **When Used** | Automatic cleanup | User action |

## Best Practices

### When to Delete Files
1. **Via Filesystem:** Delete files directly if you want them permanently removed
2. **Via UI:** Use UI delete button if you might want to recover later

### Bulk Deletion
```bash
# Stop server first for bulk operations
pkill -f "node src/server.js"

# Delete files
rm test_photos/unwanted/*.jpg

# Restart and cleanup
npm run index
npm start
```

### Verifying Cleanup
Check database statistics:
```bash
curl http://localhost:3000/api/stats
```

Returns:
```json
{
  "total": 1669,      // Active images
  "favorites": 5,
  "deleted": 0,       // Soft-deleted (via UI)
  "earliestPhoto": "...",
  "latestPhoto": "..."
}
```

## Troubleshooting

### Problem: Deleted files still showing in slideshow
**Solution:** The file watcher might be stopped. Restart the server:
```bash
pkill -f "node src/server.js"
npm start
```

### Problem: Database has wrong image count
**Solution:** Run cleanup and reindex:
```bash
npm run index
```

### Problem: File watcher not detecting deletions
**Solution:** Check if file watcher is running in logs:
```
Starting file watcher on: ./test_photos
File watcher ready
```

## Summary

✅ **Automatic Detection:** Real-time monitoring of file deletions  
✅ **Permanent Cleanup:** Hard delete from database  
✅ **Orphan Cleanup:** Removes stale entries on startup  
✅ **No User Action:** Everything happens automatically  
✅ **Safe Operations:** Queue-based processing prevents race conditions  

The system intelligently handles file deletions at both runtime and startup, ensuring the database always reflects the actual filesystem state.

