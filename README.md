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
2. 点击「打开论文」导入 PDF，或在阅读器中输入 arXiv ID / 链接（例如 `2401.12345`、`2401.12345v2`、`https://arxiv.org/abs/2401.12345`）。支持带文本层、不超过 30 MB 的文件。
3. 点击「翻译本页」开始对照阅读，也可通过「编辑译文」修改并保存。

停止服务：

```bash
docker compose -p paperduo down
```

论文、译文与设置保存在 `.reader-data/`，停止或重建容器后仍会保留。当前适合本地单用户使用；公式和参考文献保留原文，扫描件及复杂版面可能无法准确解析。

### arXiv 导入与缓存

arXiv 导入使用官方 Atom API 获取论文元数据，再下载对应版本的 PDF。PaperDuo 在 SQLite 中保存 `arxiv_id + version -> document` 映射，并用 PDF 内容哈希和片段级翻译缓存做第二层去重：同一版本再次打开时不会重新下载、解析或翻译；同一 PDF 通过不同入口导入时也会复用已有译文。arXiv API 官方建议缓存查询结果并控制请求频率，批量导入时请遵守其服务条款。

arXiv 请求优先使用 `ARXIV_HTTP_PROXY`，未单独配置时复用 `HTTPS_PROXY` / `https_proxy`。如果部署环境不能直接访问 arXiv，可在 `.env` 中设置 `ARXIV_HTTP_PROXY` 为容器能够访问的代理地址，随后执行 `docker compose -p paperduo up -d --build reader` 应用配置。自定义镜像地址可通过 `ARXIV_API_URL`、`ARXIV_PDF_URL` 配置。

## 开源许可

采用 [MIT License](LICENSE)。论文解析基于 [GROBID](https://github.com/kermitt2/grobid)，PDF 渲染基于 [PDF.js](https://github.com/mozilla/pdf.js)。
