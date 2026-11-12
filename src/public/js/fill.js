/* Fill screen: how to crop a landscape photo so it fills the screen.
 * Pure math, shared by the display (window.PictureFrameFill) and tests (require). */
(function (root) {
    // Faces shorter than this (fraction of the photo's height), or than a
    // third of the biggest face, are background people: they needn't fit.
    const MIN_FACE = 0.025;
    const MIN_FACE_RATIO = 1 / 3;
    // A face box runs from the eyebrows to the chin. Keep this much more
    // (fraction of the face's height) for hair above and chin/neck below.
    const PAD_ABOVE = 0.4;
    const PAD_BELOW = 0.15;
    const PAD_SIDE = 0.15;
    // No faces: where the crop sits in the croppable range (0 = top, 0.5 =
    // centered). 0.4 is slightly above center.
    const NO_FACE_POS = 0.4;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /** The faces that have to stay in the picture. */
    function mainFaces(faces) {
        const boxes = (Array.isArray(faces) ? faces : [])
            .filter(f => Array.isArray(f) && f.length >= 4 && f.every((n, i) => i > 3 || Number.isFinite(n)))
            .map(([x, y, w, h]) => ({ x, y, w, h }));
        const biggest = Math.max(0, ...boxes.map(b => b.h));
        return boxes.filter(b => b.h >= MIN_FACE && b.h >= biggest * MIN_FACE_RATIO);
    }

    /**
     * Where along one axis to place the visible window of size `visible`
     * (fraction of the photo), keeping every face span [start, end] in it.
     * @param {boolean} [force] - if the faces can't all fit, center on them anyway
     * @returns {number|null} percent for CSS object-position, or null if the faces can't all fit
     */
    function place(spans, visible, noFacePos, force) {
        const crop = 1 - visible;
        if (crop <= 1e-6) return 50;
        if (!spans.length) return noFacePos * 100;
        const rawStart = Math.min(...spans.map(s => s.start));
        const rawEnd = Math.max(...spans.map(s => s.end));
        const fits = rawEnd - rawStart <= visible + 1e-9;
        if (!fits && !force) return null;
        const padStart = Math.max(0, Math.min(...spans.map(s => s.padStart)));
        const padEnd = Math.min(1, Math.max(...spans.map(s => s.padEnd)));
        // Center on the faces with their padding, but never cut a face itself
        const want = (padStart + padEnd) / 2 - visible / 2;
        const offset = clamp(fits ? clamp(want, rawEnd - visible, rawStart) : want, 0, crop);
        return (offset / crop) * 100;
    }

    /**
     * Where to crop a photo of any shape so it fills a box (object-fit: cover).
     * @param {object} p - imgW, imgH, boxW, boxH, faces (see compute), force (see place)
     * @returns {{fill: boolean, reason: string, crop: number, x?: number, y?: number}}
     */
    function position({ imgW, imgH, boxW, boxH, faces, force }) {
        const imgAR = imgW / imgH;
        const boxAR = boxW / boxH;
        const tall = imgAR <= boxAR;              // narrower than the box: crop top/bottom
        const visible = tall ? imgAR / boxAR : boxAR / imgAR;
        const crop = 1 - visible;
        const main = mainFaces(faces);
        const spans = main.map(b => tall
            ? { start: b.y, end: b.y + b.h, padStart: b.y - PAD_ABOVE * b.h, padEnd: b.y + b.h + PAD_BELOW * b.h }
            : { start: b.x, end: b.x + b.w, padStart: b.x - PAD_SIDE * b.w, padEnd: b.x + b.w + PAD_SIDE * b.w });
        const pos = place(spans, visible, tall ? NO_FACE_POS : 0.5, force);
        if (pos === null) return { fill: false, reason: 'faces do not fit', crop };
        const reason = main.length ? 'faces' : 'no faces';
        return tall ? { fill: true, reason, crop, x: 50, y: pos } : { fill: true, reason, crop, x: pos, y: 50 };
    }

    /**
     * @param {object} p
     * @param {number} p.imgW, p.imgH - the photo as displayed (upright)
     * @param {number} p.screenW, p.screenH - the area it fills
     * @param {Array|null} p.faces - [[x, y, w, h, confidence], ...] normalized, top-left origin
     * @param {number} p.maxCrop - most of the photo that may be cut off, in percent
     * @returns {{fill: boolean, reason: string, crop?: number, x?: number, y?: number}}
     *   x/y are CSS object-position percentages
     */
    function compute({ imgW, imgH, screenW, screenH, faces, maxCrop }) {
        if (!(imgW > 0 && imgH > 0 && screenW > 0 && screenH > 0)) return { fill: false, reason: 'no size' };
        if (imgW <= imgH) return { fill: false, reason: 'not landscape' };
        const imgAR = imgW / imgH;
        const screenAR = screenW / screenH;
        const crop = 1 - Math.min(imgAR, screenAR) / Math.max(imgAR, screenAR);
        if (crop * 100 > maxCrop + 1e-6) return { fill: false, reason: 'too much crop', crop };
        return position({ imgW, imgH, boxW: screenW, boxH: screenH, faces, force: false });
    }

    const api = { compute, position, mainFaces };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PictureFrameFill = api;
})(typeof window !== 'undefined' ? window : this);
