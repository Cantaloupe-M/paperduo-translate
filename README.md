# PaperDuo

PaperDuo 是一款开源、自托管的学术论文双语 PDF 阅读器。它将英文论文原版 PDF 与中文译文并排呈现，支持 AI 论文翻译、段落联动和本地文献管理，适合 arXiv、期刊与会议论文的中英文对照精读。文档与译文均保存在本地。

> PaperDuo is an open-source, self-hosted bilingual PDF reader and AI academic paper translator. It displays original papers alongside Chinese translations for side-by-side reading while keeping documents local.

## 效果预览

![PaperDuo 双语对照阅读预览](docs/preview.png)

## 项目亮点

- **原文译文联动**：保留 PDF 原始排版，悬停即可高亮并定位另一侧的对应内容。
- **灵活的 AI 翻译**：接入 OpenAI 兼容的模型服务，按段落上下文翻译，支持切换模型和手动编辑译文。
- **自己的论文知识库**：论文搜索、分类、最近阅读与进度恢复，PDF 和译文保存在本地。
- **舒适的阅读体验**：支持译文字号调整、PDF 缩放与左右分栏宽度调整。

## 快速开始

需要 Docker Compose，建议预留约 6 GB 可用内存。在项目目录执行：

```bash
cp .env.example .env
mkdir -p .reader-data
docker compose -p paperduo up -d --build
```

Linux 用户启动前，请将 `.env` 中的 `READER_UID`、`READER_GID` 分别设为 `id -u`、`id -g` 的输出，确保数据目录可写。

打开 **[http://127.0.0.1:4174](http://127.0.0.1:4174)**：

1. 在「个人设置」中填写模型服务地址、API Key 和模型名称。
2. 点击「打开论文」导入 PDF，支持带文本层、不超过 30 MB 的文件。
3. 点击「翻译本页」开始对照阅读，也可通过「编辑译文」修改并保存。

停止服务：

```bash
docker compose -p paperduo down
```

论文、译文与设置保存在 `.reader-data/`，停止或重建容器后仍会保留。当前适合本地单用户使用；公式和参考文献保留原文，扫描件及复杂版面可能无法准确解析。

## 开源许可

采用 [MIT License](LICENSE)。论文解析基于 [GROBID](https://github.com/kermitt2/grobid)，PDF 渲染基于 [PDF.js](https://github.com/mozilla/pdf.js)。
