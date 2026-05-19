# 🖐 手势控制抖音 (Hand Control Douyin)

> 基于 **MediaPipe Hands** + **Electron** + **CDP** 的手势识别桌面应用，通过摄像头识别自定义手势，远程操控抖音网页版。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/electron-28.x-brightgreen)](https://www.electronjs.org/)
[![MediaPipe](https://img.shields.io/badge/mediapipe-hands-orange)](https://developers.google.com/mediapipe)

---

## 🎬 演示效果

| 手势 | 抖音操作 |
|------|----------|
| ✊ → ✋ 张开 | ⬆️ 上一个视频 |
| ✋ → ✊ 握拳 | ⬇️ 下一个视频 |
| ✌️ 剪刀手 | ⏯️ 播放/暂停 |
| 👍 点赞手势 | ❤️ 点赞 |
| 🤞 自定义 | ⭐ 收藏 |
| 🤟 自定义 | 💬 评论 |
| 🤘 自定义 | ➕ 关注作者 |
| 👆 自定义 | 🏠 作者主页 |

> 💡 **所有手势完全自定义！** 无需记忆固定手势——你自己录制什么手势就对应什么操作。

---

## 🏗️ 项目架构

```
hand-control-dy/
├── main.js                 # Electron 主进程：CDP 浏览器控制 + IPC
├── preload.js              # 安全的 IPC 桥接
├── control.html            # 手势录制面板（摄像头预览 + 录制按钮）
├── recognition.html        # 独立手势识别窗口（防抖识别 + 动作触发）
├── mediapipe/hands/        # MediaPipe Hands 模型文件（WASM + TFLite）
└── package.json
```

### 工作流程

```
摄像头 → MediaPipe 手部关键点提取 → 归一化 → 模板匹配
                                              ↓
                                         匹配成功？
                                              ↓
                                Electron IPC → 主进程
                                              ↓
                                CDP (Chrome DevTools Protocol)
                                              ↓
                                  操控抖音网页版 (douyin.com)
```

### 核心技术亮点

- **CDP 免扩展**：无需安装浏览器扩展，直接通过 `--remote-debugging-port` 连接 Chrome/Edge
- **自定义手势录制**：每个动作由用户自己录制，归一化后存储为模板，支持任意手型
- **EMA 指数平滑**：手部 21 个关键点实时平滑，减少抖动误识别
- **三重防误触发**：确认帧数 + 冷却时间 + 迟滞裕度，确保手势识别精准稳定
- **双窗口架构**：录制面板 + 识别窗口分离，识别窗口可最小化后台运行

---

## 🚀 快速开始

### 方式一：直接下载安装包（Windows 用户推荐）

从 [Releases](https://github.com/wangjinghao6699/hand-control-dy/releases) 页面下载最新版 `手势控制抖音 Setup 1.0.0.exe`，双击安装即可使用。

> 安装包已集成 Node.js 运行时和所有依赖，无需额外安装任何环境。

### 方式二：从源码运行

**环境要求**

- **Node.js** ≥ 18
- **摄像头**（内置或外接 USB）
- **Chrome / Edge 浏览器**
- **Windows** / macOS / Linux

```bash
# 1. 克隆仓库
git clone https://github.com/wangjinghao6699/hand-control-dy.git
cd hand-control-dy

# 2. 安装依赖
npm install

# 3. 启动应用
npm start
```

### 使用步骤

1. 启动后自动打开**手势录制面板**和**抖音网页版**
2. 点击某个动作旁的「🎬 录制」按钮，倒计时后对着摄像头做出你的手势
3. 重复录制所有想要的手势（至少录制一个）
4. 点击「🎥 启动识别」，弹出独立识别窗口
5. 对着摄像头做手势 → 自动操控抖音！

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+G` | 聚焦控制面板 |
| `Ctrl+Shift+T` | 显示/隐藏识别窗口 |

---

## 📦 打包发布

预编译安装包可在 [Releases](https://github.com/wangjinghao6699/hand-control-dy/releases) 页面下载。

如需自行打包：

```bash
# Windows
npm run dist:win

# macOS
npm run dist:mac
```

打包产物在 `dist/` 目录下。

---

## 🔧 技术细节

### 手势匹配算法

1. 以**腕关节（landmark[0]）**为原点，中掌指关节（landmark[9]）距离为缩放因子，归一化所有 21 个关键点坐标
2. 录制时采集多帧，取平均值作为模板
3. 匹配时计算当前帧与每个模板的**欧氏距离**（MSE），取最小距离
4. 连续 N 帧匹配同一手势 + 冷却时间通过 → 触发对应动作

### CDP 控制

通过 Chrome DevTools Protocol 直接在抖音页面中：
- 模拟键盘事件（`Input.dispatchKeyEvent`）：上下切换、播放暂停
- 注入 JS 脚本（`Runtime.evaluate`）：点击点赞按钮等复杂 DOM 操作

---

## 📄 开源协议

MIT License · 详见 [LICENSE](LICENSE)

---

## 📚 参考文献

[1] Zhang F, Bazarevsky V, Vakunov A, et al. **MediaPipe Hands: On-device Real-time Hand Tracking** [C]. *CVPR Workshop on Computer Vision for Augmented and Virtual Reality*, 2020.

[2] Lugaresi C, Tang J, Nash H, et al. **MediaPipe: A Framework for Building Perception Pipelines** [J]. *arXiv preprint*, arXiv:1906.08172, 2019.

[3] Google LLC. **MediaPipe Hands Solution** [EB/OL]. https://developers.google.com/mediapipe/solutions/vision/hand_landmarker, 2023.

[4] OpenJS Foundation. **Electron Framework** [EB/OL]. https://www.electronjs.org/, 2024.

[5] Google LLC. **Chrome DevTools Protocol** [EB/OL]. https://chromedevtools.github.io/devtools-protocol/, 2024.

[6] Hunter J D. **Matplotlib: A 2D Graphics Environment** [J]. *Computing in Science & Engineering*, 2007, 9(3): 90-95.

[7] W3C. **Media Capture and Streams** [EB/OL]. https://www.w3.org/TR/mediacapture-streams/, 2023.

---

## ⚠️ 免责声明

本项目仅供学习和研究使用。使用本软件操控抖音可能违反抖音的服务条款，请自行承担风险。开发者不对任何账号封禁或其他后果负责。
