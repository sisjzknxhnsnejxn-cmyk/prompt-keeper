# Changelog

All notable changes to **Prompt Keeper** are documented in this file.

## [v2.2.5] - 2026-11-14

### 🛡️ Anti-Refresh & Memory/CPU Footprint Optimization
- **全局触摸监听改为被动模式（Passive Touch Listeners）**：
  - 将 `document` 上的 `pointerdown`、`touchstart`、`pointermove`、`touchmove`、`pointercancel`、`touchcancel` 滑动识别监听器全部升级为 `{ capture: true, passive: true }`，彻底消除手机端滚动聊天记录或流式输出时阻塞浏览器合成器线程（Compositor Thread）引发的卡死与看门狗强制刷新。
- **严禁 `MutationObserver` 回退监听 `document.body`**：
  - 仅限定监听左侧预设面板容器（`#left-nav-panel` / `#completion_prompt_manager` / `#rm_api_block`），杜绝在聊天消息流式生成和美化正则渲染时产生高频 DOM 变动回调。
- **后台深度休眠机制（Visibility Hibernation）**：
  - 监听 `visibilitychange` 与 `pagehide` 事件；当页面切入后台或锁屏（`document.hidden === true`）时立即断开 `MutationObserver` 并清除所有定时器，实现后台**零 CPU 唤醒**，大幅降低 iOS Safari（Jetsam）与 Android 浏览器杀后台重载的概率；切回前台时无缝恢复。
  - 将 PC 端看门狗轮询间隔调整为 15 秒低频轻量检查，仅在扩展设置面板未挂载时尝试注入。
- **预设顺序快照瘦身（Compact `promptOrder`）**：
  - 新增 `compactPromptOrder()`，自动剥离 `prompt_order` 中的多角色历史冗余分组与多余属性，仅保留当前激活角色分组及默认分组的 `{ identifier, enabled }` 最小集；老存档在读取或迁移时也会自动瘦身，单槽位体积减少 70%~90%。
  - 将本地备份上限收敛为 `MAX_BACKUP_CHATS = 15`、`MAX_GLOBAL_SLOTS = 15`。
- **新增「防止手机端下拉误触刷新页面」与「刷新/关闭前确认拦截」设置**：
  - 默认开启「防止手机端下拉误触刷新页面」（通过 `overscroll-behavior-y: none` 阻止滑动到顶部时触发浏览器下拉刷新）。
  - 支持在扩展设置中按需开启「刷新或关闭页面前弹出确认拦截」（`beforeunload` 二次确认保护）。

## [v2.2.4] - 2026-11-14

### 🐛 Bug Fixes & Startup Stability
- **修复启动时酒馆自动强制刷新页面的问题**：
  - 移除对 SillyTavern `ctx.accountStorage` 的不当调用，并在 `APP_READY` 后自动清理旧版遗留的冗余备份键（`promptKeeper_settings_backup_v1`、`promptKeeper_slots_backup_v2`），防止全量预设槽位被重复打包进服务端 `settings.json` 触发启动超时与 `reloadLoop()` 静默刷新。
  - 将 `getSavedStateFromCurrentChat()` 与 `loadPluginSettings()` 改造为纯只读函数，彻底消除 UI 状态栏渲染与启动阶段隐式触发 `saveSettingsDebounced()` / `saveMetadata()` 的写风暴。
  - 为 `loadSlotsBackupStore()` 增加内存级缓存，避免启动期间高频重复执行 `JSON.parse` 与深层对象克隆；服务端 `extensionSettings` 仅保存去重后的 `globalSlots` 与轻量级聊天绑定索引（`chatBindings`）。
  - 区分聊天绑定槽位判定 `hasChatBoundSavedState()` 与全局槽位判定 `hasSavedState()`，杜绝在酒馆启动欢迎页（无打开聊天）或无绑定存档的新聊天中因全局兜底池误触发自动切换预设。
  - 修复 `index.js` 与 `src/utils/st-context.js` 中的脚本及模块路径解析兼容性，统一版本号为 `2.2.4`。

## [v2.2.3] - 2026-11-14

### 🐛 Bug Fixes & Persistence Hardening
- **修复「保存时自定义槽位名称」等设置在刷新、更新或重装后被重置的问题**：
  - 阻止 `loadPluginSettings()` 在 SillyTavern 异步加载 `extension_settings` 完成前用默认值（`customSaveName: false`）提前覆盖配置。
  - 新增 `syncPluginSettingsWithServer()` 与 `syncSettingsPanelUI()`，在 `APP_READY`、`SETTINGS_LOADED`、`EXTENSION_SETTINGS_LOADED`、`SETTINGS_LOADED_AFTER` 及设置面板重绘时实时同步复选框状态。
  - 新增浏览器本地存储（`accountStorage` / `localStorage`）双保险设置镜像备份（`promptKeeper_settings_backup_v1`），即使插件卸载重装也能自动恢复全部开关偏好。
- **修复已保存的预设槽位在更新、刷新或重装后丢失/不显示的问题**：
  - 移除 `slots` 与 `prompts` 数据结构中的 `Object.create(null)`，统一改用标准 Plain Object `{}` + `hasOwnProperty` 安全校验，防止在深拷贝或序列化时因无原型链被丢弃。
  - 严格对齐 SillyTavern 官方源码规范，原地修改 `ctx.chatMetadata[METADATA_KEY]` 后调用 `ctx.saveMetadata()`（移除一切不存在的猜测接口与无效 DOM 选择器）。
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
