// Application state
const state = {
    currentImage: null,
    settings: null,
    isPlaying: false,
    slideshowTimer: null,
    controlsVisible: false,
    controlsTimer: null,
    mouseMoveTimer: null,
    infoVisible: false,
    eventSource: null
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
    
    // Connect to SSE for real-time updates (will receive initial image via SSE)
    connectToSSE();
    
    // Setup event listeners
    setupEventListeners();
    
    // Hide controls after delay
    showControls();
    
    console.log('Picture Frame initialized - waiting for SSE updates');
}

// Connect to Server-Sent Events for real-time updates
function connectToSSE() {
    if (state.eventSource) {
        state.eventSource.close();
    }
    
    state.eventSource = new EventSource('/api/events');
    
    state.eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleSSEMessage(data);
        } catch (error) {
            console.error('Error parsing SSE message:', error);
        }
    };
    
    state.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
            if (state.eventSource && state.eventSource.readyState === EventSource.CLOSED) {
                console.log('Reconnecting to SSE...');
                connectToSSE();
            }
        }, 3000);
    };
    
    console.log('Connected to SSE stream');
}

// Handle SSE messages
function handleSSEMessage(data) {
    switch (data.type) {
        case 'image':
            // Update current image
            displayImage(data.image, data.preload);
            updateSettings(data.settings);
            state.isPlaying = data.isPlaying || false;
            updatePlayPauseButton();
            break;
            
        case 'favorite':
            // Update favorite status
            if (state.currentImage && state.currentImage.id === data.imageId) {
                state.currentImage.isFavorite = data.isFavorite;
                updateFavoriteButton();
            }
            break;
            
        case 'settings':
            // Update settings
            updateSettings(data.settings);
            break;
            
        case 'slideshowState':
            // Update slideshow play/pause state
            state.isPlaying = data.isPlaying || false;
            updatePlayPauseButton();
            break;
            
        default:
            console.log('Unknown SSE message type:', data.type);
    }
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

// Note: loadCurrentImage is kept for initial load, but SSE will handle updates

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
        
        // Server will handle slideshow interval update and broadcast new image if filters changed
        // No need to manually reload - SSE will handle it
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
        elements.mainImage.style.zIndex = '1'; // Ensure it's on top
        
        // Ensure nextImage is hidden and reset
        elements.nextImage.style.display = 'none';
        elements.nextImage.classList.remove('current', 'next');
        elements.nextImage.style.zIndex = '';
        
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
            // Load new image - set up as next image before loading
            nextImg.classList.remove('current');
            nextImg.classList.add('next');
            nextImg.style.display = 'block';
            nextImg.style.opacity = '0'; // Start invisible
            nextImg.style.zIndex = '2'; // Ensure it's above current during transition
            nextImg.src = imageUrl;
            nextImg.alt = image.filename;
            
            // Wait for image to load before crossfading
            nextImg.onload = () => {
                swapImages(currentImg, nextImg, image);
            };
            
            nextImg.onerror = () => {
                console.error('Failed to load image:', imageUrl);
                nextImg.style.display = 'none';
                nextImg.classList.remove('next');
                nextImg.style.zIndex = '';
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
    // Remove all classes from old image and ensure it's below the new one
    currentImg.classList.remove('current', 'next');
    currentImg.style.opacity = '0';
    currentImg.style.zIndex = '0'; // Ensure old image is below new one
    
    // Make new image the current one with proper z-index
    nextImg.classList.remove('next');
    nextImg.classList.add('current');
    nextImg.style.opacity = '1';
    nextImg.style.zIndex = '1'; // Ensure new image is on top
    
    // Hide old image after transition completes
    setTimeout(() => {
        if (!currentImg.classList.contains('current')) {
            currentImg.style.display = 'none';
            currentImg.style.zIndex = ''; // Reset z-index
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
    elements.mainImage.classList.remove('current', 'next');
    elements.mainImage.style.zIndex = '';
    elements.nextImage.style.display = 'none';
    elements.nextImage.classList.remove('current', 'next');
    elements.nextImage.style.zIndex = '';
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

// Slideshow controls - now server-side controlled
// The server manages the slideshow timer, clients just display the state
function startSlideshow() {
    // Server-side slideshow is always running
    // This function is kept for compatibility but doesn't control slideshow
    // The play/pause state comes from the server via SSE
    console.log('Slideshow is server-side controlled');
}

function stopSlideshow() {
    // Server-side slideshow is always running
    // This function is kept for compatibility but doesn't control slideshow
    // The play/pause state comes from the server via SSE
    console.log('Slideshow is server-side controlled');
}

async function toggleSlideshow() {
    // Server-side authoritative: request start/pause, then SSE will broadcast final state
    try {
        const endpoint = state.isPlaying ? '/slideshow/pause' : '/slideshow/start';
        await apiCall(endpoint, { method: 'POST' });
    } catch (error) {
        console.error('Failed to toggle slideshow:', error);
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


