# Audio2Text

本地音频/视频转文字桌面工具。基于 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 转写，可选用 [Demucs](https://github.com/adefossez/demucs) 先做人声分离。全程本地运行，**不消耗任何 API token**。

- 拖拽批量转写，任务队列串行执行
- 实时进度（已处理时长 / 总时长 / 当前步骤）
- 多种 Whisper 模型可选（large-v3-turbo / large-v3 / medium / small …）
- 深色 / 浅色双主题，强调色可自定义
- 每个文件可单独指定输出目录，或统一输出

> 界面布局参考开源下载工具 [Motrix](https://github.com/agalwood/Motrix)。本项目是一个通用框架，转写引擎和人声分离模型均可在设置中切换。

## 它不是什么

这是一个 **GUI 外壳**，调用本机 Python 后端完成实际转写。它**不**内置 Python、PyTorch、CUDA、ffmpeg 或模型权重（这些动辄数 GB，无法打进单文件）。你需要按下面步骤准备运行环境。

## 环境要求

1. **Python 3.9+**
2. Python 依赖：
   ```bash
   pip install faster-whisper demucs
   ```
   - GPU 加速需安装 **CUDA 版 PyTorch**（见 https://pytorch.org ）；无 CUDA 时自动回退到 CPU（慢很多）。
3. **ffmpeg**：安装后加入系统 `PATH`（或在应用「设置」里指定其 `bin` 目录）。
4. 模型权重**首次转写时自动下载**（Whisper 从 HuggingFace，Demucs 从 torch hub），无需手动准备。

## 使用（普通用户）

1. 到 [Releases](./releases) 下载 `Audio2Text x.y.z.exe`，双击运行（便携版，免安装；首次启动会自解压，稍慢）。
2. 首次打开进入「设置」：
   - 确认 **Python 解释器** 已自动检测到（否则手动指定装了上述依赖的 `python.exe`）。
   - 选择 **Whisper 模型**（默认 `large-v3-turbo`）。
   - 设置 **默认输出目录**。
3. 把音频/视频拖进窗口 → 确认弹窗里选「有无背景音乐」「输出位置」→ 开始。

> 便携 exe 无代码签名，Windows Defender 可能误报，按需加白名单。

## 开发 / 自行构建

```bash
git clone <repo>
cd audio2text
npm install
npm start          # 开发模式运行
npm run build      # 构建便携 exe 到 dist/
```

国内网络建议用镜像安装：
```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install --registry=https://registry.npmmirror.com
```

## 结构

```
main.js              Electron 主进程：任务队列、spawn Python、进度解析、IPC
preload.js           contextBridge 安全桥
renderer/            前端界面（vanilla JS + CSS）
backend/pipeline.py  Python 转写后端（随应用打包）
build/icon.ico       应用图标
```

## 支持的引擎

| 用途 | 支持的实现 |
|---|---|
| 语音转写 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（模型：large-v3-turbo / large-v3 / large-v2 / medium / small / base / tiny / distil-large-v3） |
| 人声分离 | [Demucs](https://github.com/adefossez/demucs)（模型：htdemucs / htdemucs_ft / mdx_extra） |

> 本项目为框架，不绑定特定模型。如需添加其他引擎，修改 `backend/pipeline.py` 即可。

## 致谢

- 界面布局参考 [Motrix](https://github.com/agalwood/Motrix)（MIT License）
- 转写引擎 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- 人声分离 [Demucs](https://github.com/adefossez/demucs)
- 底层模型 [OpenAI Whisper](https://github.com/openai/whisper)

## License

[MIT](./LICENSE)
