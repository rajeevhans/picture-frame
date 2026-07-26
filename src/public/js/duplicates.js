/* Duplicate review UI. Uses global apiCall() from app.js. */
(function () {
    let initialized = false;

    async function api(path, opts) {
        const res = await fetch('/api/duplicates' + path, opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function el(id) { return document.getElementById(id); }

    async function refresh() {
        const status = await api('/status');
        el('dupSummary').textContent =
            `${status.exactGroups || 0} exact group(s), ${status.similarGroups || 0} similar group(s).`;
        renderProgress(status);
        const { groups } = await api('/groups');
        renderGroups(groups);
    }

    function renderProgress(s) {
        const box = el('dupProgress');
        if (s.phase === 'idle' || s.phase === 'done' || s.phase === 'canceled') {
            box.classList.add('hidden');
        } else {
            box.classList.remove('hidden');
            el('dupPhase').textContent = s.phase;
            const pct = s.total ? Math.round((s.processed / s.total) * 100) : 0;
            el('dupBar').value = pct;
            el('dupCounts').textContent = `${s.processed}/${s.total}`;
        }
    }

    function renderGroups(groups) {
        const container = el('dupGroups');
        container.innerHTML = '';
        for (const g of groups) {
            const div = document.createElement('div');
            div.className = 'dup-group';
            const label = g.oversized ? `${g.groupType} (oversized — review only)` : g.groupType;
            div.innerHTML = `<div class="dup-group-label">${label}</div>`;
            const row = document.createElement('div');
            row.className = 'dup-thumbs';
            for (const m of g.members) {
                const fig = document.createElement('figure');
                fig.className = 'dup-thumb' + (m.isSuggestedKeeper ? ' keeper' : '');
                fig.innerHTML =
                    `<img src="/api/image/${m.id}/serve" alt="${m.filename}">` +
                    `<figcaption>${m.isFavorite ? '⭐ ' : ''}${m.width}×${m.height}` +
                    `${m.artisticScore != null ? ' · ' + m.artisticScore : ''}` +
                    `${m.isSuggestedKeeper ? ' · KEEP' : ''}</figcaption>`;
                row.appendChild(fig);
            }
            div.appendChild(row);
            const keeper = g.members.find(m => m.isSuggestedKeeper) || g.members[0];
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = 'Keep suggested, delete the rest';
            btn.onclick = async () => {
                const deleteIds = g.members.filter(m => m.id !== keeper.id).map(m => m.id);
                await api('/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keeperId: keeper.id, deleteIds }) });
                await refresh();
            };
            div.appendChild(btn);
            container.appendChild(div);
        }
    }

    function init() {
        if (initialized) { refresh().catch(() => {}); return; }
        initialized = true;
        el('dupScanBtn').onclick = async () => { await api('/scan', { method: 'POST' }); };
        el('dupAutoExact').onclick = async () => {
            await api('/auto-resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'exact' }) });
            await refresh();
        };
        el('dupAutoSimilar').onclick = async () => {
            if (!confirm('Auto-resolve SIMILAR images? This deletes near-duplicates using the strict threshold. Continue?')) return;
            await api('/auto-resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'similar', confirm: true }) });
            await refresh();
        };
        refresh().catch(() => {});
    }

    // Called by app.js on the duplicateScan SSE event.
    function onScanEvent(state) {
        renderProgress(state);
        if (state.phase === 'done') refresh().catch(() => {});
    }

    window.PictureFrameDuplicates = { init, onScanEvent };
})();
