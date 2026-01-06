const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const DEFAULT_URL = process.env.PICTUREFRAME_URL || 'http://localhost:3000';
const USE_EXTERNAL_SERVER = process.env.ELECTRON_USE_EXTERNAL_SERVER === '1';
const KIOSK_MODE = process.env.ELECTRON_KIOSK !== '0';
const NODE_BINARY = process.env.ELECTRON_NODE_BINARY || 'node';

let mainWindow = null;
let serverProcess = null;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      // Drain response
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  const healthUrl = `${baseUrl.replace(/\/$/, '')}/api/health`;

  while (Date.now() - start < timeoutMs) {
    try {
      const status = await httpGet(healthUrl);
      if (status >= 200 && status < 500) return;
    } catch (_) {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error(`Timed out waiting for server at ${healthUrl}`);
}

function startServerIfNeeded() {
  if (USE_EXTERNAL_SERVER) return;

  const appPath = app.getAppPath();
  const serverEntrypoint = path.join(appPath, 'src', 'server.js');

  serverProcess = spawn(NODE_BINARY, [serverEntrypoint], {
    cwd: appPath,
    env: {
      ...process.env,
      // Hint that we're running under Electron (optional)
      ELECTRON_APP: '1',
    },
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    // If the server dies, close the window so systemd can restart the app if configured.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    console.error(`Server process exited (code=${code}, signal=${signal})`);
  });
}

function stopServerIfNeeded() {
  if (!serverProcess) return;

  try {
    serverProcess.kill('SIGTERM');
  } catch (_) {}

  // Force kill if it doesn't exit quickly
  const proc = serverProcess;
  serverProcess = null;
  setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  }, 2000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    kiosk: KIOSK_MODE,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(async () => {
  startServerIfNeeded();

  try {
    await waitForServer(DEFAULT_URL);
  } catch (err) {
    console.error(err);
    app.quit();
    return;
  }

  const win = createWindow();
  await win.loadURL(DEFAULT_URL);

  // Optional: prevent accidental navigation
  win.webContents.on('will-navigate', (event) => event.preventDefault());
});

app.on('window-all-closed', () => {
  stopServerIfNeeded();
  app.quit();
});

app.on('before-quit', () => {
  stopServerIfNeeded();
});


