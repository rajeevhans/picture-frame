/**
 * BK-tree over a metric distance function (here: Hamming distance on
 * perceptual hashes). Enables efficient "all neighbors within d" queries
 * without O(n^2) pairwise comparison.
 */
class BKTree {
    /** @param {(a: any, b: any) => number} distanceFn - integer metric */
    constructor(distanceFn) {
        this.distance = distanceFn;
        this.root = null;
    }

    insert(key, value) {
        const node = { key, value, children: new Map() };
        if (!this.root) { this.root = node; return; }
        let cur = this.root;
        for (;;) {
            const d = this.distance(key, cur.key);
            const child = cur.children.get(d);
            if (!child) { cur.children.set(d, node); return; }
            cur = child;
        }
    }

    /** All inserted entries within maxDistance of key (excludes nothing by identity). */
    query(key, maxDistance) {
        const results = [];
        if (!this.root) return results;
        const stack = [this.root];
        while (stack.length) {
            const node = stack.pop();
            const d = this.distance(key, node.key);
            if (d <= maxDistance) results.push({ key: node.key, value: node.value, distance: d });
            const lo = d - maxDistance, hi = d + maxDistance;
            for (const [edge, child] of node.children) {
                if (edge >= lo && edge <= hi) stack.push(child);
            }
        }
        return results;
    }
}

module.exports = BKTree;
