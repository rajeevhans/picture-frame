/* Events tab: event imports (photos copied into imports/<Event name>/ on the frame). */
(function () {
    let initialized = false;
    let rendering = false;   // removing a focused input fires its change event; ignore it

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
                ? `Showing ${activeImp.id} · ${label(activeImp)} (${activeImp.count} photo${activeImp.count === 1 ? '' : 's'})`
                : `Showing import ${active}`;
        }

        const list = el('eventsList');
        // A refresh (rename, SSE) can land while a name is being edited: keep
        // that edit, or focus would drop to <body> and the rest of the typing
        // would run as frame shortcuts.
        const editing = document.activeElement && document.activeElement.classList.contains('event-name')
            ? { id: document.activeElement.dataset.importId, value: document.activeElement.value,
                start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
            : null;
        rendering = true;
        list.innerHTML = '';
        rendering = false;
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
            name.dataset.importId = imp.id;
            name.value = imp.name || '';
            name.placeholder = 'Untitled import';
            name.title = 'Rename (press Enter)';
            name.maxLength = 100;
            name.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') name.blur();
                if (e.key === 'Escape') { name.value = imp.name || ''; name.blur(); }
            });
            name.addEventListener('change', () => {
                if (!rendering && name.isConnected) rename(imp, name.value);
            });
            info.appendChild(name);
            const meta = document.createElement('div');
            meta.className = 'event-meta';
            meta.textContent = `${imp.id} · ${imp.count} photo${imp.count === 1 ? '' : 's'}`;
            info.appendChild(meta);
            card.appendChild(info);

            const actions = document.createElement('div');
            actions.className = 'event-actions';
            const btn = document.createElement('button');
            btn.className = 'btn ' + (imp.id === active ? 'btn-secondary' : 'btn-primary') + ' event-show';
            btn.textContent = imp.id === active ? 'Showing' : 'Show';
            btn.disabled = imp.id === active || imp.count === 0;
            btn.addEventListener('click', () => show(imp.id));
            actions.appendChild(btn);
            const renameBtn = document.createElement('button');
            renameBtn.className = 'btn btn-secondary';
            renameBtn.textContent = 'Rename';
            renameBtn.addEventListener('click', () => { name.focus(); name.select(); });
            actions.appendChild(renameBtn);
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => remove(imp));
            actions.appendChild(deleteBtn);
            card.appendChild(actions);

            list.appendChild(card);
            if (editing && editing.id === imp.id) {
                name.value = editing.value;
                name.focus();
                name.setSelectionRange(editing.start, editing.end);
            }
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
            const newName = value.trim();
            notify(newName ? `Renamed to ${newName}` : `Removed the name of ${imp.id}`);
        } catch (e) {
            notify('Rename failed: ' + e.message);
        }
        refresh();
    }

    async function remove(imp) {
        const photos = `${imp.count} photo${imp.count === 1 ? '' : 's'}`;
        if (!confirm(`Delete the event "${label(imp)}" (${imp.id})?\n\nIts ${photos} stay in your library.`)) return;
        try {
            await api('/api/imports/' + encodeURIComponent(imp.id), { method: 'DELETE' });
            notify(`Deleted ${label(imp)} · ${photos} kept`);
        } catch (e) {
            notify('Delete failed: ' + e.message);
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
