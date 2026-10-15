# static/comments/ —— 评论数据目录（请勿手工编辑）

这个目录由**评论系统自动写入**，每个文章页对应一个 JSON 文件：

| 页面 URL | 文件路径 | 线上地址 |
| --- | --- | --- |
| `/posts/stm32f4-interrupt/` | `static/comments/posts/stm32f4-interrupt.json` | `https://wstk.pages.dev/comments/posts/stm32f4-interrupt.json` |

## 为什么不要手改

提交评论时，Cloudflare Pages Function（[`functions/api/comment.js`](../../functions/api/comment.js)）
会先读这个 JSON、把新评论追加到数组末尾，再整份写回 GitHub。如果你手改文件的同时
有人提交评论，就会出现写冲突（代码里有重试，但最终仍以仓库里的版本为准）。

## 想删除 / 修改某条评论怎么办

**直接在 GitHub 上编辑对应的 JSON 文件即可**，这本来就是设计的一部分：

1. 打开该文件的 GitHub 页面 → 铅笔图标编辑
2. 删掉 `comments` 数组里对应的那个 `{...}` 对象（注意别破坏 JSON 语法）
3. 提交 → 等 GitHub Actions 构建完成（约 1 分钟）→ 网站上就没了

## 文件格式

UTF-8、JSON 缩进 2 空格、末尾一个换行：

```json
{
  "slug": "posts/stm32f4-interrupt",
  "comments": [
    {
      "id": "c_1750000000000_ab12cd",
      "name": "访客昵称",
      "email": "",
      "website": "",
      "body": "评论正文（纯文本，保留换行）",
      "ts": "2026-10-16T12:34:56.000Z",
      "ua": "简短 UA 摘要（可选）"
    }
  ]
}
```

- `slug`：文章路径去掉首尾斜杠，和文件名一一对应
- `body`：纯文本；HTML 转义在浏览器端渲染时完成，**不要在 JSON 里写 HTML**
- `name` / `body` 必填，`email` / `website` 选填（`website` 只接受 `http(s)://` 开头）

完整部署与使用说明见 [`docs/评论系统（Git存储）.md`](../../docs/评论系统（Git存储）.md)。
