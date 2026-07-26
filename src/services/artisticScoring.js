const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');

const SCORING_PROMPT = `Evaluate this photograph's artistic quality. Score each category as an integer from 1 to 1000000 where 1 is terrible and 1000000 is a masterpiece.

Categories:
- composition: framing, rule of thirds, leading lines, balance, symmetry
- lighting: exposure, dynamic range, use of light/shadow, golden hour
- color: color harmony, palette, saturation, white balance
- subject: clarity of subject, focus, depth of field, interest
- creativity: uniqueness, mood, storytelling, artistic intent

Return ONLY valid JSON with no other text:
{"overall":X,"composition":X,"lighting":X,"color":X,"subject":X,"creativity":X}`;

class ArtisticScoringService {
    constructor(config = {}) {
        this.client = new Anthropic({ apiKey: config.apiKey });
        this.model = config.model || 'claude-sonnet-4-20250514';
        this.rateLimitMs = config.rateLimitMs || 1000;
        this.maxImageSize = config.maxImageSize || 1024;
        this.lastRequestTime = 0;
    }

    async scoreImage(filepath) {
        const ext = path.extname(filepath).toLowerCase();
        let buffer;
        let mediaType;

        // Read and prepare image
        const rawBuffer = fs.readFileSync(filepath);

        if (['.heic', '.heif'].includes(ext)) {
            // Convert HEIC/HEIF to JPEG via sharp
            buffer = await sharp(rawBuffer)
                .resize(this.maxImageSize, this.maxImageSize, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            mediaType = 'image/jpeg';
        } else {
            // Resize to reduce API cost
            buffer = await sharp(rawBuffer)
                .resize(this.maxImageSize, this.maxImageSize, { fit: 'inside', withoutEnlargement: true })
                .toBuffer();

            const typeMap = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp'
            };
            mediaType = typeMap[ext] || 'image/jpeg';
        }

        const base64Data = buffer.toString('base64');

        // Rate limiting
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.rateLimitMs) {
            await this.sleep(this.rateLimitMs - timeSinceLastRequest);
        }

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Data
                        }
                    },
                    {
                        type: 'text',
                        text: SCORING_PROMPT
                    }
                ]
            }]
        });

        this.lastRequestTime = Date.now();

        // Parse the response
        const text = response.content[0].text.trim();
        return this.parseScoreResponse(text);
    }

    parseScoreResponse(text) {
        // Try direct JSON parse first
        try {
            const parsed = JSON.parse(text);
            if (this.isValidScore(parsed)) {
                return parsed;
            }
        } catch (e) {
            // Fall through to regex extraction
        }

        // Try extracting JSON from the text
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (this.isValidScore(parsed)) {
                    return parsed;
                }
            } catch (e) {
                // Fall through
            }
        }

        throw new Error(`Failed to parse score response: ${text.substring(0, 200)}`);
    }

    isValidScore(obj) {
        const keys = ['overall', 'composition', 'lighting', 'color', 'subject', 'creativity'];
        return keys.every(k => typeof obj[k] === 'number' && obj[k] >= 1 && obj[k] <= 1000000);
    }

    async batchScore(images, updateCallback) {
        console.log(`Starting artistic scoring for ${images.length} images...`);
        let scored = 0;
        let errors = 0;

        for (const image of images) {
            try {
                const scores = await this.scoreImage(image.filepath);

                await updateCallback(image.id, {
                    artisticScore: scores.overall,
                    artisticScoreDetails: scores
                });

                scored++;
                console.log(`Artistic score for image ${image.id} (${image.filename}): ${scores.overall.toLocaleString()}`);
            } catch (error) {
                errors++;
                console.error(`Failed to score image ${image.id} (${image.filename}):`, error.message);
            }
        }

        console.log(`Artistic scoring batch complete: ${scored} scored, ${errors} errors`);
        return { scored, errors };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ArtisticScoringService;
