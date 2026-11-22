const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverPort = 3000;

function findAvailablePort(preferredPort = 3000) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => {
      const randomTester = net.createServer();
      randomTester.listen(0, '127.0.0.1', () => {
        const addr = randomTester.address();
        const freePort = typeof addr === 'object' && addr ? addr.port : 3001;
        randomTester.close(() => resolve(freePort));
      });
    });
    tester.once('listening', () => {
      tester.close(() => resolve(preferredPort));
    });
    tester.listen(preferredPort, '127.0.0.1');
  });
}

function waitForBackend(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else if (Date.now() - start < timeoutMs) {
          setTimeout(check, 250);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => {
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, 250);
        } else {
          resolve(false);
        }
      });
      req.setTimeout(1500, () => req.destroy());
    };
    check();
  });
}

function getAppIconPath() {
  const candidates = [
    path.join(__dirname, '../dist/pwa-512x512.png'),
    path.join(__dirname, '../public/pwa-512x512.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function startEmbeddedServer() {
  const userDataDir = app.getPath('userData');
  const baileysDir = path.join(userDataDir, 'baileys_auth_info');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(baileysDir, { recursive: true });

  serverPort = await findAvailablePort(3000);
  const distDir = fs.existsSync(path.join(__dirname, '../dist/index.html'))
    ? path.join(__dirname, '../dist')
    : path.join(process.cwd(), 'dist');

  process.env.NODE_ENV = 'production';
  process.env.PORT = String(serverPort);
  process.env.PERSISTENT_DATA_DIR = userDataDir;
  process.env.BAILEYS_AUTH_DIR = baileysDir;
  process.env.STATIC_DIST_DIR = distDir;

  const serverBundle = path.join(__dirname, '../dist/server.cjs');
  if (fs.existsSync(serverBundle)) {
    require(serverBundle);
    await waitForBackend(serverPort);
    return true;
  }
  return false;
}

function createTray() {
  if (tray) return;
  const iconPath = getAppIconPath();
  if (!iconPath) return;

  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('نظام متابعة لوكيت | Locat Monitor');

  const menu = Menu.buildFromTemplate([
    {
      label: 'فتح لوحة التحكم',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'إغلاق التطبيق نهائياً',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

async function createWindow() {
  const backendReady = await startEmbeddedServer();
  const iconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: 'نظام أتمتة ومتابعة لوكيت | Locat Monitor',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (backendReady) {
    await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  } else {
    const fallbackHtml = path.join(__dirname, '../dist/index.html');
    await mainWindow.loadFile(fallbackHtml);
  }

  createTray();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow) {
        mainWindow.show();
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && isQuitting) {
      app.quit();
    }
  });
}
