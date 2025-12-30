const els = {
  statusText: document.getElementById('statusText'),
  thumb: document.getElementById('thumb'),
  filename: document.getElementById('filename'),
  counter: document.getElementById('counter'),

  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  startBtn: document.getElementById('startBtn'),
  favoriteBtn: document.getElementById('favoriteBtn'),
  deleteBtn: document.getElementById('deleteBtn'),
};

const state = {
  currentImage: null,
  settings: null,
  isPlaying: false,
  eventSource: null,
};

function setStatus(text, kind) {
  els.statusText.textContent = text;
  els.statusText.classList.remove('ok', 'warn', 'err');
  if (kind) els.statusText.classList.add(kind);
}

async function apiCall(endpoint, options = {}) {
  const response = await fetch(`/api${endpoint}`, options);
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`API ${endpoint} failed: ${response.status} ${response.statusText} ${txt}`);
  }
  return await response.json();
}

function updateNowPlaying() {
  const img = state.currentImage;
  if (!img) {
    els.filename.textContent = '—';
    els.counter.textContent = '—';
    els.thumb.removeAttribute('src');
    return;
  }

  els.filename.textContent = img.filename || `Image ${img.id}`;
  els.counter.textContent = `ID: ${img.id}`;
  els.thumb.src = `/api/image/${img.id}/serve`;

  if (img.isFavorite) {
    els.favoriteBtn.classList.add('on');
    els.favoriteBtn.setAttribute('aria-pressed', 'true');
  } else {
    els.favoriteBtn.classList.remove('on');
    els.favoriteBtn.setAttribute('aria-pressed', 'false');
  }
}

function updatePlayButtons() {
  if (state.isPlaying) {
    els.startBtn.disabled = true;
    els.pauseBtn.disabled = false;
    els.pauseBtn.classList.add('on');
    els.startBtn.classList.remove('on');
  } else {
    els.startBtn.disabled = false;
    els.pauseBtn.disabled = true;
    els.startBtn.classList.add('on');
    els.pauseBtn.classList.remove('on');
  }
}

function setBusy(busy) {
  const buttons = [els.prevBtn, els.nextBtn, els.pauseBtn, els.startBtn, els.favoriteBtn, els.deleteBtn];
  buttons.forEach(b => (b.disabled = busy || b.disabled));
}

function connectToSSE() {
  if (state.eventSource) state.eventSource.close();

  setStatus('Connecting…', 'warn');
  const es = new EventSource('/api/events');
  state.eventSource = es;

  es.onopen = () => {
    setStatus('Connected', 'ok');
  };

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Bad SSE message:', e);
    }
  };

  es.onerror = () => {
    setStatus('Disconnected (reconnecting)…', 'err');
    // EventSource will retry automatically; we keep status updated.
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'image':
      state.currentImage = msg.image || null;
      state.settings = msg.settings || state.settings;
      state.isPlaying = !!msg.isPlaying;
      updateNowPlaying();
      updatePlayButtons();
      break;

    case 'favorite':
      if (state.currentImage && state.currentImage.id === msg.imageId) {
        state.currentImage.isFavorite = !!msg.isFavorite;
        updateNowPlaying();
      }
      break;

    case 'settings':
      state.settings = msg.settings || state.settings;
      break;

    case 'slideshowState':
      state.isPlaying = !!msg.isPlaying;
      updatePlayButtons();
      break;
  }
}

async function next() {
  setBusy(true);
  try {
    await apiCall('/image/next');
  } finally {
    setBusy(false);
  }
}

async function prev() {
  setBusy(true);
  try {
    await apiCall('/image/previous');
  } finally {
    setBusy(false);
  }
}

async function start() {
  setBusy(true);
  try {
    await apiCall('/slideshow/start', { method: 'POST' });
  } finally {
    setBusy(false);
  }
}

async function pause() {
  setBusy(true);
  try {
    await apiCall('/slideshow/pause', { method: 'POST' });
  } finally {
    setBusy(false);
  }
}

async function toggleFavorite() {
  if (!state.currentImage) return;
  setBusy(true);
  try {
    await apiCall(`/image/${state.currentImage.id}/favorite`, { method: 'POST' });
  } finally {
    setBusy(false);
  }
}

async function deleteCurrent() {
  if (!state.currentImage) return;
  const ok = confirm('Delete this image? This moves it to data/deleted and removes it from the database.');
  if (!ok) return;

  setBusy(true);
  try {
    await apiCall(`/image/${state.currentImage.id}`, { method: 'DELETE' });
  } finally {
    setBusy(false);
  }
}

function wireUI() {
  els.prevBtn.addEventListener('click', prev);
  els.nextBtn.addEventListener('click', next);
  els.pauseBtn.addEventListener('click', pause);
  els.startBtn.addEventListener('click', start);
  els.favoriteBtn.addEventListener('click', toggleFavorite);
  els.deleteBtn.addEventListener('click', deleteCurrent);
}

function init() {
  wireUI();
  connectToSSE();
  updatePlayButtons();
  updateNowPlaying();
}

init();


