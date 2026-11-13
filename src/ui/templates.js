/**
 * Prompt Keeper - UI HTML 模板构建器
 */

import { PLUGIN_VERSION } from '../config/constants.js';

/**
 * 构建 Prompt Manager 工具栏 HTML
 */
export function buildPromptKeeperBarHTML() {
    return `
<div id="prompt-keeper-bar" class="prompt-keeper-bar">
    <div class="prompt-keeper-header">
        <span class="prompt-keeper-title" title="Prompt Keeper — 为每个聊天独立保存预设条目状态与排列顺序">
            <i class="fa-solid fa-bookmark"></i> 预设状态
        </span>
        <span id="prompt-keeper-status" class="prompt-keeper-status pk-not-saved not-saved">未保存</span>
    </div>
    <div class="prompt-keeper-btn-group prompt-keeper-actions">
        <button id="prompt-keeper-save" type="button" class="menu_button menu_button_icon prompt-keeper-btn" title="保存当前预设条目开关和排列顺序到此聊天">
            <i class="fa-solid fa-floppy-disk"></i>
            <span>保存</span>
        </button>
        <button id="prompt-keeper-restore" type="button" class="menu_button menu_button_icon prompt-keeper-btn" title="恢复此聊天已保存的预设条目状态和顺序">
            <i class="fa-solid fa-rotate-left"></i>
            <span>恢复</span>
        </button>
        <button id="prompt-keeper-delete" type="button" class="menu_button menu_button_icon prompt-keeper-btn prompt-keeper-btn-danger" title="清除此聊天已保存的预设条目状态" style="display:none;">
            <i class="fa-solid fa-trash-can"></i>
            <span>删除</span>
        </button>
    </div>
</div>`;
}

/**
 * 构建扩展设置面板 HTML
 */
export function buildSettingsPanelHTML(settings) {
    return `
<div id="prompt-keeper-settings" class="prompt-keeper-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-bookmark" style="margin-right:6px;"></i>Prompt Keeper 预设状态管理</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="pk-setting-row">
                <label class="checkbox_label" for="pk-setting-enabled">
                    <input id="pk-setting-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>启用插件</span>
                </label>
                <small class="pk-setting-hint">关闭后将隐藏工具栏并停止所有自动恢复</small>
            </div>
            <div class="pk-setting-row">
                <label class="checkbox_label" for="pk-setting-auto-restore">
                    <input id="pk-setting-auto-restore" type="checkbox" ${settings.autoRestore ? 'checked' : ''} />
                    <span>切换聊天时自动恢复</span>
                </label>
                <small class="pk-setting-hint">打开聊天时自动恢复该聊天保存的预设条目状态与顺序</small>
            </div>
            <div class="pk-setting-row">
                <label class="checkbox_label" for="pk-setting-custom-save-name">
                    <input id="pk-setting-custom-save-name" type="checkbox" ${settings.customSaveName ? 'checked' : ''} />
                    <span>保存时自定义预设槽位名称</span>
                </label>
                <small class="pk-setting-hint">开启后点击“保存”会弹出输入框，可用自定义名称区分同一预设的不同条目组合</small>
            </div>
            <div class="pk-setting-row">
                <label for="pk-setting-slot-theme">槽位选择弹窗配色</label>
                <select id="pk-setting-slot-theme" class="text_pole">
                    <option value="light" ${settings.slotPickerTheme !== 'dark' ? 'selected' : ''}>浅色护眼（米白卡片 + 深棕文字）</option>
                    <option value="dark" ${settings.slotPickerTheme === 'dark' ? 'selected' : ''}>深色玻璃（跟随酒馆暗色风格）</option>
                </select>
                <small class="pk-setting-hint">切换“管理 / 恢复已保存预设槽位”弹窗的配色方案，方便在不同屏幕亮度和主题下清晰阅读</small>
            </div>
            <div class="pk-setting-row">
                <label for="pk-setting-delay">自动恢复延迟 (毫秒)</label>
                <input id="pk-setting-delay" type="number" class="text_pole" min="300" max="5000" step="100" value="${settings.autoRestoreDelay}" style="width:100px;" />
                <small class="pk-setting-hint">切换聊天后等待多久再执行恢复，手机端建议 1000~2000ms</small>
            </div>
            <hr class="sysHR" />
            <div class="pk-setting-footer">
                <small>版本 v${PLUGIN_VERSION} · 支持保存条目开关、拖拽顺序与所属预设（每聊天最多 5 槽位）</small>
            </div>
        </div>
    </div>
</div>`;
}
