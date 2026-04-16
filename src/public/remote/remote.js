const { apiCall, imageServeUrl, newCacheBuster, connectSSE } = window.PictureFrame;

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
  rotateLeftBtn: document.getElementById('rotateLeftBtn'),
  rotateRightBtn: document.getElementById('rotateRightBtn'),
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
  els.thumb.src = imageServeUrl(img.id);

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
  const buttons = [
    els.prevBtn,
    els.nextBtn,
    els.pauseBtn,
    els.startBtn,
    els.favoriteBtn,
    els.rotateLeftBtn,
    els.rotateRightBtn,
    els.deleteBtn
  ];
  if (busy) {
    buttons.forEach(b => (b.disabled = true));
    return;
  }

  // Re-enable, then re-apply state-based disabling (play/pause + no current image)
  buttons.forEach(b => (b.disabled = false));
  updatePlayButtons();
  if (!state.currentImage) {
    els.favoriteBtn.disabled = true;
    els.rotateLeftBtn.disabled = true;
    els.rotateRightBtn.disabled = true;
    els.deleteBtn.disabled = true;
  }
}

function connectToSSE() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = connectSSE('/api/events', {
    onMessage: handleMessage,
    onStatusChange: (status) => {
      if (status === 'connecting') setStatus('Connecting…', 'warn');
      else if (status === 'open') setStatus('Connected', 'ok');
      else if (status === 'error') setStatus('Disconnected (reconnecting)…', 'err');
    }
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'image':
      state.currentImage = msg.image || null;
      state.settings = msg.settings || state.settings;
      if (typeof msg.isPlaying === 'boolean') {
        state.isPlaying = msg.isPlaying;
      }
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
      if (typeof msg.isPlaying === 'boolean') {
        state.isPlaying = msg.isPlaying;
      }
      updatePlayButtons();
      break;

    case 'rotate':
      if (state.currentImage && state.currentImage.id === msg.imageId) {
        els.thumb.src = imageServeUrl(msg.imageId, {
          cacheBuster: msg.cacheBuster || newCacheBuster()
        });
      }
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

async function rotate(direction) {
  if (!state.currentImage) return;
  setBusy(true);
  try {
    const endpoint = direction === 'left' ? 'rotate-left' : 'rotate-right';
    await apiCall(`/image/${state.currentImage.id}/${endpoint}`, { method: 'POST' });
    // Immediately bust cache for the remote preview; TV will update via SSE rotate event.
    els.thumb.src = imageServeUrl(state.currentImage.id, { cacheBuster: newCacheBuster() });
  } finally {
    setBusy(false);
  }
}

async function deleteCurrent() {
  if (!state.currentImage) return;

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
  els.rotateLeftBtn.addEventListener('click', () => rotate('left'));
  els.rotateRightBtn.addEventListener('click', () => rotate('right'));
  els.deleteBtn.addEventListener('click', deleteCurrent);
}

function init() {
  wireUI();
  connectToSSE();
  updatePlayButtons();
  updateNowPlaying();
}

init();


