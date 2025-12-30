class SlideshowEngine {
    constructor(db) {
        this.db = db;
        this.currentIndex = 0;
        this.currentImageId = null;
        this.imageList = [];
        this.settings = {
            mode: 'sequential',
            order: 'date',
            interval: 10,
            favoritesOnly: false
        };
        // Reliable navigation history
        this.backStack = [];
        this.forwardStack = [];
        this.maxHistorySize = 50;
    }

    initialize() {
        // Load settings from database
        const savedSettings = this.db.getAllSettings();
        if (savedSettings.slideshow_mode) {
            this.settings.mode = savedSettings.slideshow_mode;
        }
        if (savedSettings.slideshow_interval) {
            this.settings.interval = parseInt(savedSettings.slideshow_interval);
        }
        if (savedSettings.slideshow_order) {
            this.settings.order = savedSettings.slideshow_order;
        }
        if (savedSettings.filter_favorites_only) {
            this.settings.favoritesOnly = savedSettings.filter_favorites_only === '1';
        }
        if (savedSettings.current_image_id) {
            this.currentImageId = parseInt(savedSettings.current_image_id);
        }

        // Load image list
        this.refreshImageList();

        console.log('Slideshow engine initialized:', this.settings);
    }

    refreshImageList() {
        const options = {
            favoritesOnly: this.settings.favoritesOnly
        };

        // Special handling for "this day" order
        if (this.settings.order === 'thisday') {
            options.thisDay = true;
            options.orderBy = 'thisday';
        } else if (this.settings.mode === 'sequential') {
            options.orderBy = this.settings.order;
        } else if (this.settings.mode === 'random') {
            options.orderBy = 'random';
        } else if (this.settings.mode === 'smart') {
            // For smart mode, we'll get all images and apply weighting
            options.orderBy = this.settings.order;
        }

        this.imageList = this.db.getAllImages(options);
        console.log(`Loaded ${this.imageList.length} images for slideshow`);

        // Find current index if we have a current image
        if (this.currentImageId) {
            this.currentIndex = this.imageList.findIndex(img => img.id === this.currentImageId);
            if (this.currentIndex === -1) {
                this.currentIndex = 0;
            }
        }

        // Prune history stacks to only include images that still exist in the list
        const validIds = new Set(this.imageList.map(img => img.id));
        this.backStack = this.backStack.filter(id => validIds.has(id));
        this.forwardStack = this.forwardStack.filter(id => validIds.has(id));
    }

    setCurrentImageById(imageId) {
        if (!imageId || this.imageList.length === 0) return false;
        let index = this.imageList.findIndex(img => img.id === imageId);
        if (index === -1) {
            // List might be stale (filters changed / deleted); refresh once and retry
            this.refreshImageList();
            index = this.imageList.findIndex(img => img.id === imageId);
        }
        if (index === -1) return false;

        this.currentIndex = index;
        this.currentImageId = imageId;
        this.db.setSetting('current_image_id', imageId);
        return true;
    }

    pushBack(id) {
        if (!id) return;
        const last = this.backStack[this.backStack.length - 1];
        if (last === id) return;
        this.backStack.push(id);
        if (this.backStack.length > this.maxHistorySize) {
            this.backStack.shift();
        }
    }

    pushForward(id) {
        if (!id) return;
        const last = this.forwardStack[this.forwardStack.length - 1];
        if (last === id) return;
        this.forwardStack.push(id);
        if (this.forwardStack.length > this.maxHistorySize) {
            this.forwardStack.shift();
        }
    }

    getCurrentImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        if (this.currentIndex < 0 || this.currentIndex >= this.imageList.length) {
            this.currentIndex = 0;
        }

        const image = this.imageList[this.currentIndex];
        this.currentImageId = image.id;
        this.db.setSetting('current_image_id', image.id);

        return this.formatImage(image);
    }

    getNextImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        const prevId = this.currentImageId || (this.imageList[this.currentIndex] && this.imageList[this.currentIndex].id);

        // If user went back previously, allow "next" to go forward again
        if (this.forwardStack.length > 0) {
            const nextId = this.forwardStack.pop();
            if (prevId) this.pushBack(prevId);
            if (nextId && this.setCurrentImageById(nextId)) {
                return this.getCurrentImage();
            }
            // If invalid, fall through to normal selection
        }

        if (this.settings.mode === 'random') {
            // True random
            this.currentIndex = Math.floor(Math.random() * this.imageList.length);
        } else if (this.settings.mode === 'smart') {
            // Weighted random
            this.currentIndex = this.selectSmartImage();
        } else {
            // Sequential
            this.currentIndex++;
            if (this.currentIndex >= this.imageList.length) {
                this.currentIndex = 0;
            }
        }

        const image = this.getCurrentImage();
        if (image && prevId && image.id !== prevId) {
            this.pushBack(prevId);
            // New branch: clear forward stack
            this.forwardStack = [];
        }

        return image;
    }

    getPreviousImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        const currentId = this.currentImageId || (this.imageList[this.currentIndex] && this.imageList[this.currentIndex].id);

        // Prefer reliable back stack
        if (this.backStack.length > 0) {
            const previousId = this.backStack.pop();
            if (currentId) this.pushForward(currentId);
            if (previousId && this.setCurrentImageById(previousId)) {
                return this.getCurrentImage();
            }
        }

        // Fallback to simple previous
        if (this.settings.mode === 'sequential') {
            if (currentId) this.pushForward(currentId);
            this.currentIndex--;
            if (this.currentIndex < 0) {
                this.currentIndex = this.imageList.length - 1;
            }
        } else {
            // For random modes, just go to a random previous image
            this.currentIndex = Math.floor(Math.random() * this.imageList.length);
        }

        return this.getCurrentImage();
    }

    selectSmartImage() {
        // Smart selection: weight by favorites, recency, and "this day"
        const weights = this.imageList.map((img, index) => {
            let weight = 1;

            // Favorites get 3x weight
            if (img.is_favorite) {
                weight *= 3;
            }

            // Recent photos (within last month) get 2x weight
            if (img.date_taken) {
                const photoDate = new Date(img.date_taken);
                const oneMonthAgo = new Date();
                oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
                
                if (photoDate > oneMonthAgo) {
                    weight *= 2;
                }
                
                // Photos from "this day in history" get 10x weight
                const today = new Date();
                if (photoDate.getMonth() === today.getMonth() && 
                    photoDate.getDate() === today.getDate()) {
                    weight *= 10;
                }
            }

            return weight;
        });

        // Calculate total weight
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);

        // Select random weighted index
        let random = Math.random() * totalWeight;
        
        for (let i = 0; i < weights.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                return i;
            }
        }

        return 0;
    }

    formatImage(image) {
        return {
            id: image.id,
            filepath: image.filepath,
            filename: image.filename,
            dateTaken: image.date_taken,
            dateAdded: image.date_added,
            latitude: image.latitude,
            longitude: image.longitude,
            locationCity: image.location_city,
            locationCountry: image.location_country,
            width: image.width,
            height: image.height,
            orientation: image.orientation,
            rotation: image.rotation || 0,
            orientation: image.orientation,
            cameraModel: image.camera_model,
            cameraMake: image.camera_make,
            isFavorite: image.is_favorite === 1,
            tags: image.tags ? JSON.parse(image.tags) : []
        };
    }

    getSettings() {
        return {
            mode: this.settings.mode,
            order: this.settings.order,
            interval: this.settings.interval,
            favoritesOnly: this.settings.favoritesOnly,
            totalImages: this.imageList.length
        };
    }

    updateSettings(newSettings) {
        let needsRefresh = false;

        if (newSettings.mode !== undefined && newSettings.mode !== this.settings.mode) {
            this.settings.mode = newSettings.mode;
            this.db.setSetting('slideshow_mode', newSettings.mode);
            needsRefresh = true;
        }

        if (newSettings.order !== undefined && newSettings.order !== this.settings.order) {
            this.settings.order = newSettings.order;
            this.db.setSetting('slideshow_order', newSettings.order);
            needsRefresh = true;
        }

        if (newSettings.interval !== undefined) {
            this.settings.interval = parseInt(newSettings.interval);
            this.db.setSetting('slideshow_interval', this.settings.interval);
        }

        if (newSettings.favoritesOnly !== undefined && newSettings.favoritesOnly !== this.settings.favoritesOnly) {
            this.settings.favoritesOnly = newSettings.favoritesOnly;
            this.db.setSetting('filter_favorites_only', newSettings.favoritesOnly ? '1' : '0');
            needsRefresh = true;
        }

        if (needsRefresh) {
            this.refreshImageList();
            console.log('Slideshow settings updated and image list refreshed');
        }

        return this.getSettings();
    }

    getPreloadImages(count = 3) {
        // Get next N images for preloading
        const preload = [];
        
        for (let i = 1; i <= count; i++) {
            const nextIndex = (this.currentIndex + i) % this.imageList.length;
            if (nextIndex < this.imageList.length && this.imageList[nextIndex]) {
                preload.push(this.formatImage(this.imageList[nextIndex]));
            }
        }

        return preload;
    }
}

module.exports = SlideshowEngine;


