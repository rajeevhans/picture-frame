// Application state
const state = {
    currentImage: null,
    settings: null,
    isPlaying: false,
    slideshowTimer: null,
    controlsVisible: false,
    controlsTimer: null,
    mouseMoveTimer: null,
    infoVisible: false
};

// DOM elements
const elements = {
    mainImage: document.getElementById('mainImage'),
    nextImage: document.getElementById('nextImage'),
    loadingIndicator: document.getElementById('loadingIndicator'),
    noImagesMessage: document.getElementById('noImagesMessage'),
    controlOverlay: document.getElementById('controlOverlay'),
    bottomBar: document.getElementById('bottomBar'),
    infoOverlay: document.getElementById('infoOverlay'),
    locationOverlay: document.getElementById('locationOverlay'),
    locationText: document.getElementById('locationText'),
    settingsPanel: document.getElementById('settingsPanel'),
    clockTime: document.getElementById('clockTime'),
    
    // Controls
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    favoriteBtn: document.getElementById('favoriteBtn'),
    deleteBtn: document.getElementById('deleteBtn'),
    rotateLeftBtn: document.getElementById('rotateLeftBtn'),
    rotateRightBtn: document.getElementById('rotateRightBtn'),
    infoBtn: document.getElementById('infoBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    
    // Settings
    modeSelect: document.getElementById('modeSelect'),
    orderSelect: document.getElementById('orderSelect'),
    intervalSelect: document.getElementById('intervalSelect'),
    favoritesOnlyCheck: document.getElementById('favoritesOnlyCheck'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
    resetDatabaseBtn: document.getElementById('resetDatabaseBtn'),
    
    // Info
    infoDate: document.getElementById('infoDate'),
    infoLocation: document.getElementById('infoLocation'),
    infoCamera: document.getElementById('infoCamera'),
    infoResolution: document.getElementById('infoResolution'),
    
    // Stats
    statTotal: document.getElementById('statTotal'),
    statFavorites: document.getElementById('statFavorites'),
    statDeleted: document.getElementById('statDeleted')
};

// Initialize app
async function init() {
    console.log('Initializing Picture Frame...');
    
    // Start clock
    updateClock();
    setInterval(updateClock, 1000);
    
    // Load current image
    await loadCurrentImage();
    
    // Setup event listeners
    setupEventListeners();
    
    // Auto-start slideshow
    startSlideshow();
    
    // Hide controls after delay
    showControls();
    
    console.log('Picture Frame initialized');
}

// API calls
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`/api${endpoint}`, options);
        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API call failed:', error);
        throw error;
    }
}

async function loadCurrentImage() {
    try {
        const data = await apiCall('/image/current');
        displayImage(data.image, data.preload);
        updateSettings(data.settings);
        preloadImages(data.preload);
    } catch (error) {
        console.error('Failed to load current image:', error);
        showNoImages();
    }
}

async function loadNextImage() {
    try {
        const data = await apiCall('/image/next');
        displayImage(data.image, data.preload);
        updateSettings(data.settings);
        preloadImages(data.preload);
    } catch (error) {
        console.error('Failed to load next image:', error);
    }
}

async function loadPreviousImage() {
    try {
        const data = await apiCall('/image/previous');
        displayImage(data.image, data.preload);
        updateSettings(data.settings);
        preloadImages(data.preload);
    } catch (error) {
        console.error('Failed to load previous image:', error);
    }
}

async function toggleFavorite() {
    if (!state.currentImage) return;
    
    try {
        const data = await apiCall(`/image/${state.currentImage.id}/favorite`, {
            method: 'POST'
        });
        
        state.currentImage.isFavorite = data.isFavorite;
        updateFavoriteButton();
    } catch (error) {
        console.error('Failed to toggle favorite:', error);
    }
}

async function deleteImage() {
    if (!state.currentImage) return;
    
    if (!confirm('Are you sure you want to delete this image?')) {
        return;
    }
    
    try {
        const data = await apiCall(`/image/${state.currentImage.id}`, {
            method: 'DELETE'
        });
        
        if (data.nextImage) {
            displayImage(data.nextImage, []);
        } else {
            showNoImages();
        }
    } catch (error) {
        console.error('Failed to delete image:', error);
    }
}

async function resetDatabase() {
    const confirmText = 'Are you ABSOLUTELY SURE you want to reset the entire database?\n\n' +
                       'This will:\n' +
                       '• Delete all favorites\n' +
                       '• Delete all rotations\n' +
                       '• Delete all location data\n' +
                       '• Re-index all photos from scratch\n\n' +
                       'This action CANNOT be undone!\n\n' +
                       'Type "RESET" to confirm:';
    
    const userInput = prompt(confirmText);
    
    if (userInput !== 'RESET') {
        alert('Database reset cancelled.');
        return;
    }
    
    try {
        // Show loading state
        elements.resetDatabaseBtn.disabled = true;
        elements.resetDatabaseBtn.textContent = 'Resetting...';
        
        const data = await apiCall('/database/reset', {
            method: 'POST'
        });
        
        if (data.success) {
            alert(`Database reset successful!\n\nRe-indexed ${data.stats.total} images.`);
            
            // Reload the page to refresh everything
            window.location.reload();
        }
    } catch (error) {
        console.error('Failed to reset database:', error);
        alert('Error: Failed to reset database. Check console for details.');
        elements.resetDatabaseBtn.disabled = false;
        elements.resetDatabaseBtn.textContent = 'Reset Database';
    }
}

async function saveSettings() {
    const newSettings = {
        mode: elements.modeSelect.value,
        order: elements.orderSelect.value,
        interval: parseInt(elements.intervalSelect.value),
        favoritesOnly: elements.favoritesOnlyCheck.checked
    };
    
    try {
        const data = await apiCall('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });
        
        updateSettings(data.settings);
        closeSettings();
        
        // Restart slideshow with new interval
        if (state.isPlaying) {
            stopSlideshow();
            startSlideshow();
        }
        
        // Reload current image if filters changed
        await loadCurrentImage();
    } catch (error) {
        console.error('Failed to save settings:', error);
        alert('Failed to save settings');
    }
}

async function loadStats() {
    try {
        const stats = await apiCall('/stats');
        elements.statTotal.textContent = stats.total;
        elements.statFavorites.textContent = stats.favorites;
        elements.statDeleted.textContent = stats.deleted;
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// Display functions
function displayImage(image, preloadImages = []) {
    if (!image) {
        showNoImages();
        return;
    }
    
    state.currentImage = image;
    
    const imageUrl = `/api/image/${image.id}/serve`;
    
    // Check if this is the first image load (no current image visible)
    const hasCurrentImage = elements.mainImage.classList.contains('current') && 
                           elements.mainImage.style.display !== 'none' &&
                           elements.mainImage.complete;
    
    if (!hasCurrentImage) {
        // First image load - no crossfade needed
        elements.mainImage.style.display = 'block';
        elements.mainImage.src = imageUrl;
        elements.mainImage.alt = image.filename;
        elements.mainImage.classList.add('current');
        elements.mainImage.classList.remove('next');
        elements.mainImage.style.opacity = '0';
        
        elements.mainImage.onload = () => {
            elements.mainImage.style.opacity = '1';
            updateInfoOverlay(image);
            updateLocationOverlay(image);
            updateFavoriteButton();
            elements.loadingIndicator.style.display = 'none';
            elements.noImagesMessage.style.display = 'none';
        };
        
        elements.mainImage.onerror = () => {
            console.error('Failed to load image:', imageUrl);
            showNoImages();
        };
    } else {
        // Subsequent images - use crossfade
        const currentImg = elements.mainImage.classList.contains('current') ? elements.mainImage : elements.nextImage;
        const nextImg = elements.mainImage.classList.contains('current') ? elements.nextImage : elements.mainImage;
        
        // If image is already loaded in nextImg, use it immediately
        if (nextImg.src === imageUrl && nextImg.complete) {
            // Image already loaded, swap immediately
            swapImages(currentImg, nextImg, image);
        } else {
            // Load new image
            nextImg.style.display = 'block';
            nextImg.src = imageUrl;
            nextImg.alt = image.filename;
            
            // Wait for image to load before crossfading
            nextImg.onload = () => {
                swapImages(currentImg, nextImg, image);
            };
            
            nextImg.onerror = () => {
                console.error('Failed to load image:', imageUrl);
                nextImg.style.display = 'none';
            };
        }
    }
    
    // Preload upcoming images
    if (preloadImages && preloadImages.length > 0) {
        preloadImages.forEach(preloadImg => {
            const img = new Image();
            img.src = `/api/image/${preloadImg.id}/serve`;
        });
    }
}

function swapImages(currentImg, nextImg, image) {
    // Crossfade: fade out current, fade in next
    currentImg.classList.remove('current');
    currentImg.classList.add('next');
    currentImg.style.opacity = '0';
    
    nextImg.classList.remove('next');
    nextImg.classList.add('current');
    nextImg.style.opacity = '1';
    
    // Hide current image after transition completes
    setTimeout(() => {
        if (!currentImg.classList.contains('current')) {
            currentImg.style.display = 'none';
        }
    }, 600);
    
    // Update info overlays
    updateInfoOverlay(image);
    updateLocationOverlay(image);
    updateFavoriteButton();
    
    elements.loadingIndicator.style.display = 'none';
    elements.noImagesMessage.style.display = 'none';
}

function showNoImages() {
    elements.mainImage.style.display = 'none';
    elements.nextImage.style.display = 'none';
    elements.loadingIndicator.style.display = 'none';
    elements.noImagesMessage.style.display = 'block';
    state.currentImage = null;
}

function updateInfoOverlay(image) {
    // Date
    if (image.dateTaken) {
        const date = new Date(image.dateTaken);
        elements.infoDate.textContent = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } else {
        elements.infoDate.textContent = '-';
    }
    
    // Location
    if (image.latitude && image.longitude) {
        elements.infoLocation.textContent = `${image.latitude.toFixed(4)}, ${image.longitude.toFixed(4)}`;
    } else {
        elements.infoLocation.textContent = '-';
    }
    
    // Camera
    if (image.cameraMake && image.cameraModel) {
        elements.infoCamera.textContent = `${image.cameraMake} ${image.cameraModel}`;
    } else if (image.cameraModel) {
        elements.infoCamera.textContent = image.cameraModel;
    } else {
        elements.infoCamera.textContent = '-';
    }
    
    // Resolution
    if (image.width && image.height) {
        elements.infoResolution.textContent = `${image.width} × ${image.height}`;
    } else {
        elements.infoResolution.textContent = '-';
    }
}

function updateLocationOverlay(image) {
    let displayText = '';
    
    // Add date taken if available
    if (image.dateTaken) {
        const date = new Date(image.dateTaken);
        const formattedDate = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        displayText = formattedDate;
    }
    
    // Add location if available
    let locationText = '';
    if (image.locationCity && image.locationCountry) {
        locationText = `${image.locationCity}, ${image.locationCountry}`;
    } else if (image.locationCity) {
        locationText = image.locationCity;
    } else if (image.locationCountry) {
        locationText = image.locationCountry;
    }
    
    // Combine date and location
    if (displayText && locationText) {
        displayText += ' · ' + locationText;
    } else if (locationText) {
        displayText = locationText;
    }
    
    // Show overlay if we have either date or location
    if (displayText) {
        elements.locationText.textContent = displayText;
        elements.locationOverlay.classList.remove('hidden');
    } else {
        elements.locationOverlay.classList.add('hidden');
    }
}

function updateFavoriteButton() {
    if (state.currentImage && state.currentImage.isFavorite) {
        elements.favoriteBtn.classList.add('favorite');
    } else {
        elements.favoriteBtn.classList.remove('favorite');
    }
}

async function rotateImage(direction) {
    if (!state.currentImage) return;
    
    try {
        const endpoint = direction === 'left' ? 'rotate-left' : 'rotate-right';
        const response = await apiCall(`/image/${state.currentImage.id}/${endpoint}`, {
            method: 'POST'
        });
        
        if (response.success) {
            console.log('Image physically rotated, reloading...');
            
            // Clear the image completely first
            const imageId = state.currentImage.id;
            elements.mainImage.src = '';
            
            // Force a small delay to ensure cache is cleared
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Reload with aggressive cache busting
            const cacheBuster = Date.now() + Math.random();
            elements.mainImage.src = `/api/image/${imageId}/serve?t=${cacheBuster}&nocache=1`;
            
            // Reset rotation state to 0
            state.currentImage.rotation = 0;
        }
    } catch (error) {
        console.error('Failed to rotate image:', error);
    }
}

function updateSettings(settings) {
    if (!settings) return;
    
    state.settings = settings;
    
    // Update settings panel
    elements.modeSelect.value = settings.mode;
    elements.orderSelect.value = settings.order;
    elements.intervalSelect.value = settings.interval.toString();
    elements.favoritesOnlyCheck.checked = settings.favoritesOnly;
}

function updateClock() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    
    elements.clockTime.textContent = `${displayHours}:${minutes} ${ampm}`;
}

function preloadImages(images) {
    if (!images || images.length === 0) return;
    
    images.forEach(image => {
        const img = new Image();
        img.src = `/api/image/${image.id}/serve`;
    });
}

// Slideshow controls
function startSlideshow() {
    if (state.isPlaying) return;
    
    state.isPlaying = true;
    updatePlayPauseButton();
    
    const interval = state.settings?.interval || 10;
    state.slideshowTimer = setInterval(() => {
        loadNextImage();
    }, interval * 1000);
    
    console.log(`Slideshow started (${interval}s interval)`);
}

function stopSlideshow() {
    if (!state.isPlaying) return;
    
    state.isPlaying = false;
    updatePlayPauseButton();
    
    if (state.slideshowTimer) {
        clearInterval(state.slideshowTimer);
        state.slideshowTimer = null;
    }
    
    console.log('Slideshow stopped');
}

function toggleSlideshow() {
    if (state.isPlaying) {
        stopSlideshow();
    } else {
        startSlideshow();
    }
}

function updatePlayPauseButton() {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    
    if (state.isPlaying) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
    } else {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
    }
}

// Controls visibility
function showControls() {
    document.body.classList.add('show-cursor');
    elements.controlOverlay.classList.add('visible');
    elements.bottomBar.classList.add('visible');
    state.controlsVisible = true;
    
    // Clear existing timer
    if (state.controlsTimer) {
        clearTimeout(state.controlsTimer);
    }
    
    // Hide after 5 seconds of inactivity
    state.controlsTimer = setTimeout(() => {
        hideControls();
    }, 5000);
}

// Debounced mouse move handler - only resets timer after mouse stops moving
function handleMouseMove() {
    // Show controls immediately on mouse move
    if (!state.controlsVisible) {
        showControls();
    }
    
    // Clear existing mouse move timer
    if (state.mouseMoveTimer) {
        clearTimeout(state.mouseMoveTimer);
    }
    
    // Reset the hide timer only after mouse has been still for 500ms
    state.mouseMoveTimer = setTimeout(() => {
        // Mouse has stopped moving, reset the hide timer
        if (state.controlsTimer) {
            clearTimeout(state.controlsTimer);
        }
        state.controlsTimer = setTimeout(() => {
            hideControls();
        }, 5000);
    }, 500);
}

function hideControls() {
    // Don't hide if settings panel is open
    if (!elements.settingsPanel.classList.contains('hidden')) {
        return;
    }
    
    document.body.classList.remove('show-cursor');
    elements.controlOverlay.classList.remove('visible');
    elements.bottomBar.classList.remove('visible');
    state.controlsVisible = false;
}

function toggleInfo() {
    state.infoVisible = !state.infoVisible;
    
    if (state.infoVisible) {
        elements.infoOverlay.classList.remove('hidden');
    } else {
        elements.infoOverlay.classList.add('hidden');
    }
}

function openSettings() {
    elements.settingsPanel.classList.remove('hidden');
    loadStats();
}

function closeSettings() {
    elements.settingsPanel.classList.add('hidden');
}

// Event listeners
function setupEventListeners() {
    // Navigation controls
    elements.prevBtn.addEventListener('click', () => {
        loadPreviousImage();
        showControls();
    });
    
    elements.nextBtn.addEventListener('click', () => {
        loadNextImage();
        showControls();
    });
    
    elements.playPauseBtn.addEventListener('click', () => {
        toggleSlideshow();
        showControls();
    });
    
    elements.favoriteBtn.addEventListener('click', () => {
        toggleFavorite();
        showControls();
    });
    
    elements.deleteBtn.addEventListener('click', () => {
        deleteImage();
        showControls();
    });
    
    elements.rotateLeftBtn.addEventListener('click', () => {
        rotateImage('left');
        showControls();
    });
    
    elements.rotateRightBtn.addEventListener('click', () => {
        rotateImage('right');
        showControls();
    });
    
    elements.infoBtn.addEventListener('click', () => {
        toggleInfo();
        showControls();
    });
    
    elements.settingsBtn.addEventListener('click', () => {
        openSettings();
        showControls();
    });
    
    // Settings panel
    elements.saveSettingsBtn.addEventListener('click', saveSettings);
    elements.cancelSettingsBtn.addEventListener('click', closeSettings);
    elements.resetDatabaseBtn.addEventListener('click', resetDatabase);
    
    // Mouse movement - use debounced handler
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('touchstart', showControls);
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        switch(e.key) {
            case 'ArrowLeft':
                loadPreviousImage();
                showControls();
                break;
            case 'ArrowRight':
            case ' ':
                if (e.key === ' ') {
                    e.preventDefault();
                    toggleSlideshow();
                } else {
                    loadNextImage();
                }
                showControls();
                break;
            case 'f':
            case 'F':
                toggleFavorite();
                showControls();
                break;
            case 'd':
            case 'D':
                deleteImage();
                showControls();
                break;
            case '[':
                rotateImage('left');
                showControls();
                break;
            case ']':
                rotateImage('right');
                showControls();
                break;
            case 'i':
            case 'I':
                toggleInfo();
                showControls();
                break;
            case 's':
            case 'S':
                if (!elements.settingsPanel.classList.contains('hidden')) {
                    closeSettings();
                } else {
                    openSettings();
                }
                showControls();
                break;
            case 'Escape':
                if (!elements.settingsPanel.classList.contains('hidden')) {
                    closeSettings();
                }
                if (state.infoVisible) {
                    toggleInfo();
                }
                break;
        }
    });
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


