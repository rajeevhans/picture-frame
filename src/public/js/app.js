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
    eventSource: null,
    deleteTimeout: null,
    pendingDeletion: null
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
    undoBtn: document.getElementById('undoBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
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
    infoFilename: document.getElementById('infoFilename'),
    infoFileType: document.getElementById('infoFileType'),
    infoDate: document.getElementById('infoDate'),
    infoLocation: document.getElementById('infoLocation'),
    infoCamera: document.getElementById('infoCamera'),
    infoResolution: document.getElementById('infoResolution'),
    infoTags: document.getElementById('infoTags'),
    
    // Stats
    statTotal: document.getElementById('statTotal'),
    statFavorites: document.getElementById('statFavorites'),
    statDeleted: document.getElementById('statDeleted'),
    
    // Matting
    mattingBackground: document.getElementById('mattingBackground')
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
            if (typeof data.isPlaying === 'boolean') {
                state.isPlaying = data.isPlaying;
            }
            updatePlayPauseButton();
            // Matting background will be applied in displayImage's onload handler
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
            if (typeof data.isPlaying === 'boolean') {
                state.isPlaying = data.isPlaying;
            }
            updatePlayPauseButton();
            break;

        case 'rotate':
            // Reload the currently displayed image with aggressive cache busting
            if (state.currentImage && state.currentImage.id === data.imageId) {
                const t = data.cacheBuster || (Date.now() + Math.random());
                const currentEl = elements.mainImage.classList.contains('current') ? elements.mainImage : elements.nextImage;
                const imageId = state.currentImage.id;
                
                // Create a temporary image to preload the rotated version
                const tempImg = new Image();
                const newImageUrl = `/api/image/${imageId}/serve?t=${t}&nocache=1`;
                
                tempImg.onload = async () => {
                    // Once loaded, update the current image
                    currentEl.src = newImageUrl;
                    console.log('SSE: Rotated image reloaded successfully');
                    // Apply matting background for rotated image
                    await applyMattingBackground(currentEl);
                };
                
                tempImg.onerror = () => {
                    console.error('SSE: Failed to reload rotated image');
                    // Fallback: try without cache busting
                    currentEl.src = `/api/image/${imageId}/serve?nocache=1`;
                };
                
                // Start preloading
                tempImg.src = newImageUrl;
            }
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
    // Cancel any pending deletion when navigating
    if (state.deleteTimeout) {
        clearTimeout(state.deleteTimeout);
        state.deleteTimeout = null;
        if (state.pendingDeletion) {
            const { imageElement } = state.pendingDeletion;
            imageElement.classList.remove('deleting');
            elements.undoBtn.style.display = 'none';
            elements.undoBtn.classList.remove('visible');
            state.pendingDeletion = null;
        }
    }
    
    try {
        // Server broadcasts the resulting image via SSE.
        // Avoid rendering twice (API response + SSE), which causes jittery transitions.
        const data = await apiCall('/image/next');

        // Fallback: if SSE isn't connected, use the response to update the UI.
        if (!state.eventSource || state.eventSource.readyState !== EventSource.OPEN) {
            displayImage(data.image, data.preload);
            updateSettings(data.settings);
            preloadImages(data.preload);
        }
    } catch (error) {
        console.error('Failed to load next image:', error);
    }
}

async function loadPreviousImage() {
    // Cancel any pending deletion when navigating
    if (state.deleteTimeout) {
        clearTimeout(state.deleteTimeout);
        state.deleteTimeout = null;
        if (state.pendingDeletion) {
            const { imageElement } = state.pendingDeletion;
            imageElement.classList.remove('deleting');
            elements.undoBtn.style.display = 'none';
            elements.undoBtn.classList.remove('visible');
            state.pendingDeletion = null;
        }
    }
    
    try {
        // Server broadcasts the resulting image via SSE.
        const data = await apiCall('/image/previous');

        // Fallback: if SSE isn't connected, use the response to update the UI.
        if (!state.eventSource || state.eventSource.readyState !== EventSource.OPEN) {
            displayImage(data.image, data.preload);
            updateSettings(data.settings);
            preloadImages(data.preload);
        }
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
    
    // Cancel any pending deletion
    if (state.deleteTimeout) {
        clearTimeout(state.deleteTimeout);
        state.deleteTimeout = null;
    }
    
    // Store the deleted image ID and reference
    const deletedImageId = state.currentImage.id;
    const deletedImage = state.currentImage;
    
    // Find which image element is currently showing
    const currentImg = elements.mainImage.classList.contains('current') ? elements.mainImage : elements.nextImage;
    
    // Store pending deletion info
    state.pendingDeletion = {
        imageId: deletedImageId,
        image: deletedImage,
        imageElement: currentImg
    };
    
    // Add deletion animation class
    currentImg.classList.add('deleting');
    
    // Show undo button
    elements.undoBtn.style.display = 'flex';
    elements.undoBtn.classList.add('visible');
    
    // Start deletion countdown (5 seconds)
    state.deleteTimeout = setTimeout(async () => {
        // Hide undo button
        elements.undoBtn.style.display = 'none';
        elements.undoBtn.classList.remove('visible');
        
        // Hide the deleted image
        currentImg.style.display = 'none';
        currentImg.classList.remove('current', 'next', 'deleting');
        
        // Clear state
        state.currentImage = null;
        state.pendingDeletion = null;
        state.deleteTimeout = null;
        
        try {
            // Make delete request (server handles deletion in background)
            const data = await apiCall(`/image/${deletedImageId}`, {
                method: 'DELETE'
            });

            // Server broadcasts the resulting image via SSE.
            // Fallback: if SSE isn't connected, use response to advance immediately.
            if (!state.eventSource || state.eventSource.readyState !== EventSource.OPEN) {
                if (data.nextImage) {
                    displayImage(data.nextImage, []);
                } else {
                    showNoImages();
                }
            }
        } catch (error) {
            console.error('Failed to delete image:', error);
            // On error, ensure we show no images state
            showNoImages();
        }
    }, 5000); // 5 second delay
}

function undoDelete() {
    if (!state.pendingDeletion || !state.deleteTimeout) return;
    
    // Cancel the deletion timeout
    clearTimeout(state.deleteTimeout);
    state.deleteTimeout = null;
    
    // Restore the image
    const { imageElement, image } = state.pendingDeletion;
    
    // Remove deletion animation class
    imageElement.classList.remove('deleting');
    
    // Restore current image state
    state.currentImage = image;
    
    // Clear pending deletion
    state.pendingDeletion = null;
    
    // Hide undo button
    elements.undoBtn.style.display = 'none';
    elements.undoBtn.classList.remove('visible');
    
    // Update UI
    updateFavoriteButton();
    updateInfoOverlay(image);
    updateLocationOverlay(image);
    
    console.log('Delete operation cancelled');
}

function downloadImage() {
    if (!state.currentImage) return;
    
    try {
        // Create a temporary anchor element to trigger download
        const downloadUrl = `/api/image/${state.currentImage.id}/download`;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = ''; // Let the server set the filename
        link.style.display = 'none';
        
        // Add to DOM, click, and remove
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        console.log(`Downloading image: ${state.currentImage.filename}`);
    } catch (error) {
        console.error('Failed to download image:', error);
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
    
    // Cancel any pending deletion when a new image is displayed (e.g., via SSE)
    if (state.deleteTimeout && state.pendingDeletion && state.pendingDeletion.imageId !== image.id) {
        clearTimeout(state.deleteTimeout);
        state.deleteTimeout = null;
        if (state.pendingDeletion.imageElement) {
            state.pendingDeletion.imageElement.classList.remove('deleting');
        }
        elements.undoBtn.style.display = 'none';
        elements.undoBtn.classList.remove('visible');
        state.pendingDeletion = null;
    }
    
    state.currentImage = image;
    
    const imageUrl = `/api/image/${image.id}/serve`;
    
    // Check if this is the first image load (no current image visible)
    // After delete, DOM elements are cleared so this will be false, forcing fresh load
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
        elements.mainImage.style.zIndex = '2'; // Ensure it's above matting
        
        // Ensure nextImage is hidden and reset
        elements.nextImage.style.display = 'none';
        elements.nextImage.classList.remove('current', 'next');
        elements.nextImage.style.zIndex = '';
        
        elements.mainImage.onload = async () => {
            elements.mainImage.style.opacity = '1';
            updateInfoOverlay(image);
            updateLocationOverlay(image);
            updateFavoriteButton();
            elements.loadingIndicator.style.display = 'none';
            elements.noImagesMessage.style.display = 'none';
            
            // Apply matting background based on image colors
            // Small delay to ensure image is fully rendered
            setTimeout(async () => {
                await applyMattingBackground(elements.mainImage);
            }, 100);
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
            // Apply matting background for the already-loaded image
            setTimeout(async () => {
                await applyMattingBackground(nextImg);
            }, 100);
        } else {
            // Load new image - set up as next image before loading
            nextImg.classList.remove('current');
            nextImg.classList.add('next');
            nextImg.style.display = 'block';
            nextImg.style.opacity = '0'; // Start invisible
            nextImg.style.zIndex = '3'; // Ensure it's above current during transition
            nextImg.src = imageUrl;
            nextImg.alt = image.filename;
            
            // Wait for image to load before crossfading
            nextImg.onload = async () => {
                swapImages(currentImg, nextImg, image);
                
                // Apply matting background for the new image
                // Small delay to ensure image is fully rendered
                setTimeout(async () => {
                    await applyMattingBackground(nextImg);
                }, 100);
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
    currentImg.style.zIndex = '1'; // Old image below new one but above matting
    
    // Make new image the current one with proper z-index
    nextImg.classList.remove('next');
    nextImg.classList.add('current');
    nextImg.style.opacity = '1';
    nextImg.style.zIndex = '2'; // New image on top
    
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
    
    // Reset matting background to default
    elements.mattingBackground.style.opacity = '0';
    elements.mattingBackground.style.background = '';
}

function updateInfoOverlay(image) {
    // Filename
    if (image.filename) {
        elements.infoFilename.textContent = image.filename;
    } else {
        elements.infoFilename.textContent = '-';
    }
    
    // File Type (extract from filename extension)
    if (image.filename) {
        const ext = image.filename.split('.').pop().toUpperCase();
        // Map common extensions to readable names
        const typeMap = {
            'JPG': 'JPEG',
            'JPEG': 'JPEG',
            'PNG': 'PNG',
            'GIF': 'GIF',
            'WEBP': 'WebP',
            'HEIC': 'HEIC',
            'HEIF': 'HEIF'
        };
        elements.infoFileType.textContent = typeMap[ext] || ext;
    } else {
        elements.infoFileType.textContent = '-';
    }
    
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
    
    // Tags
    if (image.tags && Array.isArray(image.tags) && image.tags.length > 0) {
        elements.infoTags.textContent = image.tags.join(', ');
    } else {
        elements.infoTags.textContent = '-';
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
            
            // Get the current image element
            const currentImg = elements.mainImage.classList.contains('current') ? elements.mainImage : elements.nextImage;
            const imageId = state.currentImage.id;
            
            // Create a new image element to preload the rotated image
            const tempImg = new Image();
            const cacheBuster = Date.now() + Math.random();
            const newImageUrl = `/api/image/${imageId}/serve?t=${cacheBuster}&nocache=1`;
            
            tempImg.onload = async () => {
                // Once the rotated image is loaded, update the display
                currentImg.src = newImageUrl;
                // Reset rotation state to 0 since we physically rotated the file
                if (state.currentImage) {
                    state.currentImage.rotation = 0;
                }
                console.log('Rotated image reloaded successfully');
                // Apply matting background for rotated image
                await applyMattingBackground(currentImg);
            };
            
            tempImg.onerror = () => {
                console.error('Failed to reload rotated image');
                // Fallback: try to reload without cache busting
                currentImg.src = `/api/image/${imageId}/serve?nocache=1`;
            };
            
            // Start loading the rotated image
            tempImg.src = newImageUrl;
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

// Extract dominant colors from an image
async function extractDominantColors(imageElement, colorCount = 3) {
    return new Promise((resolve) => {
        try {
            // Ensure image is loaded
            if (!imageElement.complete) {
                console.warn('Image not complete, waiting...');
                imageElement.onload = () => {
                    extractDominantColors(imageElement, colorCount).then(resolve);
                };
                imageElement.onerror = () => {
                    console.error('Image failed to load for color extraction');
                    resolve([
                        { r: 60, g: 60, b: 60 },
                        { r: 80, g: 80, b: 80 },
                        { r: 100, g: 100, b: 100 }
                    ]);
                };
                return;
            }
            
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Get actual image dimensions
            const imgWidth = imageElement.naturalWidth || imageElement.width;
            const imgHeight = imageElement.naturalHeight || imageElement.height;
            
            // Check if we have valid dimensions
            if (!imgWidth || !imgHeight || imgWidth === 0 || imgHeight === 0) {
                console.warn('Invalid image dimensions:', imgWidth, imgHeight);
                resolve([
                    { r: 60, g: 60, b: 60 },
                    { r: 80, g: 80, b: 80 },
                    { r: 100, g: 100, b: 100 }
                ]);
                return;
            }
            
            // Set canvas size (smaller for performance, but large enough for accuracy)
            const maxSize = 200;
            const aspectRatio = imgWidth / imgHeight;
            
            let canvasWidth, canvasHeight;
            if (aspectRatio > 1) {
                canvasWidth = maxSize;
                canvasHeight = Math.round(maxSize / aspectRatio);
            } else {
                canvasWidth = Math.round(maxSize * aspectRatio);
                canvasHeight = maxSize;
            }
            
            // Ensure minimum canvas size
            if (canvasWidth < 10 || canvasHeight < 10) {
                console.warn('Canvas too small:', canvasWidth, canvasHeight);
                resolve([
                    { r: 60, g: 60, b: 60 },
                    { r: 80, g: 80, b: 80 },
                    { r: 100, g: 100, b: 100 }
                ]);
                return;
            }
            
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            
            // Draw image to canvas
            try {
                ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
            } catch (drawError) {
                console.error('Error drawing image to canvas (possible CORS issue):', drawError);
                resolve([
                    { r: 40, g: 40, b: 40 },
                    { r: 60, g: 60, b: 60 },
                    { r: 80, g: 80, b: 80 }
                ]);
                return;
            }
            
            // Get image data
            let imageData;
            try {
                imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            } catch (dataError) {
                console.error('Error getting image data (possible CORS issue):', dataError);
                resolve([
                    { r: 40, g: 40, b: 40 },
                    { r: 60, g: 60, b: 60 },
                    { r: 80, g: 80, b: 80 }
                ]);
                return;
            }
            
            const data = imageData.data;
            
            // Sample pixels (every Nth pixel for performance)
            const sampleRate = 5;
            const colors = [];
            
            for (let i = 0; i < data.length; i += 4 * sampleRate) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const a = data[i + 3];
                
                // Skip transparent pixels
                if (a < 128) continue;
                
                // Convert to HSL for better color grouping
                const hsl = rgbToHsl(r, g, b);
                
                // Skip very dark or very light colors (they don't make good matting)
                if (hsl[2] < 0.15 || hsl[2] > 0.9) continue;
                
                // Calculate colorfulness score (prefer colorful over gray)
                const colorfulness = hsl[1] * hsl[2]; // saturation * lightness
                
                colors.push({ r, g, b, hsl, colorfulness });
            }
            
            if (colors.length === 0) {
                console.log('No suitable colors found, using fallback');
                // Fallback to neutral colors (brighter so we can see it's working)
                resolve([
                    { r: 60, g: 60, b: 60 },
                    { r: 80, g: 80, b: 80 },
                    { r: 100, g: 100, b: 100 }
                ]);
                return;
            }
            
            // Group similar colors and find dominant ones
            const dominantColors = findDominantColors(colors, colorCount);
            
            console.log('Extracted colors:', dominantColors);
            resolve(dominantColors);
        } catch (error) {
            console.error('Error extracting colors:', error);
            // Fallback to neutral gray (brighter so we can see it's working)
            resolve([
                { r: 60, g: 60, b: 60 },
                { r: 80, g: 80, b: 80 },
                { r: 100, g: 100, b: 100 }
            ]);
        }
    });
}

// Convert RGB to HSL
function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    
    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    
    return [h, s, l];
}

// Find dominant colors using k-means-like clustering
function findDominantColors(colors, count) {
    if (colors.length === 0) return [];
    
    // Sort by colorfulness (saturation * lightness) to prioritize vibrant colors
    colors.sort((a, b) => (b.colorfulness || 0) - (a.colorfulness || 0));
    
    // Take the most colorful colors, but ensure we get variety
    const dominant = [];
    const usedHues = new Set();
    const hueTolerance = 0.1; // Colors within this hue difference are considered similar
    
    for (const color of colors) {
        if (dominant.length >= count) break;
        
        const hue = color.hsl[0];
        let isSimilar = false;
        
        // Check if we already have a similar hue
        for (const usedHue of usedHues) {
            const hueDiff = Math.min(
                Math.abs(hue - usedHue),
                Math.abs(hue - usedHue + 1),
                Math.abs(hue - usedHue - 1)
            );
            if (hueDiff < hueTolerance) {
                isSimilar = true;
                break;
            }
        }
        
        // If not similar, add it
        if (!isSimilar) {
            usedHues.add(hue);
            // Adjust brightness for matting (preserve more saturation)
            const adjusted = adjustColorForMatting(color);
            dominant.push(adjusted);
        }
    }
    
    // If we don't have enough colors, fill with remaining most colorful ones
    if (dominant.length < count) {
        for (const color of colors) {
            if (dominant.length >= count) break;
            const hue = color.hsl[0];
            let alreadyAdded = false;
            for (const usedHue of usedHues) {
                const hueDiff = Math.min(
                    Math.abs(hue - usedHue),
                    Math.abs(hue - usedHue + 1),
                    Math.abs(hue - usedHue - 1)
                );
                if (hueDiff < hueTolerance) {
                    alreadyAdded = true;
                    break;
                }
            }
            if (!alreadyAdded) {
                usedHues.add(hue);
                const adjusted = adjustColorForMatting(color);
                dominant.push(adjusted);
            }
        }
    }
    
    return dominant;
}

// Adjust color to be suitable for matting (preserve more vibrancy)
function adjustColorForMatting(color) {
    const hsl = color.hsl;
    
    // Preserve more saturation (only reduce by 20% instead of 50%)
    const newSaturation = Math.max(0.2, Math.min(0.8, hsl[1] * 0.8));
    
    // Slightly darken for matting effect (reduce by 15% instead of 30%)
    const newLightness = Math.max(0.25, Math.min(0.75, hsl[2] * 0.85));
    
    // Convert back to RGB
    const rgb = hslToRgb(hsl[0], newSaturation, newLightness);
    
    return {
        r: Math.round(rgb[0]),
        g: Math.round(rgb[1]),
        b: Math.round(rgb[2])
    };
}

// Convert HSL to RGB
function hslToRgb(h, s, l) {
    let r, g, b;
    
    if (s === 0) {
        r = g = b = l; // achromatic
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    
    return [r * 255, g * 255, b * 255];
}

// Apply matting background using dominant colors
async function applyMattingBackground(imageElement) {
    try {
        if (!imageElement || !elements.mattingBackground) {
            console.warn('Missing image element or matting background element');
            return;
        }
        
        // Wait for image to be fully loaded with retries
        let retries = 0;
        const maxRetries = 10;
        
        while (retries < maxRetries) {
            const imgWidth = imageElement.naturalWidth || imageElement.width;
            const imgHeight = imageElement.naturalHeight || imageElement.height;
            
            if (imageElement.complete && imgWidth > 0 && imgHeight > 0) {
                break; // Image is ready
            }
            
            // Wait a bit and check again
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
        }
        
        // Final check dimensions
        const imgWidth = imageElement.naturalWidth || imageElement.width;
        const imgHeight = imageElement.naturalHeight || imageElement.height;
        
        if (!imgWidth || !imgHeight || imgWidth === 0 || imgHeight === 0) {
            console.warn('Image has no dimensions after waiting, skipping matting. Image src:', imageElement.src);
            return;
        }
        
        console.log('Extracting colors from image:', imgWidth, 'x', imgHeight, 'src:', imageElement.src.substring(0, 50));
        const colors = await extractDominantColors(imageElement, 3);
        
        if (!colors || colors.length === 0) {
            console.warn('No colors extracted, using fallback');
            // Fallback to dark background
            elements.mattingBackground.style.background = '#0a0a0a';
            elements.mattingBackground.style.opacity = '1';
            return;
        }
        
        // Create gradient from dominant colors
        // Use the colors to create a radial gradient that complements the image
        const primaryColor = colors[0];
        const secondaryColor = colors[colors.length > 1 ? 1 : colors[0]];
        const tertiaryColor = colors[colors.length > 2 ? 2 : colors[0]];
        
        // Create a more vibrant radial gradient for matting effect
        // Higher opacity to show colors better, with texture overlay
        const gradient = `radial-gradient(ellipse at center, 
            rgba(${primaryColor.r}, ${primaryColor.g}, ${primaryColor.b}, 0.6) 0%, 
            rgba(${secondaryColor.r}, ${secondaryColor.g}, ${secondaryColor.b}, 0.5) 30%,
            rgba(${tertiaryColor.r}, ${tertiaryColor.g}, ${tertiaryColor.b}, 0.4) 60%,
            rgba(${Math.round(primaryColor.r * 0.3)}, ${Math.round(primaryColor.g * 0.3)}, ${Math.round(primaryColor.b * 0.3)}, 0.8) 100%)`;
        
        console.log('Applying matting gradient with colors:', 
            `rgb(${primaryColor.r},${primaryColor.g},${primaryColor.b})`,
            `rgb(${secondaryColor.r},${secondaryColor.g},${secondaryColor.b})`,
            `rgb(${tertiaryColor.r},${tertiaryColor.g},${tertiaryColor.b})`);
        
        elements.mattingBackground.style.background = gradient;
        elements.mattingBackground.style.opacity = '1';
    } catch (error) {
        console.error('Error applying matting background:', error);
        // Fallback to dark background
        if (elements.mattingBackground) {
            elements.mattingBackground.style.background = '#0a0a0a';
            elements.mattingBackground.style.opacity = '1';
        }
    }
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
    
    elements.undoBtn.addEventListener('click', () => {
        undoDelete();
        showControls();
    });
    
    elements.downloadBtn.addEventListener('click', () => {
        downloadImage();
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
            case 'u':
            case 'U':
                if (state.deleteTimeout) {
                    undoDelete();
                    showControls();
                }
                break;
            case 'z':
            case 'Z':
                if ((e.ctrlKey || e.metaKey) && state.deleteTimeout) {
                    e.preventDefault();
                    undoDelete();
                    showControls();
                }
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
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+S or Cmd+S for download
                    e.preventDefault();
                    downloadImage();
                    showControls();
                } else {
                    // Regular S for settings
                    if (!elements.settingsPanel.classList.contains('hidden')) {
                        closeSettings();
                    } else {
                        openSettings();
                    }
                    showControls();
                }
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


