# Prompt Keeper

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-blue.svg)](https://github.com/SillyTavern/SillyTavern)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper)

SillyTavern 扩展插件 — 为每个聊天会话（Chat Session）独立保存和恢复 Prompt Manager 中 Prompt Entry 的开关状态。

## 📖 项目介绍

在 SillyTavern 中，Prompt Manager 的条目开关状态是全局共享的。当你在不同聊天中使用不同的 Prompt 组合时，切换聊天后需要手动重新配置。

**Prompt Keeper** 解决了这个问题：

- 聊天 A：✓ Persona ✓ Memory ✓ Style
- 聊天 B：✓ Persona ✓ Jailbreak

切换聊天时，插件自动恢复对应聊天的 Prompt Entry 配置，无需手动调整。

## ✨ 功能说明

### 核心功能

- **自动保存**：用户开启/关闭/修改 Prompt Entry 时自动保存状态
- **自动恢复**：切换/打开/加载聊天时自动恢复该聊天对应的 Prompt Entry 配置
- **手动操作**：提供 Save、Restore、Delete 按钮支持手动管理

### 恢复模式

| 模式 | 描述 |
|------|------|
| 自动恢复 | 切换聊天后立即自动恢复配置，无需用户干预 |
| 询问恢复 | 切换聊天后弹出确认对话框，由用户决定是否恢复 |
| 仅提示 | 显示通知提醒，用户可手动点击按钮恢复 |

### 操作按钮

| 按钮 | 功能 |
|------|------|
| 💾 Save | 立即保存当前聊天的 Prompt Entry 配置 |
| ↺ Restore | 恢复当前聊天已保存的 Prompt Entry 配置 |
| 🗑 Delete | 删除当前聊天的已保存配置 |

### 状态显示

按钮旁实时显示：

- ✓ Saved + Last Save 时间（已保存）
- ⚠ Not Saved（未保存）

## 📦 安装步骤

### 方法 1：通过 SillyTavern Extension Installer（推荐）

1. 打开 SillyTavern
2. 进入 **Extensions** 面板
3. 点击 **"Install Extension"** 按钮
4. 输入仓库地址：
   ```
   https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
   ```
5. 点击安装，等待完成后刷新页面

### 方法 2：手动安装

1. 克隆仓库到 SillyTavern 扩展目录：
   ```bash
   cd SillyTavern/data/default-user/extensions/
   git clone https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper.git
   ```

2. 确认目录结构：
   ```
   extensions/
   └── prompt-keeper/
       ├── manifest.json
       ├── index.js
       ├── style.css
       ├── settings.html
       ├── LICENSE
       └── README.md
   ```

3. 重启 SillyTavern 或刷新页面

## 🔧 使用方法

### 基本使用

1. 安装启用后，在 **Prompt Manager** 区域顶部会出现 Prompt Keeper 操作面板
2. 正常使用 Prompt Manager 开关各条目，插件会**自动保存**状态
3. 切换到其他聊天时，插件会根据设置**自动恢复**该聊天的配置

### 设置面板

在 SillyTavern **Extensions** 设置区域找到 **Prompt Keeper**：

- **启用插件**：开启或关闭全部功能
- **恢复模式**：选择切换聊天时的配置恢复方式

### 数据存储

- 配置数据保存在**聊天元数据（Chat Metadata）**中
- 数据随聊天记录一起保存，不需要额外存储文件
- 删除聊天记录时，对应配置数据也一并删除
- 绑定对象是 **Chat Session**（聊天唯一 ID），不绑定角色/头像/角色名

### 管理范围

本插件**只管理** Prompt Entry 的开关状态。

**不管理**：模型、API、Temperature、Top P、Instruct Preset、Context Template、Generation Settings。

## 🐛 调试

打开浏览器控制台（F12），查看带 `[PromptKeeper]` 前缀的日志：

```
[PromptKeeper] Extension loaded successfully
[PromptKeeper] Settings loaded
[PromptKeeper] Saved config for chat: xxx
[PromptKeeper] Restored config for chat: xxx
[PromptKeeper] Deleted config for chat: xxx
[PromptKeeper] Chat changed to: xxx
[PromptKeeper] Auto-saved after toggle change
```

## ⚠️ 已知限制

- 仅支持 Chat Completion 模式下的 Prompt Manager
- 如果 Prompt Entry 的 identifier 发生变化（如切换预设），旧配置可能无法正确匹配
- 需要 SillyTavern 1.11+ 版本（支持 `event_types.CHAT_CHANGED`）

## 📋 更新日志

### v1.0.0 (2025-06-14)

**首次发布**

- ✅ Prompt Entry 状态自动保存
- ✅ 聊天切换时自动恢复
- ✅ 三种恢复模式（自动/询问/仅提示）
- ✅ Save / Restore / Delete 操作按钮
- ✅ 实时状态显示（保存状态 + 时间）
- ✅ 设置面板集成
- ✅ 防抖机制避免频繁保存
- ✅ 事件驱动，不使用轮询
- ✅ 使用 CSS 变量适配主题

## ❓ FAQ

**Q: 配置保存在哪里？**

A: 保存在聊天元数据（Chat Metadata）中，随聊天文件一起存储。不会创建额外文件。

**Q: 切换 Completion Preset 后，之前保存的配置还有效吗？**

A: 如果新预设中的 Prompt Entry identifier 与之前相同，则有效。如果 identifier 改变了，插件只会恢复能匹配到的条目。

**Q: 插件会修改 SillyTavern 核心代码吗？**

A: 不会。插件完全通过官方 Extension API 实现，不修改任何核心源码。

**Q: 可以禁用自动保存吗？**

A: 关闭插件开关即可禁用所有自动行为。你仍然可以使用手动按钮保存/恢复。

**Q: 支持群聊（Group Chat）吗？**

A: 支持。插件绑定的是 Chat Session ID，群聊也有独立的聊天 ID。

## 📁 项目结构

```
prompt-keeper/
├── manifest.json      # 插件清单文件
├── index.js           # 插件主逻辑
├── style.css          # 插件样式
├── settings.html      # 设置面板模板
├── LICENSE            # MIT 许可证
└── README.md          # 项目说明
```

## 🏗️ 技术说明

- 使用 SillyTavern 官方 Extension API
- 事件驱动机制（非轮询），性能友好
- 数据存储在聊天元数据中，无需额外后端
- 不修改 SillyTavern 核心源码
- CSS 变量适配不同主题

## 📄 许可证

[MIT License](LICENSE)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/my-feature`)
3. 提交更改 (`git commit -m 'Add feature'`)
4. 推送 (`git push origin feature/my-feature`)
5. 创建 Pull Request
