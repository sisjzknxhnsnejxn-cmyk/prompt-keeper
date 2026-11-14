# Changelog

All notable changes to **Prompt Keeper** are documented in this file.

## [v2.2.3] - 2026-11-14

### 🐛 Bug Fixes & Persistence Hardening
- **修复「保存时自定义槽位名称」等设置在刷新、更新或重装后被重置的问题**：
  - 阻止 `loadPluginSettings()` 在 SillyTavern 异步加载 `extension_settings` 完成前用默认值（`customSaveName: false`）提前覆盖配置。
  - 新增 `syncPluginSettingsWithServer()` 与 `syncSettingsPanelUI()`，在 `APP_READY`、`SETTINGS_LOADED`、`EXTENSION_SETTINGS_LOADED`、`SETTINGS_LOADED_AFTER` 及设置面板重绘时实时同步复选框状态。
  - 新增浏览器本地存储（`accountStorage` / `localStorage`）双保险设置镜像备份（`promptKeeper_settings_backup_v1`），即使插件卸载重装也能自动恢复全部开关偏好。
- **修复已保存的预设槽位在更新、刷新或重装后丢失/不显示的问题**：
  - 移除 `slots` 与 `prompts` 数据结构中的 `Object.create(null)`，统一改用标准 Plain Object `{}` + `hasOwnProperty` 安全校验，防止在 SillyTavern `updateChatMetadata` / `jQuery.extend` 深拷贝时因无原型链被丢弃。
  - 在 `persistChatMetadata()` 中同步调用 `ctx.updateChatMetadata` 与 `ctx.saveMetadata()`。
  - 新增三重槽位持久化架构（`chatMetadata` + `extensionSettings.slotsBackup` + 本地存储 `promptKeeper_slots_backup_v2`），同时维护聊天级槽位自愈备份与全局槽位池，确保用户保存的槽位永久留存。
  - 修复 `status-bar.js` 中操作栏 DOM 重建后因内存签名缓存提前退出导致状态栏卡在「未保存」的问题。
- 统一同步 `index.js`、`manifest.json` 与 `src/config/constants.js` 版本号为 `2.2.3`。

## [v2.2.1] - 2026-11-14

### 🐛 Bug Fixes
- 修复 `src/ui/input-modal.js` 中 `bindIOSModalViewportAndScrollLock` 函数闭合花括号错位导致的 ES Module `SyntaxError: Unexpected token 'export'`，恢复操作栏与扩展设置面板的正常挂载。
- 为 `index.js` 加载 `style.css` 与 `src/entry.js` 默认附带版本号查询参数（`?v=2.2.1`），确保扩展更新后浏览器及 iOS Safari 立即拉取最新文件。

## [v2.2.0] - 2026-11-14

### ✨ UI 美学升级与极简重塑
- **极简无废话界面**：移除操作栏、设置面板及弹窗中的所有冗余解释文本与繁杂元信息，仅保留核心状态与操作。
- **横向按钮防折行加固**：修复操作栏按钮（`保存` / `恢复` / `删除`）在部分酒馆抽屉窄宽度或全局样式覆盖下文字竖排折行的问题。
- **黄金两行槽位卡片**：
  - 第一行：左侧展示槽位名称与 `当前` / `默认` 胶囊徽章，右侧提供紧凑星标按钮（设为默认，已默认时呈暖金色点亮态）与删除图标按钮。
  - 第二行：采用对称 `1 : 1` 双栏网格排布 `↺ 恢复`（主按钮）与 `✦ 仅套用条目`（次按钮），在任何屏幕宽度下均工整对齐、不乱折行。
  - 当前匹配的预设槽位卡片自带柔和微光边框与浅底高亮。
- **内置日间 / 夜间一键切换**：弹窗右上角集成日间/夜间切换按钮，默认采用干净清爽的日间模式，自动持久化用户配色偏好。

### 📱 iOS Safari 与移动端多端协作深度适配
- **原位二次确认微交互**：槽位弹窗中点击「删除」或「清空全部」时，首次点击原位平滑展开为实心红色 `确认` / `确认清空？` 按钮（3 秒未操作自动复原），彻底避免传统二次弹窗在移动端产生 `z-index` 层级遮挡或被 WebView 拦截。
- **自绘极简输入与确认弹窗（`src/ui/input-modal.js`）**：开启「保存时自定义槽位名称」或单槽位快捷删除时，采用与主弹窗同风格的自绘极简弹窗，支持一键清空输入、回车提交与 ESC 取消。
- **杜绝 iOS Safari 页面自动放大**：所有输入框（含槽位名输入框与设置面板延迟毫秒输入框）强制设置 `font-size: 16px`，防止 iOS Safari 聚焦输入时强制放大页面。
- **iOS Bottom Sheet 底部浮层与视口跟随**：
  - 窄屏移动端（`<= 520px`）自动切换为原生感 iOS 底部抽屉卡片（顶部带 Grabber 指示条與弹簧上滑动画），底部适配 `env(safe-area-inset-bottom)` 安全区留白。
  - 接入 `window.visualViewport` 动态同步软键盘弹起与地址栏伸缩时的可视高度和偏移量。
  - 锁定遮罩层非滚动列表区域的 `touchmove` 事件，防止手指滑动弹窗边缘时带动底层酒馆背景页面滚动穿透。

---

## [v2.1.1]

- 将插件发布版本统一为 `2.1.1`。
- 修复入口仍加载未包含在仓库中的世界书模块、从而可能导致插件启动失败的问题。
- 修正文档，使功能说明与当前实际实现一致。

## [v2.1.0]

- 新增免刷新热重载，并增强旧运行时清理逻辑。
- 改进角色卡删除后重新导入场景中的 Prompt 排序恢复。
- 增强保存按钮防重复触发保护。
- 优化保存、恢复、删除按钮的触控事件，并补充键盘 Enter / Space 操作支持。
- 优化槽位弹窗的元信息展示。
- 将设置页使用说明改为折叠区域。

## [v2.0.3]

- 修复部分 SillyTavern 版本在扩展更新后可能找不到插件或设置面板不出现的问题。
- 为 `manifest.json` 补充稳定的 `name` / `id` 字段。
- 增强拆分脚本加载器。

## [v2.0.2]

- 优化多端响应式布局和移动端适配。
- 优化槽位选择弹窗表现。

## [v2.0.1]

- 增强按钮事件绑定兼容性。
- 为槽位弹窗加入明暗主题切换与触控反馈。
- 优化 UI 自动重新注入策略。

## [v1.1.1]

- 修复脏检查在 DOM 回退路径下因 `promptOrder` 类型不一致导致重复恢复的问题。

## [v1.0.0]

- 初始发布。
- 按聊天保存 Prompt 条目状态、排序和活跃预设。
- 支持切换聊天时自动恢复。
