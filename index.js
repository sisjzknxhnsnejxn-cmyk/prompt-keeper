/**
 * Prompt Keeper - SillyTavern Extension
 *
 * 为每个聊天会话（Chat Session）保存和恢复 Prompt Manager 中 Prompt Entry 的开关状态。
 * 配置数据存储在聊天元数据（Chat Metadata）中，随聊天记录一起保存。
 *
 * 架构：纯粹的"状态记忆与同步"轻量级工具
 * 三接口铁三角：
 *   1. CHAT_CHANGED → 自动恢复
 *   2. SETTINGS_UPDATED / PROMPT_MANAGER_UPDATED → 自动保存兜底
 *   3. document change 事件委托 → 即时保存（带防抖）
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 3.0.0
 * @license MIT
 * @homepage https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

// ============================================================
// 常量定义
// ============================================================

/** 模块名称，用于设置存储和聊天元数据的 key */
const MODULE_NAME = 'prompt_keeper';

/** 日志前缀 */
const LOG_PREFIX = '[PromptKeeper]';

/** 默认插件设置 */
const DEFAULT_SETTINGS = {
    /** 恢复模式: 'auto' 自动恢复 | 'ask' 询问恢复 | 'notify' 仅提示 */
    restoreMode: 'auto',
    /** 是否启用插件 */
    enabled: true,
};

/** 防抖保存延迟（毫秒） */
const SAVE_DEBOUNCE_DELAY = 800;

// ============================================================
// Prompt State 读写
// ============================================================

/**
 * 获取当前所有 Prompt Entry 的状态
 * 通过 SillyTavern 内部数据结构读取 prompt_order
 * @returns {Array<{identifier: string, enabled: boolean}>|null}
 */
function getPromptStates() {
    try {
        const context = getContext();
        if (!context) return null;

        // 尝试通过 PromptManager 实例获取（ST 官方暴露的方式）
        // ST 的 getContext() 通常会挂载 promptManager 或类似属性
        let promptOrder = null;

        // 方式 1: context 上的 promptManager
        if (context.promptManager) {
            const pm = context.promptManager;
            if (typeof pm.getPromptOrder === 'function') {
                promptOrder = pm.getPromptOrder();
            } else if (pm.serviceSettings && Array.isArray(pm.serviceSettings.prompt_order)) {
                promptOrder = pm.serviceSettings.prompt_order;
            }
        }

        // 方式 2: 全局 oai_settings 中的 prompt_order
        if (!promptOrder && window.oai_settings && Array.isArray(window.oai_settings.prompt_order)) {
            promptOrder = _resolvePromptOrder(window.oai_settings.prompt_order, context);
        }

        // 方式 3: power_user 或其他全局设置对象
        if (!promptOrder && window.power_user && Array.isArray(window.power_user.prompt_order)) {
            promptOrder = _resolvePromptOrder(window.power_user.prompt_order, context);
        }

        if (!promptOrder || !Array.isArray(promptOrder) || promptOrder.length === 0) {
            return null;
        }

        // 标准化为 [{identifier, enabled}] 格式
        const states = [];
        for (const item of promptOrder) {
            if (!item || typeof item !== 'object') continue;
            const identifier = item.identifier ?? item.name ?? item.id;
            if (!identifier) continue;

            let enabled = true;
            if ('enabled' in item) enabled = item.enabled !== false;
            else if ('active' in item) enabled = item.active !== false;
            else if ('disabled' in item) enabled = !item.disabled;

            states.push({ identifier, enabled });
        }

        return states.length > 0 ? states : null;
    } catch (e) {
        console.error(`${LOG_PREFIX} Error reading prompt states:`, e);
        return null;
    }
}

/**
 * 设置 Prompt Entry 的状态
 * @param {Array<{identifier: string, enabled: boolean}>} states
 * @returns {boolean}
 */
function setPromptStates(states) {
    if (!states || !Array.isArray(states) || states.length === 0) return false;

    try {
        const context = getContext();
        if (!context) return false;

        let promptOrder = null;
        let pm = null;

        // 方式 1: context 上的 promptManager
        if (context.promptManager) {
            pm = context.promptManager;
            if (typeof pm.getPromptOrder === 'function') {
                promptOrder = pm.getPromptOrder();
            } else if (pm.serviceSettings && Array.isArray(pm.serviceSettings.prompt_order)) {
                promptOrder = pm.serviceSettings.prompt_order;
            }
        }

        // 方式 2: 全局 oai_settings
        if (!promptOrder && window.oai_settings && Array.isArray(window.oai_settings.prompt_order)) {
            promptOrder = _resolvePromptOrder(window.oai_settings.prompt_order, context);
        }

        // 方式 3: power_user
        if (!promptOrder && window.power_user && Array.isArray(window.power_user.prompt_order)) {
            promptOrder = _resolvePromptOrder(window.power_user.prompt_order, context);
        }

        if (!promptOrder || !Array.isArray(promptOrder)) return false;

        const stateMap = new Map(states.map(s => [s.identifier, s.enabled]));
        let changed = false;

        for (const item of promptOrder) {
            if (!item || typeof item !== 'object') continue;
            const id = item.identifier ?? item.name ?? item.id;
            if (!id || !stateMap.has(id)) continue;

            const shouldBeEnabled = stateMap.get(id);
            if ('enabled' in item) {
                if (item.enabled !== shouldBeEnabled) { item.enabled = shouldBeEnabled; changed = true; }
            } else if ('active' in item) {
                if (item.active !== shouldBeEnabled) { item.active = shouldBeEnabled; changed = true; }
            } else if ('disabled' in item) {
                const shouldBeDisabled = !shouldBeEnabled;
                if (item.disabled !== shouldBeDisabled) { item.disabled = shouldBeDisabled; changed = true; }
            } else {
                item.enabled = shouldBeEnabled;
                changed = true;
            }
        }

        if (changed) {
            // 尝试通过 PM 实例触发保存和渲染
            if (pm) {
                if (typeof pm.saveServiceSettings === 'function') {
                    pm.saveServiceSettings();
                } else if (typeof pm.render === 'function') {
                    pm.render();
                }
            }
            saveSettingsDebounced();
        }

        return true;
    } catch (e) {
        console.error(`${LOG_PREFIX} Error setting prompt states:`, e);
        return false;
    }
}

/**
 * 解析 prompt_order 数组
 * prompt_order 格式可能是：
 *   [{character_id, order: [{identifier, enabled}]}]
 *   或直接是 [{identifier, enabled}]
 */
function _resolvePromptOrder(promptOrder, context) {
    if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;

    // 检查是否直接就是 order entries
    const first = promptOrder[0];
    if (first && typeof first === 'object' && ('identifier' in first || 'name' in first)) {
        return promptOrder;
    }

    // 按角色分组结构: [{character_id, order: [...]}]
    const charId = context?.characterId ?? context?.character_id;

    // 查找匹配角色的条目
    let entry = null;
    if (charId !== undefined) {
        entry = promptOrder.find(item => item && item.character_id === charId);
    }
    // 默认条目
    if (!entry) {
        entry = promptOrder.find(item =>
            item && (item.character_id == null || item.character_id === 'default')
        );
    }
    // 第一个有效条目
    if (!entry && promptOrder.length > 0) {
        entry = promptOrder[0];
    }

    if (!entry) return null;

    // 提取 order 数组
    if (Array.isArray(entry.order)) return entry.order;
    if (Array.isArray(entry.entries)) return entry.entries;
    if (Array.isArray(entry.prompts)) return entry.prompts;

    return null;
}

// ============================================================
// 设置管理
// ============================================================

/**
 * 加载插件设置
 */
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    Object.assign(extension_settings[MODULE_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[MODULE_NAME],
    });
    console.log(`${LOG_PREFIX} Settings loaded`, extension_settings[MODULE_NAME]);
}

// ============================================================
// 核心功能：保存 / 恢复 / 删除
// ============================================================

/**
 * 获取当前活动聊天的 ID
 * @returns {string|null}
 */
function getCurrentChatId() {
    try {
        const context = getContext();
        if (!context) return null;
        if (context.chatId) return String(context.chatId);
        if (context.chat_id) return String(context.chat_id);
        if (typeof context.getCurrentChatId === 'function') {
            const id = context.getCurrentChatId();
            if (id) return String(id);
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * 保存当前 Prompt Entry 状态到聊天元数据
 * @param {boolean} showToast - 是否显示提示
 * @returns {boolean}
 */
function saveConfig(showToast = false) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled) return false;

    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot save`);
        return false;
    }

    const states = getPromptStates();
    if (!states) {
        console.warn(`${LOG_PREFIX} Cannot read prompt entry states`);
        if (showToast) {
            toastr.warning('无法读取 Prompt Entry 状态', 'Prompt Keeper');
        }
        return false;
    }

    const context = getContext();
    const metadata = context.chat_metadata || context.chatMetadata;
    if (!metadata) {
        console.warn(`${LOG_PREFIX} Chat metadata not available`);
        return false;
    }

    metadata[MODULE_NAME] = {
        entries: states,
        updatedAt: new Date().toISOString(),
        version: 3,
    };

    // 保存聊天元数据
    if (typeof window.saveMetadataDebounced === 'function') {
        window.saveMetadataDebounced();
    } else if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
    }

    console.log(`${LOG_PREFIX} Saved config for chat: ${chatId} (${states.length} entries)`);

    if (showToast) {
        toastr.success(`Prompt 配置已保存 (${states.length} 条目)`, 'Prompt Keeper');
    }

    updateStatusDisplay();
    return true;
}

/**
 * 从聊天元数据中恢复 Prompt Entry 配置
 * @param {boolean} showToast
 * @returns {boolean}
 */
function restoreConfig(showToast = false) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot restore`);
        return false;
    }

    const context = getContext();
    const metadata = context.chat_metadata || context.chatMetadata;
    if (!metadata || !metadata[MODULE_NAME]) {
        console.log(`${LOG_PREFIX} No saved config for chat: ${chatId}`);
        if (showToast) {
            toastr.warning('未找到已保存的配置', 'Prompt Keeper');
        }
        return false;
    }

    const savedData = metadata[MODULE_NAME];
    const entries = savedData.entries;

    if (!entries || entries.length === 0) {
        console.warn(`${LOG_PREFIX} Saved config is empty`);
        return false;
    }

    const success = setPromptStates(entries);

    if (success) {
        console.log(`${LOG_PREFIX} Restored config for chat: ${chatId} (${entries.length} entries)`);
        if (showToast) {
            toastr.success(`Prompt 配置已恢复 (${entries.length} 条目)`, 'Prompt Keeper');
        }
    } else {
        console.warn(`${LOG_PREFIX} Failed to restore config`);
        if (showToast) {
            toastr.error('恢复配置失败', 'Prompt Keeper');
        }
    }

    updateStatusDisplay();
    return success;
}

/**
 * 删除当前聊天的已保存配置
 * @returns {boolean}
 */
function deleteConfig() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot delete`);
        return false;
    }

    const context = getContext();
    const metadata = context.chat_metadata || context.chatMetadata;
    if (!metadata || !metadata[MODULE_NAME]) {
        toastr.info('当前聊天没有已保存的配置', 'Prompt Keeper');
        return false;
    }

    delete metadata[MODULE_NAME];
    if (typeof window.saveMetadataDebounced === 'function') {
        window.saveMetadataDebounced();
    } else if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
    }

    console.log(`${LOG_PREFIX} Deleted config for chat: ${chatId}`);
    toastr.success('Prompt 配置已删除', 'Prompt Keeper');

    updateStatusDisplay();
    return true;
}

// ============================================================
// 防抖保存
// ============================================================

let _saveTimer = null;

/**
 * 带防抖的保存（避免用户连续操作导致频繁写入）
 */
function debouncedSaveConfig() {
    if (_saveTimer) {
        clearTimeout(_saveTimer);
    }
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        saveConfig(false);
        console.log(`${LOG_PREFIX} Auto-saved (debounced)`);
    }, SAVE_DEBOUNCE_DELAY);
}

// ============================================================
// 事件处理
// ============================================================

/**
 * 聊天切换事件处理 → 自动恢复
 */
function onChatChanged() {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    console.log(`${LOG_PREFIX} Chat changed to: ${chatId}`);

    // 延迟执行，确保酒馆的新聊天元数据已经完全加载
    setTimeout(() => {
        updateStatusDisplay();

        const settings = extension_settings[MODULE_NAME];
        if (!settings.enabled) return;

        const context = getContext();
        const metadata = context.chat_metadata || context.chatMetadata;
        if (!metadata || !metadata[MODULE_NAME]) {
            return;
        }

        switch (settings.restoreMode) {
            case 'auto':
                restoreConfig(false);
                break;
            case 'ask':
                showRestoreDialog();
                break;
            case 'notify':
                showRestoreNotification();
                break;
        }
    }, 500);
}

/**
 * 恢复确认对话框（询问模式）
 */
function showRestoreDialog() {
    const result = confirm('[Prompt Keeper]\n发现已保存的 Prompt Entry 配置。\n是否恢复？');
    if (result) {
        restoreConfig(true);
    }
}

/**
 * 恢复通知（通知模式）
 */
function showRestoreNotification() {
    toastr.info(
        '<span>发现已保存的 Prompt 配置。<br><button class="btn btn-primary btn-sm pk-restore-toast-btn" style="margin-top:5px;">点击恢复</button></span>',
        'Prompt Keeper',
        {
            timeOut: 10000,
            extendedTimeOut: 5000,
            closeButton: true,
            allowHtml: true,
            onclick: null,
        }
    );

    // 监听恢复按钮点击
    setTimeout(() => {
        const handler = (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('pk-restore-toast-btn')) {
                restoreConfig(true);
                const toast = e.target.closest('.toast');
                if (toast) toast.style.display = 'none';
            }
        };
        document.addEventListener('click', handler, { once: true, capture: true });
        setTimeout(() => document.removeEventListener('click', handler, true), 15000);
    }, 100);
}

// ============================================================
// UI 界面
// ============================================================

/**
 * 更新状态显示
 */
function updateStatusDisplay() {
    const statusEl = document.getElementById('pk-status');
    if (!statusEl) return;

    const chatId = getCurrentChatId();
    if (!chatId) {
        statusEl.innerHTML = '<span class="pk-status-nosave">⚠ 无活动聊天</span>';
        return;
    }

    const context = getContext();
    const metadata = context.chat_metadata || context.chatMetadata;
    if (!metadata || !metadata[MODULE_NAME]) {
        statusEl.innerHTML = '<span class="pk-status-nosave">⚠ Not Saved</span>';
        return;
    }

    const savedData = metadata[MODULE_NAME];
    const date = new Date(savedData.updatedAt);
    const formattedDate = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    const entryCount = savedData.entries ? savedData.entries.length : 0;
    statusEl.innerHTML = `<span class="pk-status-saved">✓ Saved (${entryCount})<br><small>${formattedDate}</small></span>`;
}

/**
 * 注入操作面板 UI
 */
function injectUI() {
    const buttonHtml = `
        <div id="pk-container" class="pk-container">
            <div class="pk-header">
                <span class="pk-title">Prompt Keeper</span>
                <div id="pk-status" class="pk-status"></div>
            </div>
            <div class="pk-buttons">
                <button id="pk-save-btn" class="menu_button" title="保存当前 Prompt Entry 配置">
                    💾 Save
                </button>
                <button id="pk-restore-btn" class="menu_button" title="恢复已保存的 Prompt Entry 配置">
                    ↺ Restore
                </button>
                <button id="pk-delete-btn" class="menu_button" title="删除当前聊天的保存配置">
                    🗑 Delete
                </button>
            </div>
        </div>
    `;

    const findInjectionTarget = () => {
        // 策略 1: 查找包含 "prompt" 和 "manager" 的容器
        const allElements = document.querySelectorAll('[id]');
        for (const el of allElements) {
            const id = el.id.toLowerCase();
            if (id.includes('prompt') && id.includes('manager') && !id.includes('list')) {
                return { element: el, position: 'afterbegin' };
            }
        }

        // 策略 2: 查找 AI/completion 配置区域
        for (const el of allElements) {
            const id = el.id.toLowerCase();
            if ((id.includes('ai') || id.includes('completion')) &&
                (id.includes('config') || id.includes('response'))) {
                return { element: el, position: 'afterbegin' };
            }
        }

        // 策略 3: 在 extensions 设置区域注入
        const extSettings = document.getElementById('extensions_settings') ||
                           document.getElementById('extensions_settings2');
        if (extSettings) {
            return { element: extSettings, position: 'afterbegin' };
        }

        return null;
    };

    const injectTarget = () => {
        if (document.getElementById('pk-container')) return true;

        const target = findInjectionTarget();
        if (target) {
            target.element.insertAdjacentHTML(target.position, buttonHtml);
            bindButtonEvents();
            updateStatusDisplay();
            return true;
        }

        return false;
    };

    // 初次尝试
    if (!injectTarget()) {
        let retryCount = 0;
        const maxRetries = 30;
        const retryInterval = setInterval(() => {
            retryCount++;
            if (injectTarget() || retryCount >= maxRetries) {
                clearInterval(retryInterval);
                if (retryCount >= maxRetries) {
                    console.warn(`${LOG_PREFIX} Could not find injection target after ${maxRetries} retries`);
                }
            }
        }, 1000);
    }
}

/**
 * 绑定按钮事件
 */
function bindButtonEvents() {
    const saveBtn = document.getElementById('pk-save-btn');
    const restoreBtn = document.getElementById('pk-restore-btn');
    const deleteBtn = document.getElementById('pk-delete-btn');

    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveConfig(true));
    }
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => restoreConfig(true));
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            if (confirm('确定要删除当前聊天的 Prompt Entry 配置吗？')) {
                deleteConfig();
            }
        });
    }
}

/**
 * 加载设置面板 UI
 */
async function loadSettingsUI() {
    try {
        const settingsPaths = [
            'scripts/extensions/third-party/prompt-keeper/settings.html',
            `scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
            'extensions/prompt-keeper/settings.html',
        ];

        let settingsHtml = null;

        for (const path of settingsPaths) {
            try {
                const response = await fetch(path);
                if (response.ok) {
                    settingsHtml = await response.text();
                    break;
                }
            } catch (e) {
                // continue
            }
        }

        if (!settingsHtml) {
            settingsHtml = generateSettingsHtml();
        }

        const settingsContainer = document.getElementById('extensions_settings2') ||
                                 document.getElementById('extensions_settings');
        if (settingsContainer) {
            settingsContainer.insertAdjacentHTML('beforeend', settingsHtml);
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to load settings UI:`, e);
        const settingsContainer = document.getElementById('extensions_settings2') ||
                                 document.getElementById('extensions_settings');
        if (settingsContainer) {
            settingsContainer.insertAdjacentHTML('beforeend', generateSettingsHtml());
        }
    }

    // 设置初始值
    const enabledCheckbox = document.getElementById('pk-enabled');
    const restoreModeSelect = document.getElementById('pk-restore-mode');

    if (enabledCheckbox) {
        enabledCheckbox.checked = extension_settings[MODULE_NAME].enabled;
    }
    if (restoreModeSelect) {
        restoreModeSelect.value = extension_settings[MODULE_NAME].restoreMode;
    }

    // 设置变更事件（事件委托）
    document.addEventListener('change', (e) => {
        if (e.target.id === 'pk-enabled') {
            extension_settings[MODULE_NAME].enabled = e.target.checked;
            saveSettingsDebounced();
        }
        if (e.target.id === 'pk-restore-mode') {
            extension_settings[MODULE_NAME].restoreMode = e.target.value;
            saveSettingsDebounced();
        }
    });
}

/**
 * 生成设置面板 HTML（当无法加载外部文件时）
 */
function generateSettingsHtml() {
    const settings = extension_settings[MODULE_NAME];
    return `
        <div class="pk-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Keeper</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="pk-setting-item">
                        <label>
                            <input type="checkbox" id="pk-enabled" ${settings.enabled ? 'checked' : ''}>
                            启用插件
                        </label>
                    </div>
                    <div class="pk-setting-item">
                        <label for="pk-restore-mode">恢复模式：</label>
                        <select id="pk-restore-mode" class="text_pole">
                            <option value="auto" ${settings.restoreMode === 'auto' ? 'selected' : ''}>自动恢复</option>
                            <option value="ask" ${settings.restoreMode === 'ask' ? 'selected' : ''}>询问恢复</option>
                            <option value="notify" ${settings.restoreMode === 'notify' ? 'selected' : ''}>仅提示</option>
                        </select>
                    </div>
                    <hr>
                    <small class="pk-description">
                        <b>自动恢复</b>：切换聊天时自动恢复配置<br>
                        <b>询问恢复</b>：切换聊天时弹出确认对话框<br>
                        <b>仅提示</b>：显示通知，手动点击恢复
                    </small>
                    <hr>
                    <small class="pk-description">
                        <b>版本：</b>3.0.0 | <b>兼容：</b>SillyTavern 1.12+<br>
                        <b>架构：</b>三接口铁三角（状态记忆与同步）
                    </small>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 插件入口 — 三接口铁三角
// ============================================================

jQuery(async () => {
    loadSettings();
    await loadSettingsUI();
    injectUI();

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 接口 1: 换聊天 → 恢复状态
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged();
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 接口 2: 底层设置变动 → 保存状态（兜底）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        saveConfig(false);
    });

    // 如果 PROMPT_MANAGER_UPDATED 事件存在，也监听
    if (event_types.PROMPT_MANAGER_UPDATED) {
        eventSource.on(event_types.PROMPT_MANAGER_UPDATED, () => {
            saveConfig(false);
        });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 接口 3: 用户手点开关 → 立即准备保存（带防抖）
    // 使用事件委托，捕获阶段监听，确保不遗漏
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!target || target.type !== 'checkbox') return;

        // 检查是否在 prompt manager 相关区域内
        if (target.closest('[id*="prompt"], [class*="prompt"], [data-prompt-id]')) {
            debouncedSaveConfig();
        }
    }, true); // 捕获阶段

    console.log(`${LOG_PREFIX} Extension loaded (v3.0.0, lightweight tri-interface architecture)`);
});
