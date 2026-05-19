const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 安全地向渲染进程暴露 API
contextBridge.exposeInMainWorld('handControlAPI', {
  // 发送手势命令到主进程
  sendGesture: (gesture, cooldown = 1500) => {
    ipcRenderer.send('gesture-command', { gesture, cooldown });
  },

  // 切换手势识别开关
  toggleGesture: (enabled) => {
    ipcRenderer.send('toggle-gesture', enabled);
  },

  // 获取当前状态
  getStatus: () => {
    return ipcRenderer.invoke('get-status');
  },

  // 监听主进程发来的状态更新
  onStatusUpdate: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('status-update', handler);
    // 返回取消监听的函数
    return () => {
      ipcRenderer.removeListener('status-update', handler);
    };
  },

  // 识别窗口控制
  toggleRecognition: () => {
    ipcRenderer.send('toggle-recognition');
  },

  closeRecognition: () => {
    ipcRenderer.send('close-recognition');
  },

  isRecognitionOpen: () => {
    return ipcRenderer.invoke('is-recognition-open');
  },

  // 监听识别窗口关闭事件
  onRecognitionClosed: (callback) => {
    const handler = (event) => callback();
    ipcRenderer.on('recognition-closed', handler);
    return () => {
      ipcRenderer.removeListener('recognition-closed', handler);
    };
  },
});
