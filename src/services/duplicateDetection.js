const crypto = require('crypto');
const fs = require('fs');
const { groupSimilar } = require('../lib/similarGroups');
const { hammingDistance } = require('../lib/perceptualHash');
const { duplicateScanMessage } = require('../lib/messages');

class DuplicateDetectionService {
    constructor(db, config = {}, { broadcast } = {}) {
        this.db = db;
        this.cfg = config.duplicates || {};
        this.broadcast = broadcast || (() => {});
        this.cancelRequested = false;
        this.state = this._idle();
    }

    _idle() {
        return { phase: 'idle', processed: 0, total: 0, exactGroups: 0, similarGroups: 0, startedAt: null, finishedAt: null };
    }

    getStatus() { return { ...this.state }; }
    requestCancel() { this.cancelRequested = true; }
    isRunning() { return this.state.phase === 'hashing' || this.state.phase === 'detecting'; }

    _emit() { this.broadcast(duplicateScanMessage(this.getStatus())); }

    async runScan() {
        if (this.isRunning()) return this.getStatus();
        this.cancelRequested = false;
        this.state = { ...this._idle(), phase: 'hashing', startedAt: Date.now(), total: this.db.countImagesNeedingHash() };
        this._emit();

        await this._hashBackfill();
        if (this.cancelRequested) { this.state.phase = 'canceled'; this.state.finishedAt = Date.now(); this._emit(); return this.getStatus(); }

        this.state.phase = 'detecting'; this._emit();
        this._detectGroups();

        this.state.phase = 'done'; this.state.finishedAt = Date.now(); this._emit();
        return this.getStatus();
    }

    async _hashBackfill() {
        const batchSize = this.cfg.hashBatchSize || 100;
        for (;;) {
            if (this.cancelRequested) return;
            const rows = this.db.getImagesNeedingHash(batchSize);
            if (rows.length === 0) return;
            for (const row of rows) {
                try {
                    const bytes = await fs.promises.readFile(row.filepath);
                    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
                    let perceptualHash = null;
                    try {
                        const { dHash } = require('../lib/perceptualHash');
                        perceptualHash = await dHash(row.filepath);
                    } catch (_) { perceptualHash = null; }
                    this.db.setHashes(row.id, contentHash, perceptualHash);
                } catch (_) {
                    this.db.setHashes(row.id, null, null);
                }
                this.state.processed++;
            }
            this._emit();
        }
    }

    _detectGroups() {
        let groupId = 0;
        const memberRows = [];
        const inExact = new Set();

        // Exact groups
        const exact = this.db.getExactDuplicateGroups();
        for (const g of exact) {
            groupId++;
            const keeper = this.db.pickKeeper(g.ids);
            for (const id of g.ids) {
                inExact.add(id);
                memberRows.push({ groupId, imageId: id, groupType: 'exact', isSuggestedKeeper: id === keeper ? 1 : 0, isOversized: 0, isAutoEligible: 1 });
            }
        }
        this.state.exactGroups = exact.length;

        // Similar groups via BK-tree + union-find (skip images already exact-grouped)
        const rows = this.db.getImagesWithPerceptualHash().filter(r => !inExact.has(r.id));
        const threshold = this.cfg.similarThreshold ?? 7;
        const autoThreshold = this.cfg.similarAutoThreshold ?? 5;
        const maxGroupSize = this.cfg.maxGroupSize ?? 25;
        const idToHash = new Map(rows.map(r => [r.id, r.perceptual_hash]));

        const components = groupSimilar(
            rows.map(r => ({ id: r.id, hash: r.perceptual_hash })),
            threshold
        );

        let similarCount = 0;
        for (const ids of components) {
            if (ids.length < 2) continue;
            similarCount++;
            groupId++;
            const oversized = ids.length > maxGroupSize ? 1 : 0;
            const keeper = oversized ? null : this.db.pickKeeper(ids);
            // Auto-eligible only when not oversized AND the whole component stays a
            // single connected component under the stricter auto threshold.
            const autoEligible = (!oversized && this._connectedAtThreshold(ids, idToHash, autoThreshold)) ? 1 : 0;
            for (const id of ids) {
                memberRows.push({ groupId, imageId: id, groupType: 'similar', isSuggestedKeeper: id === keeper ? 1 : 0, isOversized: oversized, isAutoEligible: autoEligible });
            }
        }
        this.state.similarGroups = similarCount;

        // Atomic swap: prior groups survive until the new set is fully built.
        this.db.replaceDuplicateGroups(memberRows);
    }

    /** True if `ids` form one connected component under Hamming <= threshold. */
    _connectedAtThreshold(ids, idToHash, threshold) {
        const parent = new Map(ids.map(id => [id, id]));
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                if (hammingDistance(idToHash.get(ids[i]), idToHash.get(ids[j])) <= threshold) {
                    parent.set(find(ids[i]), find(ids[j]));
                }
            }
        }
        const roots = new Set(ids.map(find));
        return roots.size === 1;
    }
}

module.exports = DuplicateDetectionService;
