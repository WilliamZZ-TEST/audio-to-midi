# 音频转 MIDI 工具

在浏览器中完成音频分离与 MIDI 转换，文件不会上传服务器。

## 功能

- 上传音频文件（支持点击、拖拽、粘贴）
- AI 自动分离音轨：人声 / 鼓 / 贝斯 / 钢琴 / 其他
- 各音轨自动转录为 MIDI 音符
- 一键导出标准多轨 MIDI 工程文件

## 技术栈

- Vite + TypeScript
- ONNX Runtime Web + Demucs 6s 模型（音频分离）
- Spotify Basic Pitch + TensorFlow.js（音频转 MIDI）
- MidiWriterJS（MIDI 文件生成）

## 本地运行

```bash
npm install
npm run dev
```

## 在线使用

访问 GitHub Pages 部署地址即可直接使用。
