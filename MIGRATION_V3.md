# V3 / Nodes 2.0 本地预览版

版本：2.0.49-v3-preview.2（Python 包版本 2.0.49rc2）。
基线：本机运行的 ComfyUI 端与 Photoshop 端 2.0.49。
下载的 Git 源码 1.9.3 仅作为仓库历史保留。

## 节点与工作流

入口使用 `ComfyExtension` / `comfy_entrypoint`；全部 9 个节点继承 `io.ComfyNode`，
使用 `define_schema`、`execute` 和 `io.NodeOutput`。不提供 V1 注册或执行回退。

保留 2.0.49 节点标识符：

| 节点 | 用途 |
| --- | --- |
| 🔹Photoshop Images | RGB、透明度、选区、宽高；PNG/JPEG 输入 |
| 🔹Photoshop Strings | 多行文本，同名同步 |
| 🔹Floats | 数值、滑块、范围和步长，同名同步 |
| 🔹SeedManager | 固定或自动随机种子，节点间同步 |
| 🔹SendTo Photoshop Plugin | 图像批次、透明度及 PNG 元数据；最多传送 4 张 |
| 🔹ClipPass / 🔹modelPass | CLIP / MODEL 直通 |
| 🔹Reroute - Anything Everywhere | 任意类型直通 |
| 🔹 Photoshop RemoteConnection | 可选的 Photoshop Remote Connection 输入 |

旧节点 `🔹Photoshop ComfyUI Plugin` 已删除。旧工作流中需要用图像、Float、SeedManager
和两个 String 节点分别替换它。图像节点的输出顺序为 RGB / ALPHA / SELECTION / W / H；
发送节点的输入为 RGB / ALPHA / cmUID。cmUID 由网页自动填入当前连接。

五个附带 SD1.5 工作流已转换并整理链接信息；仍需要它们原有的模型与第三方节点。
`data/workflows/v3-smoke.json` 是无需模型的基础检查工作流。

## 网页与通信

输入框和数值控件使用 ComfyUI 原生 widget，附加控件与图像预览使用 `addDOMWidget`。
保留 widget 对象和输入名称，不覆盖响应式 value，也不使用负尺寸、画布绘制或浮动图层。
通过原生 widget 值同步兼容 Nodes 2.0，防止程序设置文本时的回调递归与消息回送。
图像预览保留 MAIN DOC 的选区叠加。rgthree 限制选择器也使用注册的 DOM 控件。

保留 Photoshop 2.0.49 的 WebSocket / MessagePack、选区上传、批次图像、
PNG/JPEG、端口与客户端匹配协议。插件路径根据自身文件位置确定，
可在工作区测试，不要求固定文件夹名称。

preview.2 修复透明边缘白边：Photoshop Images 输出原始 RGB 和独立 ALPHA，
不再提前合成白底。直接连回 Send to PS 时可还原原始 RGBA。
ALPHA 为不透明度（0 透明、1 不透明），不是反向蒙版。
输入缺少 Alpha 的 JPEG、超过 8K 后转成 JPEG 的路径仍无法保留透明度。

删除旧自动安装、强制 Git 重置更新及旧绘制脚本。此预览版按本地工作区或本地预览包更新。
RemoteConnection 的可选依赖为 photoshop-connection；缺失时给出明确错误，不会在执行中安装或卸载包。

## 使用本地预览包

本机运行目录已同步。正常启动/重启 ComfyUI 后刷新 Photoshop 面板里的网页，
在 ComfyUI 设置中启用 Nodes 2.0（`Comfy.VueNodes.Enabled`）。

在另一处安装时，先停止 ComfyUI，将原插件完整备份到 custom_nodes 目录之外。
把预览 ZIP 中的 `comfyui-photoshop` 文件夹解压到 custom_nodes，再从备份中恢复
`data/ps_inputs` 用户图片和选区。使用新文件夹可以避免残留旧 JS 被前端同时加载。
Python 依赖写在 requirements.txt；RemoteConnection 的可选依赖只在需要该功能时安装。
本预览包配套的 Photoshop UXP 仍为 2.0.49；已有该版本时可继续使用。
上游 Photoshop 安装脚本会查找本机安装并更新 UXP 注册，只在确实需要安装 UXP 时使用。

## 可重复测试

已使用本机 ComfyUI 0.37.0、前端 1.53.6 和 Python 3.13.12。
下面的测试使用 CPU，不加载生成模型。测试图片是合成数据。

1. 用 ComfyUI 自身 Python 环境运行 `tests/run_headless.py`，传入
   `--comfy-root <ComfyUI根目录> --test-root <独立测试目录> --port 8190`。
2. 运行 `tests/test_integration.py --url http://127.0.0.1:8190 --report <报告.json>`。
3. 运行 `tests/test_nodes.py --comfy-root <ComfyUI根目录> --report <报告.json>`。
4. 在测试网页启用设置 `Comfy.VueNodes.Enabled`，打开 v3-smoke.json，
   检查同名文本/Float/Seed 同步、随机种子、运行、保存和重载。
5. 用 Node.js 的 `--experimental-vm-modules` 运行 `tests/test_widget_values.mjs`
   和 `tests/test_switchers.mjs`，验证原生回调递归、静默远程更新和 rgthree 状态读取。

具体执行结果见 [VALIDATION_V3.md](VALIDATION_V3.md)。

集成测试检查实际注册与执行、二进制图片上传、RGBA 与元数据、选区缓存失效、
透明度缩放/批次广播、4 张传送上限和未接 RGB 的输出节点。
节点合约测试还检查 CLIP/MODEL 直通、JPEG 输入、路径边界、
RemoteConnection 的两个输出与临时文件清理、示例链接一致性。

Photoshop 宿主内的按钮、实际画布写回、Remote Connection 及第三方 rgthree 完整交互
尚未在真实 Photoshop 宿主中验收；RemoteConnection 测试使用模拟连接。
Photopea 编辑器已改用浏览器原生对话框，但未调用外部 Photopea 服务验收编辑/保存。

参考：[官方 V3 迁移指南](https://docs.comfy.org/custom-nodes/v3_migration)、
[官方 DOM widget 实现](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/scripts/domWidget.ts)。
