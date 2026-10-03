# 思而行 SiErXing · 目标规划助手

> **说清目标与现状 → AI 反复确认 → 拆成可执行路径 → 边做边调。**

一个**本地运行、零第三方依赖**的目标规划应用。转行就业、学技能、考研考证、做作品、养习惯……任何能拆解的目标都能用。

思而行不是"帮你把任务列出来"的清单工具。它先用问卷（含客观自测）了解你的真实情况，不清楚的地方还能**逐题深挖追问**，问透之后才生成「阶段 → 小目标 → 任务」的可执行路径，并且**随时可以继续改**。

- 产品名：**思而行** · 目录名：**SiErXing**（英文，避免中文路径的兼容问题）
- 协议：**MIT**（可商用、可闭源，**请保留作者署名**） · 作者：sierxing · 仓库：<https://atomgit.com/sierxing/SiErXing>

---

## 🚀 30 秒上手

> ⚠️ **只复制代码块里的内容**，下面的中文说明粘到终端会报错。

**Linux / macOS**

```bash
git clone --depth 1 https://atomgit.com/sierxing/SiErXing.git ~/SiErXing && bash ~/SiErXing/scripts/install.sh
```

**Windows**（PowerShell，整行复制）

```powershell
git clone --depth 1 https://atomgit.com/sierxing/SiErXing.git "$env:USERPROFILE\SiErXing"; & "$env:USERPROFILE\SiErXing\scripts\install.bat"
```

想装到其它目录，把 `D:\SiErXing` 换成你的路径：

```powershell
$d="D:\SiErXing"; git clone --depth 1 https://atomgit.com/sierxing/SiErXing.git $d; & "$d\scripts\install.bat"
```

**手动启动**

```bash
node server/server.js          # 然后打开 http://localhost:3213
```

只需要 **Node.js ≥ 22.5**（推荐 24 LTS），**不需要 `npm install`**。
安装脚本会自动：检查 Node → 启动服务 → 建桌面图标 → 建终端命令 `sierxing` → 询问开机自启 → 打开浏览器。

<details>
<summary>或者：把这段提示词丢给你的 AI 助手，让它帮你装</summary>

```text
请帮我在本机部署并启动「思而行 SiErXing」——本地运行的目标规划助手（零第三方依赖，只需 Node.js）。

1. 检查 Node.js ≥ 22.5；不足则告诉我怎么装（推荐 Node 24 LTS）。
2. git clone --depth 1 https://atomgit.com/sierxing/SiErXing.git ~/SiErXing
   bash ~/SiErXing/scripts/install.sh        # Windows 用 scripts\install.bat
3. 验证：curl http://localhost:3213/api/health 应返回 {"ok":true}；端口被占用就换 PORT。
4. 按我的意愿开关开机自启：
   curl -s -X POST http://localhost:3213/api/service/autostart -H 'Content-Type: application/json' -d '{"enabled":true}'
5. 告诉我访问地址、桌面图标名、终端命令名。
6. 提醒我必须在页面「设置」里配置 AI 才能用。

注意：不要 npm install，不要改系统级配置；只写用户目录，无需管理员权限。
```

</details>

### 配置 AI（唯一必须做的事）

打开 <http://localhost:3213> → 左侧栏 **⚙ 设置** → 选接入方式 → **测试连接**：

| 方式 | 填什么 |
| --- | --- |
| **OpenAI 兼容接口**（推荐） | 点预设一键填好（DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI…），再填 API 密钥 |
| **本地 Ollama**（离线免费） | 地址 `http://localhost:11434/v1`，模型如 `qwen2.5:14b`，密钥随便填 |
| **opencode CLI**（已装可选） | 模型填 `provider/model`，地址密钥留空 |

配好后：**新建目标 → 回答问卷（可逐题深挖）→ 加约束 → 确认骨架 → 细化任务 → 开始执行**。第一次打开有 5 步使用引导。

---

## 界面截图

| 首次使用引导 | 目标页：路线图 · 约束 · 下一步 |
| --- | --- |
| ![引导](docs/screenshots/03-guide-2.png) | ![目标页](docs/screenshots/06-goal.png) |

| 全屏导图 | 对话改规划 |
| --- | --- |
| ![导图](docs/screenshots/07-map.png) | ![对话](docs/screenshots/08-chat.png) |

| 规划前问卷（含水平自测） | 组件中心（开关 / 分类 / 换肤） |
| --- | --- |
| ![问卷](docs/screenshots/09-questionnaire.png) | ![组件](docs/screenshots/12-components.png) |

| 版本对比（左旧右新） | 学习教程（真正学会，含练习与自测） |
| --- | --- |
| ![对比](docs/screenshots/11-diff.png) | ![教程](docs/screenshots/15-tutorial.png) |

> 更多截图见 [`docs/screenshots/`](docs/screenshots/)

---

## 能做什么

| | 能力 | 说明 |
| --- | --- | --- |
| 🎯 | **目标与规划** | 问卷澄清（含自测）→ 阶段 / 小目标 / 任务三级骨架 → 逐级细化 |
| 🗺 | **导图与执行** | 全屏导图看全局；路线图上勾选、折叠、看完成态 |
| ✏️ | **随时改规划** | 对话说"加一阶段/跳过已掌握"，AI 改骨架，不用推倒重来 |
| 📜 | **版本存档** | 手动存档、收藏置顶、左右对比回滚——重新规划弄丢了也能找回来 |
| 📚 | **学习教程** | 按你的目标生成教程；可在教程里直接标记书签、随堂测验 |
| 🔍 | **信息源检索** | 上传图片自动识别；批量导入电子书/TXT/PDF；按目标搜集公开资料并入库 |
| 🧩 | **组件系统** | 功能与界面样式都是组件，可开关、导入导出；**每个目标可单独开关，互不干扰** |
| 📊 | **资源库** | 资料按规划归类汇总，一键导出 |
| 🔁 | **多端同步** | 用 Git 仓库做快照，自动上传 / 启动拉取 |
| ⏱ | **每日刷题** | 编程类目标适用：LeetCode 热题 100 |
| 🚀 | **一键更新** | 启动自动检测新版本 |

---

## 组件：功能可以自己加

每个功能、甚至界面皮肤都是**独立文件**的组件，放在 `server/plugins/` 与 `public/plugins/`，改完刷新即生效，不用重新安装。

内置：信息源导入 / 每日刷题 / 学习统计 / 教程书签 / 随堂测验 / 笔记面板 / 代码工作区 / 番茄钟 / 提示词库 / 碳黑·宣纸主题。

**开关按目标隔离**：组件管理页顶部选「🌍 全局默认」还是某个「🎯 目标」，选目标时下面的开关只影响那一个目标，其它目标不受影响。组件的功能入口放进**该页顶栏的标签栏**里，可拖拽排序、收进收藏夹或 ⋯ 菜单。

**分享组件**：组件页点「导出」得到 `*.component.json`，对方导入即可装好。

自己写一个：新建 `server/plugins/xxx.js`（元数据 + 接口 + 建表）、`public/plugins/xxx.js`（界面）、`public/plugins/xxx.css`（样式），重启即可。接口约定见 [`AGENTS.md`](AGENTS.md)。

---

## 数据、备份与隐私

- **数据库**：`data/sierxing.db`（SQLite 单文件）
- **自动备份**：每次改动自动备份到 `data/backups/`，保留最近 30 份
- **导出/导入**：设置页「导出全部 JSON」可导出所有目标、节点、来源、版本、教程、对话
- **上传的图片/电子书**：`data/uploads/`
- **隐私**：数据只存在本机，除调用你配置的 AI 接口外不上传任何内容
  - 信息源检索会访问百度/必应等公开页面（不用就不点）
  - 每日刷题会读取本机插件登录态并访问 leetcode.cn（不用可关）
- **API 密钥**：存在本机数据库或 `.env`，前端只显示掩码

---

## 常见问题

**一定要装 opencode 吗？** 不用。默认走 OpenAI 兼容接口，填地址 + 密钥 + 模型即可。

**报错 `当前 Node.js 不支持内置 SQLite`？** Node 版本太低。升级到 Node 24 LTS，或用 `npm run start:sqlite`（脚本会自动判断）。

**端口被占用？** `PORT=其他端口 node server/server.js`，默认 3213。

**数据会丢吗？** 不会自动上传到任何服务器。备份在 `data/backups/`，也可以用设置页导出 JSON。

**能商用吗？** 能，MIT 协议不要求开源你的修改，唯一要求是保留署名。

---

## 给开发者 / AI 助手

代码结构、组件接口、数据表、接口约定、以及**一堆踩过的坑**，都在 [`AGENTS.md`](AGENTS.md)。
想直接上手改代码，建议先读它。

```bash
node server/server.js              # 启动（默认 3213）
PORT=3214 node server/server.js    # 换端口
```

技术栈：Node 内置 `http` + `node:sqlite`，**零第三方依赖**；前端原生 JS，无构建步骤。

---

## 许可与署名

[MIT](LICENSE)。可自由使用、商用、修改、闭源分发，**唯一要求是保留作者署名**：

```
基于「思而行 SiErXing」开源项目构建 —— 原作者：sierxing
https://atomgit.com/sierxing/SiErXing
```

如需**显式专利授权**，可换用 Apache-2.0（同样允许商用闭源，但需保留 NOTICE 与版权声明）。
