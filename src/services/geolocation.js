const https = require('https');

class GeolocationService {
    constructor() {
        this.cache = new Map();
        this.requestQueue = [];
        this.isProcessing = false;
        // Rate limiting: 1 request per second for Nominatim
        this.rateLimitMs = 1000;
        this.lastRequestTime = 0;
    }

    /**
     * Reverse geocode coordinates to get city and country
     * @param {number} latitude 
     * @param {number} longitude 
     * @returns {Promise<{city: string|null, country: string|null}>}
     */
    async reverseGeocode(latitude, longitude) {
        // Check cache first
        const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        // Add to queue and process
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ latitude, longitude, resolve, reject, cacheKey });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const request = this.requestQueue.shift();

        try {
            // Rate limiting
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.rateLimitMs) {
                await this.sleep(this.rateLimitMs - timeSinceLastRequest);
            }

            const result = await this.makeRequest(request.latitude, request.longitude);
            
            // Cache the result
            this.cache.set(request.cacheKey, result);
            
            // Update last request time
            this.lastRequestTime = Date.now();
            
            request.resolve(result);
        } catch (error) {
            console.error(`Geolocation lookup failed for ${request.latitude},${request.longitude}:`, error.message);
            // Return null values on error
            const nullResult = { city: null, country: null };
            request.resolve(nullResult);
        } finally {
            this.isProcessing = false;
            // Process next item in queue
            if (this.requestQueue.length > 0) {
                setTimeout(() => this.processQueue(), this.rateLimitMs);
            }
        }
    }

    makeRequest(latitude, longitude) {
        return new Promise((resolve, reject) => {
            const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1&accept-language=en`;
            
            const options = {
                headers: {
                    'User-Agent': 'PictureFrame/1.0' // Required by Nominatim
                }
            };

            https.get(url, options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const address = json.address || {};
                        
                        // Extract city (try various fields)
                        let city = address.city || 
                                    address.town || 
                                    address.village || 
                                    address.hamlet ||
                                    address.suburb ||
                                    address.county ||
                                    null;
                        
                        // Clean up city name - remove common prefixes
                        if (city) {
                            city = city.replace(/^(City of|Town of|Village of|Borough of)\s+/i, '');
                        }
                        
                        // Extract country
                        const country = address.country || null;
                        
                        resolve({ city, country });
                    } catch (error) {
                        reject(new Error('Failed to parse geolocation response'));
                    }
                });
            }).on('error', (error) => {
                reject(error);
            });
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Batch lookup locations for multiple images
     * @param {Array} images - Array of image objects with latitude/longitude
     * @param {Function} updateCallback - Callback function to update each image
     */
    async batchLookup(images, updateCallback) {
        console.log(`Starting geolocation lookup for ${images.length} images...`);
        
        for (const image of images) {
            try {
                const { city, country } = await this.reverseGeocode(image.latitude, image.longitude);
                
                if (city || country) {
                    await updateCallback(image.id, { locationCity: city, locationCountry: country });
                    console.log(`Location found for image ${image.id}: ${city}, ${country}`);
                }
            } catch (error) {
                console.error(`Failed to lookup location for image ${image.id}:`, error.message);
            }
        }
        
        console.log('Geolocation lookup complete');
    }
}

module.exports = GeolocationService;

