const chokidar = require('chokidar');
const path = require('path');

class FileWatcher {
    constructor(db, scanner, config, deps = {}) {
        this.db = db;
        this.scanner = scanner;
        this.config = config;
        this.watcher = null;
        this.queue = [];
        this.processing = false;
        this.debounceTimers = new Map();
        // Called once after a batch of file events has been fully processed,
        // so the running slideshow picks up added/removed images. Optional.
        this.onChange = deps.onChange || null;
    }

    start(directoryPath) {
        const logger = require('../logger');
        logger.debug('File watcher starting', { directoryPath });
        console.log(`Starting file watcher on: ${directoryPath}`);

        const extensions = this.config.fileExtensions.map(ext => 
            ext.startsWith('.') ? ext.substring(1) : ext
        );

        // Create file pattern for chokidar
        const globPattern = `**/*.{${extensions.join(',')}}`;

        // Use polling mode if configured or on systems with low inotify limits
        const usePolling = this.config.watcher?.usePolling || false;
        
        const ignored = [
            /(^|[\/\\])\../,  // ignore dotfiles
            '**/resized/**'   // ignore resized output folder
        ];
        this.watcher = chokidar.watch(directoryPath, {
            ignored,
            persistent: true,
            ignoreInitial: true, // Don't emit events for initial scan
            usePolling: usePolling, // Use polling instead of native watchers
            interval: 10000, // Poll every 10 seconds (only used if usePolling is true)
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });
        
        if (usePolling) {
            console.log('File watcher using polling mode (10s interval)');
        }

        this.watcher
            .on('add', filePath => this.handleFileAdded(filePath))
            .on('change', filePath => this.handleFileChanged(filePath))
            .on('unlink', filePath => this.handleFileRemoved(filePath))
            .on('error', error => console.error('Watcher error:', error))
            .on('ready', () => console.log('File watcher ready'));

        return this.watcher;
    }

    handleFileAdded(filePath) {
        this.debounce(filePath, 'add', () => {
            require('../logger').debug('File added', { filePath });
            console.log(`File added: ${filePath}`);
            this.queueTask({ type: 'add', filePath });
        });
    }

    handleFileChanged(filePath) {
        this.debounce(filePath, 'change', () => {
            require('../logger').debug('File changed', { filePath });
            console.log(`File changed: ${filePath}`);
            this.queueTask({ type: 'change', filePath });
        });
    }

    handleFileRemoved(filePath) {
        this.debounce(filePath, 'unlink', () => {
            require('../logger').debug('File removed', { filePath });
            console.log(`File removed: ${filePath}`);
            this.queueTask({ type: 'unlink', filePath });
        });
    }

    debounce(filePath, event, callback, delay = 1000) {
        const key = `${filePath}:${event}`;
        
        if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key));
        }

        const timer = setTimeout(() => {
            callback();
            this.debounceTimers.delete(key);
        }, delay);

        this.debounceTimers.set(key, timer);
    }

    queueTask(task) {
        this.queue.push(task);
        this.processQueue();
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        let changed = false;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            const didChange = await this.processTask(task);
            if (didChange) changed = true;
        }

        this.processing = false;

        // One refresh per drained batch (not per file) so a bulk import
        // refreshes the slideshow once.
        if (changed && this.onChange) {
            try {
                this.onChange();
            } catch (error) {
                console.error('Watcher onChange callback failed:', error.message);
            }
        }
    }

    async processTask(task) {
        try {
            switch (task.type) {
                case 'add':
                case 'change':
                    await this.scanner.indexSingleFile(task.filePath);
                    return true;
                case 'unlink':
                    this.scanner.removeFromIndex(task.filePath);
                    return true;
            }
        } catch (error) {
            console.error(`Error processing task for ${task.filePath}:`, error.message);
        }
        return false;
    }

    stop() {
        if (this.watcher) {
            console.log('Stopping file watcher');
            this.watcher.close();
            this.watcher = null;
        }

        // Clear all debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    getQueueLength() {
        return this.queue.length;
    }

    isProcessing() {
        return this.processing;
    }
}

module.exports = FileWatcher;

