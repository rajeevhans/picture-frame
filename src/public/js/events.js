/* Events tab: event imports (photos copied into imports/<Event name>/ on the frame). */
(function () {
    let initialized = false;

    function el(id) { return document.getElementById(id); }

    async function api(path, opts) {
        const res = await fetch(path, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        return body;
    }

    function notify(message) {
        if (typeof showToast === 'function') showToast(message);
    }

    function label(imp) {
        return imp.name ? `${imp.name}` : 'Untitled import';
    }

    async function refresh() {
        let data;
        try {
            data = await api('/api/imports');
        } catch (e) {
            el('eventsList').textContent = 'Could not load imports: ' + e.message;
            return;
        }
        render(data.imports, data.active);
    }

    function render(imports, active) {
        const banner = el('eventsActive');
        const activeImp = imports.find(i => i.id === active);
        banner.classList.toggle('hidden', !active);
        if (active) {
            el('eventsActiveText').textContent = activeImp
                ? `Showing ${activeImp.id} · ${label(activeImp)} (${activeImp.count} photos)`
                : `Showing import ${active}`;
        }

        const list = el('eventsList');
        list.innerHTML = '';
        el('eventsEmpty').classList.toggle('hidden', imports.length > 0);

        for (const imp of imports) {
            const card = document.createElement('div');
            card.className = 'event-card' + (imp.id === active ? ' active' : '');

            const cover = document.createElement('div');
            cover.className = 'event-cover';
            if (imp.coverId) {
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.alt = '';
                img.src = `/api/image/${imp.coverId}/serve`;
                cover.appendChild(img);
            }
            card.appendChild(cover);

            const info = document.createElement('div');
            info.className = 'event-info';
            const name = document.createElement('input');
            name.className = 'event-name';
            name.value = imp.name || '';
            name.placeholder = 'Untitled import';
            name.title = 'Rename (press Enter)';
            name.maxLength = 100;
            name.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') name.blur();
                if (e.key === 'Escape') { name.value = imp.name || ''; name.blur(); }
            });
            name.addEventListener('change', () => rename(imp, name.value));
            info.appendChild(name);
            const meta = document.createElement('div');
            meta.className = 'event-meta';
            meta.textContent = `${imp.id} · ${imp.count} photo${imp.count === 1 ? '' : 's'}`;
            info.appendChild(meta);
            card.appendChild(info);

            const btn = document.createElement('button');
            btn.className = 'btn ' + (imp.id === active ? 'btn-secondary' : 'btn-primary') + ' event-show';
            btn.textContent = imp.id === active ? 'Showing' : 'Show';
            btn.disabled = imp.id === active || imp.count === 0;
            btn.addEventListener('click', () => show(imp.id));
            card.appendChild(btn);

            list.appendChild(card);
        }
    }

    async function postSettings(patch) {
        const data = await api('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        // Toast + form state come from updateSettings() via SSE / this response
        if (typeof updateSettings === 'function') updateSettings(data.settings);
        return data;
    }

    async function show(id) {
        try {
            await postSettings({ importFilter: id });
        } catch (e) {
            notify('Could not show import: ' + e.message);
        }
        refresh();
    }

    async function showAll() {
        try {
            await postSettings({ importFilter: '' });
        } catch (e) {
            notify('Could not show all photos: ' + e.message);
        }
        refresh();
    }

    async function rename(imp, value) {
        try {
            await api('/api/imports/' + encodeURIComponent(imp.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: value })
            });
            notify(`Renamed ${imp.id}`);
        } catch (e) {
            notify('Rename failed: ' + e.message);
        }
        refresh();
    }

    /** Called when the Events tab is shown. */
    function init() {
        if (!initialized) {
            initialized = true;
            el('eventsShowAllBtn').addEventListener('click', showAll);
        }
        refresh();
    }

    window.PictureFrameEvents = { init, refresh };
})();
