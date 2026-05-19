const { app, BrowserWindow, ipcMain, globalShortcut, session, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { WebSocket } = require('ws');
const os = require('os');

// ==================== 全局状态 ====================
let controlWindow = null;   // 悬浮控制面板
let recognitionWindow = null; // 独立识别窗口
let recognitionWindowInBackground = false; // 识别窗口是否被抖音盖住
let _restoringFromMinimize = false;      // 标记：正在拦截最小化自动恢复
let gestureEnabled = true;  // 手势控制开关
const gestureCooldowns = {}; // 手势冷却计时器
let cdpWs = null;           // CDP WebSocket 连接
let cdpBrowserProcess = null; // 浏览器子进程
let cdpCommandId = 0;       // CDP 命令 ID
let cdpBrowserReady = false; // CDP 浏览器是否就绪
let cdpTargetId = null;     // 抖音页面的 CDP targetId

// ==================== CDP 浏览器控制 ====================
// 通过 Chrome DevTools Protocol 直接控制浏览器，无需安装扩展

function findBrowser() {
  const paths = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['LocalAppData'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LocalAppData'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CDP_PORT = 19877;

async function fetchCDPTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connectCDP() {
  try {
    const targets = await fetchCDPTargets();
    const douyinTarget = targets.find(t => t.url && t.url.includes('douyin.com'));
    if (!douyinTarget) {
      console.log('[手势控制] 未找到抖音页面，2秒后重试...');
      setTimeout(connectCDP, 2000);
      return;
    }

    const wsUrl = douyinTarget.webSocketDebuggerUrl;
    cdpTargetId = douyinTarget.id;
    console.log('[手势控制] 连接 CDP:', wsUrl);

    cdpWs = new WebSocket(wsUrl);

    cdpWs.on('open', () => {
      console.log('[手势控制] CDP 已连接 ✓');
      cdpBrowserReady = true;
      sendStatusToControl('✅ 浏览器已连接');
      injectScriptsViaCDP();
    });

    cdpWs.on('message', () => {
      // CDP 响应，不需要特别处理
    });

    cdpWs.on('close', () => {
      console.log('[手势控制] CDP 断开，3秒后重连...');
      cdpWs = null;
      cdpBrowserReady = false;
      sendStatusToControl('浏览器已断开');
      setTimeout(connectCDP, 3000);
    });

    cdpWs.on('error', (err) => {
      console.log('[手势控制] CDP 连接错误:', err.message);
    });
  } catch (e) {
    console.log('[手势控制] CDP 连接失败，2秒后重试:', e.message);
    setTimeout(connectCDP, 2000);
  }
}

function activateBrowserViaCDP() {
  if (!cdpTargetId) return;
  console.log('[手势控制] CDP 激活浏览器');
  // Target.activateTarget + Page.bringToFront 双保险
  sendCDPCommand('Target.activateTarget', { targetId: cdpTargetId });
  sendCDPCommand('Page.bringToFront');
}

function sendCDPCommand(method, params = {}) {
  if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
  cdpCommandId++;
  const msg = JSON.stringify({ id: cdpCommandId, method, params });
  cdpWs.send(msg);
}

async function injectScriptsViaCDP() {
  if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
  const script = `
    (function() {
      if (window.__handControlInjected) return;
      window.__handControlInjected = true;
      console.log('[手势控制] CDP 脚本已注入');
      window.__handControlClickLike = function() {
        const selectors = [
          '[data-e2e="like-icon"]',
          '[data-e2e="feed-like-icon"]',
          '.like-icon', '.icon-live-like',
        ];
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              let clickable = el;
              while (clickable && clickable !== document.body) {
                if (clickable.tagName === 'BUTTON' || clickable.getAttribute('role') === 'button' || clickable.getAttribute('data-e2e')) {
                  clickable.click();
                  return true;
                }
                clickable = clickable.parentElement;
              }
              el.click();
              return true;
            }
          } catch(e) {}
        }
        return false;
      };
    })()
  `;
  sendCDPCommand('Runtime.evaluate', { expression: script });
}

function sendGestureToBrowser(gesture) {
  if (!cdpBrowserReady || !cdpWs) {
    console.log('[手势控制] 浏览器未连接:', gesture);
    sendStatusToControl('浏览器未连接，请等待...');
    return false;
  }

  const keyMap = {
    'up': { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    'down': { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    'space': { key: ' ', code: 'Space', vk: 32 },
    'collect': { key: 'c', code: 'KeyC', vk: 67 },
    'comment': { key: 'x', code: 'KeyX', vk: 88 },
    'follow': { key: 'g', code: 'KeyG', vk: 71 },
    'follow_home': { key: 'f', code: 'KeyF', vk: 70 },
  };

  if (gesture === 'like') {
    sendCDPCommand('Runtime.evaluate', {
      expression: 'if(window.__handControlClickLike)window.__handControlClickLike();'
    });
    sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90
    });
    sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90
    });
    return true;
  }

  const keyDef = keyMap[gesture];
  if (!keyDef) return false;

  sendCDPCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: keyDef.key, code: keyDef.code, windowsVirtualKeyCode: keyDef.vk
  });
  sendCDPCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyDef.key, code: keyDef.code, windowsVirtualKeyCode: keyDef.vk
  });
  return true;
}



function launchBrowserWithCDP() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('[手势控制] 未找到 Edge 或 Chrome 浏览器');
    sendStatusToControl('未找到浏览器');
    return;
  }

  // 独立的浏览器用户数据目录，避免与已运行的浏览器冲突
  const userDataDir = path.join(app.getPath('userData'), 'cdp-browser-profile');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  console.log('[手势控制] 启动浏览器:', browserPath);
  const child = spawn(browserPath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    'https://www.douyin.com',
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.on('error', (err) => {
    console.error('[手势控制] 浏览器启动失败:', err.message);
    sendStatusToControl('浏览器启动失败');
  });

  child.unref();
  cdpBrowserProcess = child;

  // 等待浏览器启动后连接 CDP
  setTimeout(connectCDP, 3000);
}

// ==================== 创建悬浮控制面板 ====================
function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 360,
    height: 520,
    minWidth: 300,
    minHeight: 400,
    title: '手势控制面板',
    alwaysOnTop: true,       // 悬浮置顶
    skipTaskbar: false,
    resizable: true,
    frame: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,  // 最小化/隐藏后仍持续运行
    },
  });

  controlWindow.loadFile('control.html');

  // 设置 CSP
  controlWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss:; media-src * blob:; connect-src * blob: ws: wss:; worker-src * blob:;"
        ],
      },
    });
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
  });

  controlWindow.setAlwaysOnTop(true, 'screen-saver');
}

// ==================== 识别窗口 ====================

function createRecognitionWindow() {
  if (recognitionWindow && !recognitionWindow.isDestroyed()) {
    recognitionWindow.focus();
    return;
  }

  recognitionWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 320,
    minHeight: 480,
    title: '手势识别',
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    frame: true,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
    },
  });

  recognitionWindow.loadFile('recognition.html');

  // 设置 CSP 头，允许本地资源加载
  recognitionWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss:; media-src * blob:; connect-src * blob: ws: wss:;"
        ],
      },
    });
  });

  // 拦截最小化(-)按钮：短暂最小化让浏览器浮上来，再用 showInactive 无焦点恢复
  recognitionWindow.on('minimize', (event) => {
    if (!recognitionWindow || recognitionWindow.isDestroyed()) return;
    recognitionWindowInBackground = true;
    _restoringFromMinimize = true;
    // 允许窗口最小化，浏览器变成前台窗口
    // 300ms 后用 showInactive 恢复窗口（不抢焦点），浏览器保持在上层
    setTimeout(() => {
      if (!recognitionWindow || recognitionWindow.isDestroyed()) return;
      recognitionWindow.showInactive();
      _restoringFromMinimize = false;
    }, 300);
  });

  // 任务栏点击恢复：识别窗口重新盖住抖音浏览器
  recognitionWindow.on('restore', () => {
    if (_restoringFromMinimize) return;     // showInactive 触发的恢复，忽略
    if (recognitionWindowInBackground) {
      recognitionWindowInBackground = false;
      console.log('[手势控制] 识别窗口从任务栏恢复');
    }
  });

  // 拦截关闭(X)按钮：停止识别并关闭，通知控制面板
  recognitionWindow.on('close', (event) => {
    recognitionWindowInBackground = false;
    // 通知控制面板更新状态
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('recognition-closed');
    }
  });

  recognitionWindow.on('closed', () => {
    recognitionWindow = null;
    recognitionWindowInBackground = false;
    console.log('[手势控制] 识别窗口已关闭');
  });

  console.log('[手势控制] 识别窗口已创建');
}

function closeRecognitionWindow() {
  if (recognitionWindow && !recognitionWindow.isDestroyed()) {
    try {
      recognitionWindow.close();
    } catch (e) {
      console.error('[手势控制] 关闭识别窗口失败:', e.message);
      recognitionWindow = null;
    }
  }
}

function toggleRecognition() {
  if (recognitionWindow && !recognitionWindow.isDestroyed()) {
    if (recognitionWindowInBackground) {
      // 从任务栏恢复到前台
      recognitionWindow.show();
      recognitionWindow.focus();
      recognitionWindowInBackground = false;
      console.log('[手势控制] 识别窗口恢复正常显示');
    } else if (recognitionWindow.isVisible()) {
      recognitionWindow.hide();
    } else {
      recognitionWindow.show();
    }
  } else {
    createRecognitionWindow();
  }
}

// ==================== IPC 处理 ====================
// 接收来自控制面板的手势命令
ipcMain.on('gesture-command', (event, command) => {
  if (!gestureEnabled) {
    sendStatusToControl('手势控制已暂停');
    return;
  }

  // 手势冷却（防止重复触发）
  const now = Date.now();
  if (gestureCooldowns[command.gesture] && now - gestureCooldowns[command.gesture] < command.cooldown) {
    return; // 冷却中
  }
  gestureCooldowns[command.gesture] = now;

  console.log(`[手势控制] 收到手势: ${command.gesture}`);

  // 通过 CDP 发送命令到浏览器
  const sent = sendGestureToBrowser(command.gesture);
  if (!sent) return;

  const statusMessages = {
    'up': '⬆ 上一个视频',
    'down': '⬇ 下一个视频',
    'space': '⏯ 播放/暂停',
    'like': '❤ 点赞',
    'collect': '⭐ 收藏',
    'comment': '💬 评论',
    'follow': '➕ 关注',
    'follow_home': '🏠 作者主页',
  };
  sendStatusToControl(statusMessages[command.gesture] || '');
});

// 控制面板开关
ipcMain.on('toggle-gesture', (event, enabled) => {
  gestureEnabled = enabled;
  console.log(`[手势控制] 手势识别已${enabled ? '开启' : '关闭'}`);
  sendStatusToControl(enabled ? '✅ 手势识别已开启' : '⛔ 手势识别已关闭');
});

// 获取状态
ipcMain.handle('get-status', () => {
  return {
    gestureEnabled,
    mainWindowReady: cdpBrowserReady,
    controlWindowReady: controlWindow !== null && !controlWindow.isDestroyed(),
    recognitionWindowReady: recognitionWindow !== null && !recognitionWindow.isDestroyed(),
  };
});

// 识别窗口控制
ipcMain.on('toggle-recognition', () => {
  toggleRecognition();
});

ipcMain.on('close-recognition', () => {
  closeRecognitionWindow();
});

ipcMain.handle('is-recognition-open', () => {
  return recognitionWindow !== null && !recognitionWindow.isDestroyed() && recognitionWindow.isVisible();
});

// 手势命令已通过 CDP 直接在浏览器中执行

// ==================== 向控制面板发送状态 ====================
function sendStatusToControl(status) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('status-update', status);
  }
}

// ==================== 应用生命周期 ====================
app.whenReady().then(() => {
  console.log('[手势控制] 应用启动中...');

  // 先创建控制面板（确保至少有一个窗口，防止 window-all-closed 退出）
  createControlWindow();

  // 启动浏览器并连接 CDP（稍延迟，等控制面板就绪）
  setTimeout(() => {
    launchBrowserWithCDP();
  }, 1000);

  // 注册全局快捷键
  try {
    // Ctrl+Shift+G 聚焦控制面板
    globalShortcut.register('CommandOrControl+Shift+G', () => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.show();
        controlWindow.focus();
      } else {
        createControlWindow();
      }
    });
    // Ctrl+Shift+T 显示/隐藏识别窗口
    globalShortcut.register('CommandOrControl+Shift+T', () => {
      toggleRecognition();
    });
  } catch (err) {
    console.log('[手势控制] 全局快捷键注册失败:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
      setTimeout(() => launchBrowserWithCDP(), 1000);
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  // 关闭 CDP 连接
  if (cdpWs) {
    try { cdpWs.close(); } catch (e) {}
    cdpWs = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  // 清理 CDP 连接
  if (cdpWs) {
    try { cdpWs.close(); } catch (e) {}
    cdpWs = null;
  }
  cdpBrowserReady = false;
});
