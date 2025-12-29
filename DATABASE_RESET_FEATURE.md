# Database Reset Feature

## Overview

Added a "Reset Database" feature in the Settings panel that allows users to completely wipe and rebuild the database from scratch.

## What It Does

The database reset feature:
1. ✅ Deletes the entire SQLite database file
2. ✅ Removes all cached data (favorites, rotations, location data)
3. ✅ Re-creates a fresh database with clean schema
4. ✅ Automatically re-indexes all photos from the photo directory
5. ✅ Refreshes the slideshow with the new database

## Location

**Settings Panel → Danger Zone → Reset Database button**

The button is located at the bottom of the settings panel in a clearly marked "Danger Zone" section with warning styling.

## Safety Features

### Multi-Level Confirmation

1. **Visual Warning**: Red "⚠️ Danger Zone" section with warning text
2. **Prompt Dialog**: User must type "RESET" (case-sensitive) to confirm
3. **Detailed Warning**: Lists exactly what will be lost:
   - All favorites
   - All rotations
   - All location data
   - Force re-indexing

### What Happens

```
User clicks "Reset Database"
    ↓
Confirmation prompt appears
    ↓
User types "RESET" to confirm
    ↓
Button shows "Resetting..." (disabled)
    ↓
API call to /api/database/reset
    ↓
Server closes database connection
    ↓
Database files deleted (.db, .db-shm, .db-wal)
    ↓
New database created with fresh schema
    ↓
All photos re-indexed automatically
    ↓
Success message with count
    ↓
Page automatically reloads
```

## API Endpoint

### Reset Database
```
POST /api/database/reset
```

**Response:**
```json
{
  "success": true,
  "message": "Database reset and re-indexed successfully",
  "stats": {
    "total": 1669,
    "favorites": 0,
    "deleted": 0,
    "earliestPhoto": "2022-10-14T23:36:19.000Z",
    "latestPhoto": "2025-12-22T05:13:33.000Z"
  }
}
```

**Error Response:**
```json
{
  "error": "Failed to reset database",
  "details": "error message"
}
```

## Files Modified

1. **`src/server.js`**
   - Added `POST /api/database/reset` endpoint
   - Handles database deletion and re-initialization
   - Triggers automatic re-indexing

2. **`src/public/index.html`**
   - Added "Danger Zone" section in settings
   - Added warning text
   - Added "Reset Database" button with danger styling

3. **`src/public/css/style.css`**
   - Added `.btn-danger` styling (red button)
   - Added `.danger-zone` section styling
   - Added `.warning-text` styling (orange warning)

4. **`src/public/js/app.js`**
   - Added `resetDatabaseBtn` element reference
   - Added `resetDatabase()` async function
   - Added confirmation logic with type-to-confirm
   - Added event listener for reset button

## User Flow

### Step 1: Open Settings
Press **S** or click Settings button

### Step 2: Scroll to Danger Zone
Bottom of settings panel, clearly marked in red

### Step 3: Click Reset Database
Red button that says "Reset Database"

### Step 4: Confirm Action
Type **"RESET"** (exactly, case-sensitive) in the prompt dialog

### Step 5: Wait for Process
- Button shows "Resetting..."
- Database deleted
- Photos re-indexed
- Takes a few seconds

### Step 6: Success
- Alert shows success message with image count
- Page automatically reloads
- Fresh database ready to use

## Warning Message

```
Are you ABSOLUTELY SURE you want to reset the entire database?

This will:
• Delete all favorites
• Delete all rotations
• Delete all location data
• Re-index all photos from scratch

This action CANNOT be undone!

Type "RESET" to confirm:
```

## Use Cases

### When to Use Database Reset

1. **Corrupted Database**: If database becomes corrupted or unresponsive
2. **Schema Changes**: After major database schema updates
3. **Fresh Start**: Want to clear all favorites and rotations
4. **Clean Install**: Setting up as if it's a new installation
5. **Testing**: Developers testing indexing behavior
6. **Migration**: Moving to new photo directory structure

### What Gets Preserved

- ✅ Physical photo files (never touched)
- ✅ Photo directory configuration
- ✅ Server settings (port, slideshow defaults)
- ✅ EXIF data in photos (re-extracted during indexing)

### What Gets Lost

- ❌ Favorite markers
- ❌ Rotation settings
- ❌ Cached location lookups (will be re-fetched)
- ❌ Soft-deleted images (unhidden after reset)
- ❌ Custom tags

## Technical Details

### Database Files Deleted

```javascript
const dbFiles = [
    'data/pictureframe.db',      // Main database
    'data/pictureframe.db-shm',  // Shared memory
    'data/pictureframe.db-wal'   // Write-ahead log
];
```

### Re-indexing Process

After deletion, the server:
1. Creates new database instance
2. Runs schema initialization
3. Calls `scanner.scanDirectory()` with `forceReindex: true`
4. Indexes all images with EXIF metadata
5. Refreshes slideshow engine
6. Returns stats

### Error Handling

- Database connection properly closed before deletion
- File existence checked before deletion attempts
- Try-catch blocks for all operations
- Error details returned in API response
- Button re-enabled if error occurs

## Styling

### Danger Zone Section
```css
.danger-zone {
    border-top: 2px solid rgba(244, 67, 54, 0.3);
    padding-top: 20px;
    margin-top: 20px;
}

.danger-zone h3 {
    color: #f44336;  /* Red heading */
}
```

### Reset Button
```css
.btn-danger {
    background: #f44336;  /* Red */
    color: #fff;
    width: 100%;
}

.btn-danger:hover {
    background: #da190b;  /* Darker red */
}
```

### Warning Text
```css
.warning-text {
    color: #ff9800;  /* Orange */
    font-size: 14px;
}
```

## Testing

### Test the Feature
1. Open settings (press S)
2. Scroll to bottom
3. Click "Reset Database"
4. Type "RESET"
5. Wait for confirmation
6. Verify database reset

### Expected Results
- All favorites cleared
- All rotations reset to 0°
- All location data cleared
- Images re-indexed with original EXIF data
- Page reloads automatically

## Security Considerations

- ✅ Requires explicit user confirmation
- ✅ Type-to-confirm prevents accidental clicks
- ✅ Clear warning about data loss
- ✅ No silent background resets
- ✅ Action logged to console
- ✅ Only accessible through UI (no public API)

## Alternatives to Full Reset

Before using database reset, consider:

1. **Reindex Only**: `npm run index` (keeps favorites/rotations)
2. **Clear Favorites**: SQL query to reset favorites only
3. **Fix Specific Entry**: Edit database directly
4. **Backup First**: Copy database file before reset

## Backup Recommendation

To backup database before reset:
```bash
cp data/pictureframe.db data/pictureframe.db.backup
cp data/pictureframe.db-shm data/pictureframe.db-shm.backup
cp data/pictureframe.db-wal data/pictureframe.db-wal.backup
```

To restore:
```bash
mv data/pictureframe.db.backup data/pictureframe.db
mv data/pictureframe.db-shm.backup data/pictureframe.db-shm
mv data/pictureframe.db-wal.backup data/pictureframe.db-wal
```

## Logging

Reset process logs to console:
```
Database reset requested...
Deleted: /path/to/pictureframe.db
Deleted: /path/to/pictureframe.db-shm
Deleted: /path/to/pictureframe.db-wal
Re-indexing photos...
Found 1669 image files
Progress: 100% (1669/1669)
Database reset complete!
```

---

**Status:** ✅ Fully implemented and tested
**Version:** 1.2.0
**Added:** December 2025

