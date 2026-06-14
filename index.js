/**
 * Prompt Keeper - SillyTavern Extension
 *
 * 为每个聊天会话（Chat Session）保存和恢复 Prompt Manager 中 Prompt Entry 的开关状态。
 * 配置数据存储在聊天元数据（Chat Metadata）中，随聊天记录一起保存。
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 1.0.0
 * @license MIT
 * @homepage https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
 */

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
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
// 核心功能函数
// ============================================================

/**
 * 获取当前活动聊天的 ID
 * @returns {string|null}
 */
function getCurrentChatId() {
    const context = getContext();
    if (!context || !context.chatId) {
        return null;
    }
    return String(context.chatId);
}

/**
 * 获取当前 Prompt Manager 中所有 Prompt Entry 的启用/禁用状态
 *
 * SillyTavern 的 Prompt Manager prompt order 存储在 power_user 或 oai_settings 中，
 * 可以通过 DOM 解析或者 getContext() 中获取。
 * 最可靠的方式是读取 completion prompt order 数组。
 *
 * @returns {Array|null} prompt order 快照，或 null
 */
function getCurrentPromptStates() {
    try {
        const context = getContext();

        // 尝试方式1: 通过 SillyTavern 暴露的 PromptManager API
        if (typeof context.getPromptManager === 'function') {
            const pm = context.getPromptManager();
            if (pm) {
                const orderArr = pm.getPromptOrder();
                if (orderArr && orderArr.length > 0) {
                    return orderArr.map(item => ({
                        identifier: item.identifier,
                        enabled: item.enabled !== false,
                    }));
                }
            }
        }

        // 尝试方式2: 直接从 DOM 读取 prompt manager 列表的状态
        const promptItems = document.querySelectorAll('#completion_prompt_manager_list .prompt_manager_prompt');
        if (promptItems.length > 0) {
            const states = [];
            promptItems.forEach(item => {
                const identifier = item.getAttribute('data-pm-identifier');
                if (!identifier) return;
                // 判断是否启用：查找 toggle 按钮/checkbox 状态
                const toggleEl = item.querySelector('.prompt_manager_prompt_toggle input[type="checkbox"], .prompt-toggle input[type="checkbox"]');
                let enabled = true;
                if (toggleEl) {
                    enabled = toggleEl.checked;
                } else {
                    // 备选：检查是否有 disabled class
                    enabled = !item.classList.contains('disabled');
                }
                states.push({ identifier, enabled });
            });
            if (states.length > 0) return states;
        }

        // 尝试方式3: 从 oai_settings 全局对象读取 prompt_order
        // SillyTavern 将 oai_settings 挂载在 window 上（某些版本）
        const oaiSettings = window.oai_settings;
        if (oaiSettings && oaiSettings.prompt_order) {
            // prompt_order 是一个数组，格式为 [{character_id, order: [{identifier, enabled}]}]
            const charId = context.characterId ?? context.characters?.[context.characterId]?.avatar;
            let orderEntry = null;

            if (Array.isArray(oaiSettings.prompt_order)) {
                // 查找当前角色的 prompt order，或默认的
                orderEntry = oaiSettings.prompt_order.find(
                    po => po.character_id === context.characterId
                );
                if (!orderEntry) {
                    // 使用默认（character_id 为 null 或 undefined）
                    orderEntry = oaiSettings.prompt_order.find(
                        po => po.character_id == null || po.character_id === 'default'
                    );
                }
            }

            if (orderEntry && orderEntry.order && orderEntry.order.length > 0) {
                return orderEntry.order.map(item => ({
                    identifier: item.identifier,
                    enabled: item.enabled !== false,
                }));
            }
        }

        console.warn(`${LOG_PREFIX} Could not read prompt entry states`);
        return null;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error reading prompt states:`, err);
        return null;
    }
}

/**
 * 将 prompt states 应用到当前 Prompt Manager
 * @param {Array} states - [{identifier, enabled}]
 * @returns {boolean} 是否成功
 */
function applyPromptStates(states) {
    if (!states || states.length === 0) return false;

    try {
        const context = getContext();
        let applied = false;

        // 尝试方式1: 通过 PromptManager API
        if (typeof context.getPromptManager === 'function') {
            const pm = context.getPromptManager();
            if (pm) {
                const orderArr = pm.getPromptOrder();
                if (orderArr && orderArr.length > 0) {
                    let changed = false;
                    for (const savedItem of states) {
                        const orderItem = orderArr.find(o => o.identifier === savedItem.identifier);
                        if (orderItem && orderItem.enabled !== savedItem.enabled) {
                            orderItem.enabled = savedItem.enabled;
                            changed = true;
                        }
                    }
                    if (changed) {
                        if (typeof pm.render === 'function') {
                            pm.render();
                        }
                        if (typeof pm.saveServiceSettings === 'function') {
                            pm.saveServiceSettings();
                        } else {
                            saveSettingsDebounced();
                        }
                        applied = true;
                    } else {
                        applied = true; // 没有变化也算成功
                    }
                    return applied;
                }
            }
        }

        // 尝试方式2: 通过 oai_settings.prompt_order
        const oaiSettings = window.oai_settings;
        if (oaiSettings && oaiSettings.prompt_order) {
            let orderEntry = null;

            if (Array.isArray(oaiSettings.prompt_order)) {
                orderEntry = oaiSettings.prompt_order.find(
                    po => po.character_id === context.characterId
                );
                if (!orderEntry) {
                    orderEntry = oaiSettings.prompt_order.find(
                        po => po.character_id == null || po.character_id === 'default'
                    );
                }
            }

            if (orderEntry && orderEntry.order) {
                let changed = false;
                for (const savedItem of states) {
                    const orderItem = orderEntry.order.find(o => o.identifier === savedItem.identifier);
                    if (orderItem && orderItem.enabled !== savedItem.enabled) {
                        orderItem.enabled = savedItem.enabled;
                        changed = true;
                    }
                }
                if (changed) {
                    saveSettingsDebounced();
                    // 触发 Prompt Manager 刷新 UI
                    refreshPromptManagerUI();
                }
                return true;
            }
        }

        // 尝试方式3: 通过 DOM 操作更新 checkbox
        const promptItems = document.querySelectorAll('#completion_prompt_manager_list .prompt_manager_prompt');
        if (promptItems.length > 0) {
            const stateMap = new Map(states.map(s => [s.identifier, s.enabled]));
            promptItems.forEach(item => {
                const identifier = item.getAttribute('data-pm-identifier');
                if (!identifier || !stateMap.has(identifier)) return;
                const shouldBeEnabled = stateMap.get(identifier);
                const toggleEl = item.querySelector('.prompt_manager_prompt_toggle input[type="checkbox"], .prompt-toggle input[type="checkbox"]');
                if (toggleEl && toggleEl.checked !== shouldBeEnabled) {
                    toggleEl.checked = shouldBeEnabled;
                    toggleEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            return true;
        }

        console.warn(`${LOG_PREFIX} Could not apply prompt states`);
        return false;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error applying prompt states:`, err);
        return false;
    }
}

/**
 * 尝试刷新 Prompt Manager 的 UI 显示
 */
function refreshPromptManagerUI() {
    try {
        const context = getContext();
        if (typeof context.getPromptManager === 'function') {
            const pm = context.getPromptManager();
            if (pm && typeof pm.render === 'function') {
                pm.render();
                return;
            }
        }
        // 备选: 触发一个自定义事件让 ST 知道设置变更
        // 或者手动触发完成预设选择器的变化事件
        const presetSelect = document.getElementById('openai_preset_selector');
        if (presetSelect) {
            presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not refresh PM UI:`, err);
    }
}

// ============================================================
// 配置保存/恢复/删除
// ============================================================

/**
 * 保存当前 Prompt Entry 状态到聊天元数据
 * @param {boolean} showToast - 是否显示提示
 * @returns {boolean}
 */
function saveConfig(showToast = false) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot save`);
        return false;
    }

    const states = getCurrentPromptStates();
    if (!states) {
        console.warn(`${LOG_PREFIX} Cannot read prompt entry states`);
        if (showToast) {
            toastr.warning('无法读取 Prompt Entry 状态', 'Prompt Keeper');
        }
        return false;
    }

    const context = getContext();
    if (!context.chatMetadata) {
        console.warn(`${LOG_PREFIX} Chat metadata not available`);
        return false;
    }

    context.chatMetadata[MODULE_NAME] = {
        entries: states,
        updatedAt: new Date().toISOString(),
        version: 1,
    };

    saveMetadataDebounced();
    console.log(`${LOG_PREFIX} Saved config for chat: ${chatId}`, states);

    if (showToast) {
        toastr.success('Prompt 配置已保存', 'Prompt Keeper');
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
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        console.log(`${LOG_PREFIX} No saved config for chat: ${chatId}`);
        if (showToast) {
            toastr.warning('未找到已保存的配置', 'Prompt Keeper');
        }
        return false;
    }

    const savedData = context.chatMetadata[MODULE_NAME];
    const entries = savedData.entries;

    if (!entries || entries.length === 0) {
        console.warn(`${LOG_PREFIX} Saved config is empty`);
        return false;
    }

    const success = applyPromptStates(entries);

    if (success) {
        console.log(`${LOG_PREFIX} Restored config for chat: ${chatId}`);
        if (showToast) {
            toastr.success('Prompt 配置已恢复', 'Prompt Keeper');
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
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        toastr.info('当前聊天没有已保存的配置', 'Prompt Keeper');
        return false;
    }

    delete context.chatMetadata[MODULE_NAME];
    saveMetadataDebounced();
    console.log(`${LOG_PREFIX} Deleted config for chat: ${chatId}`);
    toastr.success('Prompt 配置已删除', 'Prompt Keeper');

    updateStatusDisplay();
    return true;
}

// ============================================================
// 事件处理
// ============================================================

/**
 * 聊天切换事件处理
 */
function onChatChanged() {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    console.log(`${LOG_PREFIX} Chat changed to: ${chatId}`);

    // 延迟执行，确保聊天元数据已完全加载
    setTimeout(() => {
        updateStatusDisplay();

        const context = getContext();
        if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
            return;
        }

        const settings = extension_settings[MODULE_NAME];
        if (!settings.enabled) return;

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

    setTimeout(() => {
        $(document).off('click', '.pk-restore-toast-btn').on('click', '.pk-restore-toast-btn', function () {
            restoreConfig(true);
            $(this).closest('.toast').fadeOut();
        });
    }, 100);
}

// ============================================================
// Prompt Entry 状态监听（自动保存）
// ============================================================

/** 防抖定时器 */
let saveTimeout = null;

/**
 * Prompt Entry toggle 变化时的回调
 */
function onPromptEntryToggled() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled) return;

    const chatId = getCurrentChatId();
    if (!chatId) return;

    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
        saveConfig(false);
        console.log(`${LOG_PREFIX} Auto-saved after toggle change`);
    }, 600);
}

/**
 * 设置 Prompt Entry 状态变化的监听器
 * 使用事件委托监听 Prompt Manager 中的 toggle 操作
 */
function setupPromptEntryWatcher() {
    // 事件委托监听 Prompt Manager 区域的 click 事件
    $(document).on('click', '#completion_prompt_manager_list .prompt_manager_prompt_toggle, #completion_prompt_manager_list input[type="checkbox"]', function () {
        setTimeout(onPromptEntryToggled, 300);
    });

    // 监听通过拖拽排序等触发的 change 事件
    $(document).on('change', '#completion_prompt_manager_list input[type="checkbox"]', function () {
        setTimeout(onPromptEntryToggled, 300);
    });

    // MutationObserver 监听 prompt manager 列表区域的 DOM 变化
    const setupObserver = () => {
        const listEl = document.getElementById('completion_prompt_manager_list');
        if (!listEl) return;

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' &&
                    (mutation.attributeName === 'class' || mutation.attributeName === 'data-pm-enabled')) {
                    onPromptEntryToggled();
                    return;
                }
            }
        });

        observer.observe(listEl, {
            attributes: true,
            subtree: true,
            attributeFilter: ['class', 'data-pm-enabled'],
        });
    };

    // 延迟尝试绑定 observer
    setTimeout(setupObserver, 2000);

    // 聊天变更后重新尝试绑定
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(setupObserver, 1000);
    });
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
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        statusEl.innerHTML = '<span class="pk-status-nosave">⚠ Not Saved</span>';
        return;
    }

    const savedData = context.chatMetadata[MODULE_NAME];
    const date = new Date(savedData.updatedAt);
    const formattedDate = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    statusEl.innerHTML = `<span class="pk-status-saved">✓ Saved<br><small>Last Save: ${formattedDate}</small></span>`;
}

/**
 * 注入操作按钮到 Prompt Manager 区域附近
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

    const injectTarget = () => {
        if (document.getElementById('pk-container')) return true;

        // 优先注入到 Prompt Manager 容器
        const promptManager = document.getElementById('completion_prompt_manager');
        if (promptManager) {
            promptManager.insertAdjacentHTML('afterbegin', buttonHtml);
            bindButtonEvents();
            updateStatusDisplay();
            return true;
        }

        // 备选：AI Response Configuration 区域
        const aiConfig = document.getElementById('ai_response_configuration');
        if (aiConfig) {
            const header = aiConfig.querySelector('.completion_prompt_manager_header, #completion_prompt_manager_header');
            if (header) {
                header.insertAdjacentHTML('afterend', buttonHtml);
                bindButtonEvents();
                updateStatusDisplay();
                return true;
            }
        }

        return false;
    };

    // 初次尝试
    if (!injectTarget()) {
        // DOM 未就绪，使用短暂重试
        let retryCount = 0;
        const maxRetries = 30;
        const retryInterval = setInterval(() => {
            retryCount++;
            if (injectTarget() || retryCount >= maxRetries) {
                clearInterval(retryInterval);
            }
        }, 1000);
    }

    // 聊天变更后确保 UI 存在
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            if (!document.getElementById('pk-container')) {
                injectTarget();
            }
            updateStatusDisplay();
        }, 600);
    });
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
 * 加载设置面板
 */
function loadSettingsUI() {
    const settingsHtml = `
        <div class="pk-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Keeper</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="pk-setting-item">
                        <label>
                            <input type="checkbox" id="pk-enabled" ${extension_settings[MODULE_NAME].enabled ? 'checked' : ''}>
                            启用插件
                        </label>
                    </div>
                    <div class="pk-setting-item">
                        <label for="pk-restore-mode">恢复模式：</label>
                        <select id="pk-restore-mode" class="text_pole">
                            <option value="auto" ${extension_settings[MODULE_NAME].restoreMode === 'auto' ? 'selected' : ''}>自动恢复</option>
                            <option value="ask" ${extension_settings[MODULE_NAME].restoreMode === 'ask' ? 'selected' : ''}>询问恢复</option>
                            <option value="notify" ${extension_settings[MODULE_NAME].restoreMode === 'notify' ? 'selected' : ''}>仅提示</option>
                        </select>
                    </div>
                    <hr>
                    <small class="pk-description">
                        <b>自动恢复</b>：切换聊天时自动恢复配置<br>
                        <b>询问恢复</b>：切换聊天时弹出确认对话框<br>
                        <b>仅提示</b>：显示通知，手动点击恢复
                    </small>
                </div>
            </div>
        </div>
    `;

    const settingsContainer = document.getElementById('extensions_settings2');
    if (settingsContainer) {
        settingsContainer.insertAdjacentHTML('beforeend', settingsHtml);
    }

    // 绑定设置变更事件
    $(document).on('change', '#pk-enabled', function () {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $(document).on('change', '#pk-restore-mode', function () {
        extension_settings[MODULE_NAME].restoreMode = $(this).val();
        saveSettingsDebounced();
    });
}

// ============================================================
// 插件入口
// ============================================================

jQuery(async () => {
    loadSettings();
    loadSettingsUI();
    injectUI();

    // 监听聊天切换
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 设置自动保存监听
    setupPromptEntryWatcher();

    console.log(`${LOG_PREFIX} Extension loaded successfully`);
});
