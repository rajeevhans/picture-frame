/**
 * Scalable near-duplicate grouping via banding (multi-index hashing) + union-find.
 *
 * Splits each 16-hex (64-bit) hash into (threshold+1) nibble-segments. By the
 * pigeonhole principle, any two hashes within `threshold` differing bits must
 * share at least one identical segment, so candidate pairs are exactly those
 * that collide in some segment bucket. Each candidate is verified with the true
 * Hamming distance; verified pairs are unioned. A same-component short-circuit
 * skips verification for pairs already connected (keeps dense buckets cheap).
 *
 * Exact for the given threshold (no missed pairs) as long as segments = threshold+1.
 */
const { hammingDistance } = require('./perceptualHash');

/** Split `total` nibbles into `m` contiguous segments as evenly as possible. */
function segmentRanges(m, total = 16) {
    const ranges = [];
    let start = 0;
    for (let s = 0; s < m; s++) {
        const len = Math.floor(total / m) + (s < (total % m) ? 1 : 0);
        ranges.push([start, len]);
        start += len;
    }
    return ranges;
}

function groupSimilar(items, threshold) {
    const n = items.length;
    const parent = new Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    const m = threshold + 1;
    const ranges = segmentRanges(m);

    // Bucket item indices by (segmentIndex, segmentValue).
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
        const h = items[i].hash;
        for (let s = 0; s < m; s++) {
            const key = s + ':' + h.substr(ranges[s][0], ranges[s][1]);
            let arr = buckets.get(key);
            if (!arr) { arr = []; buckets.set(key, arr); }
            arr.push(i);
        }
    }

    // Verify candidate pairs within each bucket; union those within threshold.
    for (const arr of buckets.values()) {
        if (arr.length < 2) continue;
        for (let a = 0; a < arr.length; a++) {
            const ia = arr[a];
            for (let b = a + 1; b < arr.length; b++) {
                const ib = arr[b];
                if (find(ia) === find(ib)) continue; // already connected — skip
                if (hammingDistance(items[ia].hash, items[ib].hash) <= threshold) union(ia, ib);
            }
        }
    }

    // Collect components of size >= 2.
    const comps = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!comps.has(r)) comps.set(r, []);
        comps.get(r).push(items[i].id);
    }
    const out = [];
    for (const ids of comps.values()) if (ids.length >= 2) out.push(ids);
    return out;
}

module.exports = { groupSimilar, segmentRanges };
