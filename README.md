# PPT Speaker 📊🎙️

将 PPT 转换为 AI 配音短视频课件的智能工具。

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能特性

- **📤 PPT 上传解析** - 支持 .pptx 格式，自动提取幻灯片内容和图片
- **🤖 AI 演讲稿生成** - 为每张幻灯片智能生成专业演讲稿
- **🔊 多平台语音合成** - 支持通义千问、浏览器原生语音等多种 TTS 引擎
- **▶️ 视频播放预览** - 实时预览幻灯片与配音同步效果
- **💾 MP4 视频导出** - 一键导出高质量短视频课件

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:5173 即可使用。

### 构建生产版本

```bash
npm run build
```

## 📖 使用指南

### 1. 上传 PPT
点击上传区域选择 .pptx 文件，系统自动解析幻灯片内容。

### 2. 生成演讲稿
- 选择 TTS 引擎（通义千问 / 浏览器语音 / 定时模式）
- 点击"生成演讲稿"，AI 为每张幻灯片生成专业讲解词
- 支持手动编辑演讲稿内容

### 3. 播放与导出
- 点击播放按钮预览完整课件
- 支持暂停、跳转、调节播放速度
- 点击"导出视频"生成 MP4 文件

## 🛠️ 技术栈

| 技术 | 用途 |
|------|------|
| React 18 | 前端框架 |
| Vite | 构建工具 |
| jszip | PPT 文件解析 |
| mp4-muxer | 视频编码导出 |
| Web Speech API | 浏览器语音合成 |

## 📁 项目结构

```
ppt-speaker/
├── src/
│   ├── components/          # React 组件
│   │   ├── UploadView.jsx   # 上传界面
│   │   ├── GenerationView.jsx # 生成演讲稿界面
│   │   ├── PlayerView.jsx   # 播放导出界面
│   │   └── ProgressBar.jsx  # 进度条组件
│   ├── utils/
│   │   └── pptxParser.js    # PPT 解析工具
│   ├── App.jsx              # 主应用组件
│   ├── main.jsx             # 入口文件
│   └── index.css            # 全局样式
├── index.html
├── package.json
└── vite.config.js
```

## 🔧 配置说明

### TTS 引擎配置

在 `GenerationView.jsx` 中配置你的通义千问 API Key：

```javascript
const QWEN_API_KEY = 'your-api-key-here';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
```

### 支持的 PPT 格式

- 文件格式：.pptx
- 最大文件大小：建议不超过 50MB
- 幻灯片数量：无明确限制

## 📝 开发计划

- [ ] 支持更多 TTS 引擎（Azure、Google Cloud 等）
- [ ] 添加更多视频导出格式和分辨率选项
- [ ] 支持 PPT 动画效果导出
- [ ] 批量处理多个 PPT 文件
- [ ] 云端存储和分享功能

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License © 2024

---

**PPT Speaker** - 让每一页幻灯片都能开口说话 🎤
