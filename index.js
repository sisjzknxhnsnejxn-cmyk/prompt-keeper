/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) AND the active preset per chat session.
 * Uses chatMetadata for storage. Manual save, auto-restore on chat switch with debounce + dirty check.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 1.1.0
 * @license MIT
 *
 * v1.1.0 changes:
 * - 修复 Bug #1：startUIObserver 改为挂到持久祖先节点，subtree:true，防止幽灵监听
 * - 修复 Bug #4：高版本数据原样返回不降级写回，增加防降级保护
 * - 加固 Bug #3：switchToPreset 增加 PresetManager 原生方法探测层，DOM 选择器降为备选
 * - 加固 Bug #2：主路径走通用 getPresetManager() API，DOM fallback 仅为兜底
 * - 修复：聊天切换竞态问题——恢复过程中若 chatId 变化立即中止
 * - 修复：prompt_order 按 character_id 智能合并，保留新版本未知字段
 * - 修复：恢复后刷新 Prompt Manager UI，避免用户误判恢复失败
 * - 新增：metadata 保存结构加 version 字段，加 migrateState() 迁移旧数据
 * - 改进：预设名称匹配增加 trim+大小写宽松回退，失败提示更明确
 * - 改进：状态栏显示「✓ 已保存 HH:MM」，无弹窗防误操作
 * - 删除：settings.html（冗余文件，实际由 JS 内联 HTML 加载）
 * - 加固：MutationObserver 加重注入次数上限防死循环
 * - 加固：DOM fallback 多选择器兜底
 * - 加固：metadata 不保存 null/undefined 冗余字段
 * - iOS Safari 性能优化：切换聊天时不再重复全量注入 UI
 * - 精简多层嵌套 setTimeout，合并延迟，用 requestAnimationFrame 刷新 UI
 * - MutationObserver 加节流，避免频繁触发重注入
 * - 脏检查 promptOrder 比较从 JSON.stringify 改为逐项浅比较
 * - 修复：保存即覆盖，无需先删后加；保存后加保护标记，防止自动恢复立刻把预设切回
 * - onChatChanged 仅在 chatId 真正变化时触发自动恢复
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';
const SETTINGS_KEY = 'promptKeeperPluginSettings';
const METADATA_VERSION = 1;

// Default plugin settings
const DEFAULT_SETTINGS = {
    enabled: true,        // 插件默认启动
    autoRestore: true,    // 切换聊天时自动恢复
    autoRestoreDelay: 1500, // 防抖延迟（毫秒）
};

// Settings panel HTML
const SETTINGS_HTML = `
<div id="prompt-keeper-settings" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Prompt Keeper</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
        <div class="settings_section">
            <label class="checkbox_label" for="pk-enabled-toggle">
                <input type="checkbox" id="pk-enabled-toggle" checked />
                <span>启用插件</span>
            </label>
            <label class="checkbox_label" for="pk-auto-restore-toggle">
                <input type="checkbox" id="pk-auto-restore-toggle" checked />
                <span>切换聊天时自动恢复</span>
            </label>
        </div>
        <hr class="sysHR" />
        <div class="settings_section">
            <label><strong>保存方式：</strong> 手动点击保存按钮</label>
            <label><strong>恢复方式：</strong> 自动（切换聊天时延迟恢复）或手动</label>
            <label><strong>保存位置：</strong> 当前聊天的元数据中</label>
        </div>
    </div>
</div>`;

// ========== State ==========

/** Debounce timer for auto-restore */
let autoRestoreTimer = null;

/**
 * 上一次处理的 chatId，用于判断聊天是否真正切换
 * 避免同一聊天内手动改预设触发自动切回
 */
let lastHandledChatId = null;

/**
 * 刚保存的聊天 ID 保护标记。
 * 保存成功后设置为当前 chatId，自动恢复检测到该值时跳过一次，
 * 避免"在新预设下保存后立刻被自动恢复切回旧预设"。
 * 在下次真正的 CHAT_CHANGED 后清除。
 */
let justSavedChatId = null;

/** MutationObserver instance for monitoring UI removal */
let uiObserver = null;

/** Observer 节流计时器 */
let observerThrottleTimer = null;

/**
 * Observer 重注入计数器（防死循环）
 * 短时间内超过阈值则暂停重注入
 */
let observerReinjectionCount = 0;
let observerReinjectionResetTimer = null;
const OBSERVER_REINJECTION_LIMIT = 10;    // 30 秒内最多重注入 10 次
const OBSERVER_REINJECTION_WINDOW = 30000; // 计数重置窗口（毫秒）

/** Flag to track if delegated event handlers are already bound */
let eventsDelegated = false;

// ========== Settings ==========

/**
 * Get current SillyTavern context
 * @returns {object}
 */
function getCtx() {
    return SillyTavern.getContext();
}

/**
 * Load plugin settings from extensionSettings
 * @returns {object}
 */
function loadPluginSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    if (!ctx.extensionSettings[SETTINGS_KEY]) {
        ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[SETTINGS_KEY];
    if (settings.autoRestore === undefined) settings.autoRestore = DEFAULT_SETTINGS.autoRestore;
    if (settings.autoRestoreDelay === undefined) settings.autoRestoreDelay = DEFAULT_SETTINGS.autoRestoreDelay;
    return settings;
}

/**
 * Save plugin settings
 */
function savePluginSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) {
        ctx.saveSettingsDebounced();
    }
}

/**
 * Check if plugin is enabled
 * @returns {boolean}
 */
function isPluginEnabled() {
    return loadPluginSettings().enabled !== false;
}

/**
 * Check if auto-restore is enabled
 * @returns {boolean}
 */
function isAutoRestoreEnabled() {
    const s = loadPluginSettings();
    return s.enabled !== false && s.autoRestore !== false;
}

// ========== Metadata Migration ==========

/**
 * 迁移旧版 metadata 结构到当前版本。
 * 旧版（无 version 字段）按 version 0 处理。
 *
 * [Bug #4 修复] 高版本数据（version > METADATA_VERSION）时：
 * - 原样返回副本，不篡改 version 字段
 * - 附加 __futureVersion: true 标记，供上层判断
 * - 确保不破坏向上兼容性：旧版插件不会把高版本数据降级写回
 *
 * @param {object} raw - 从 chatMetadata 读取的原始对象
 * @returns {object|null} - 迁移后的结构（当前版本），或带 __futureVersion 标记的高版本副本
 */
function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    // version 0 → 1：加 version 字段，结构本身不变
    if (!raw.version) {
        return {
            version: METADATA_VERSION,
            prompts: raw.prompts || {},
            promptOrder: raw.promptOrder || null,
            presetName: raw.presetName || null,
            savedAt: raw.savedAt || null,
        };
    }

    // 已是当前版本，直接返回副本
    if (raw.version === METADATA_VERSION) {
        return Object.assign({}, raw);
    }

    // [Bug #4 修复] 高版本数据：原样返回副本，保留原始 version，打标记
    // 绝不将 version 降级写回，避免未来升级时二次迁移导致数据损坏
    if (raw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Metadata version ${raw.version} is newer than supported version ${METADATA_VERSION}. Data will be treated as read-only to prevent corruption.`);
        const copy = Object.assign({}, raw);
        copy.__futureVersion = true; // 标记供上层判断
        return copy;
    }

    // 未知低版本（理论上不应出现），按当前版本处理
    console.warn(LOG_PREFIX, `Unknown metadata version ${raw.version}, treating as current.`);
    return Object.assign({}, raw, { version: METADATA_VERSION });
}

// ========== Prompt State Read/Write ==========

/**
 * Read the current prompt states and order from chatCompletionSettings (API level).
 * Falls back to DOM if API data is unavailable.
 * @returns {{ prompts: Object<string, boolean>, promptOrder: Array } | null}
 */
function readPromptStates() {
    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && Array.isArray(oaiSettings.prompts) && oaiSettings.prompts.length > 0) {
            const prompts = {};
            for (const p of oaiSettings.prompts) {
                if (p.identifier) {
                    prompts[p.identifier] = p.enabled !== false;
                }
            }

            let promptOrder = null;
            if (Array.isArray(oaiSettings.prompt_order)) {
                promptOrder = JSON.parse(JSON.stringify(oaiSettings.prompt_order));
            }

            if (Object.keys(prompts).length > 0) {
                console.debug(LOG_PREFIX, 'Read prompt states from API');
                return { prompts, promptOrder };
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to read from chatCompletionSettings:', e);
    }

    return readPromptStatesFromDOM();
}

/**
 * Fallback: Read prompt states from DOM
 * 多选择器兜底，兼容不同版本 ST 的 DOM 结构
 * @returns {{ prompts: Object<string, boolean>, promptOrder: Array } | null}
 */
function readPromptStatesFromDOM() {
    // 多选择器兜底：兼容不同版本 ST
    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'DOM container not found for fallback read.');
        return null;
    }

    const prompts = {};
    const orderArray = [];

    // 兼容 data-pm-identifier 和未来可能的 data-prompt-id
    $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
        const $row = jQuery(this);
        const identifier = $row.attr('data-pm-identifier') || $row.attr('data-prompt-id');
        if (!identifier) return;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            prompts[identifier] = $checkbox.prop('checked');
        } else {
            const $toggle = $row.find('.prompt_manager_prompt_toggle');
            if ($toggle.length > 0) {
                prompts[identifier] = $toggle.hasClass('enabled') || $toggle.attr('data-enabled') === 'true';
            }
        }

        orderArray.push(identifier);
    });

    if (Object.keys(prompts).length === 0) {
        console.debug(LOG_PREFIX, 'No prompt entries found in DOM.');
        return null;
    }

    console.debug(LOG_PREFIX, 'Read prompt states from DOM fallback');
    return { prompts, promptOrder: orderArray };
}

// ========== Dirty Check ==========

/**
 * 浅比较两个 promptOrder 是否一致，避免 JSON.stringify 的性能开销
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function promptOrderEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i], bi = b[i];
        if (ai === bi) continue;
        // 对象逐字段浅比较
        if (typeof ai !== 'object' || typeof bi !== 'object' || ai === null || bi === null) return false;
        const keysA = Object.keys(ai);
        const keysB = Object.keys(bi);
        if (keysA.length !== keysB.length) return false;
        for (const k of keysA) {
            if (ai[k] !== bi[k]) {
                // order 子数组做逐项比较
                if (k === 'order' && Array.isArray(ai[k]) && Array.isArray(bi[k])) {
                    if (ai[k].length !== bi[k].length) return false;
                    for (let j = 0; j < ai[k].length; j++) {
                        if (ai[k][j] !== bi[k][j]) {
                            if (typeof ai[k][j] !== 'object' || ai[k][j] === null) return false;
                            if (ai[k][j].identifier !== bi[k][j].identifier) return false;
                        }
                    }
                } else {
                    return false;
                }
            }
        }
    }
    return true;
}

/**
 * Dirty check: compare current state with saved state to determine if restore is needed.
 * @param {object} savedState
 * @returns {{ needsPresetSwitch: boolean, needsEntryRestore: boolean, targetPreset: string|null }}
 */
function checkDirtyState(savedState) {
    const result = {
        needsPresetSwitch: false,
        needsEntryRestore: false,
        targetPreset: null,
    };

    if (!savedState || !savedState.prompts) return result;

    if (savedState.presetName) {
        const currentPreset = getCurrentPresetName();
        if (currentPreset && currentPreset !== savedState.presetName) {
            result.needsPresetSwitch = true;
            result.targetPreset = savedState.presetName;
        }
    }

    if (!result.needsPresetSwitch) {
        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
                if (currentStates.prompts[identifier] !== undefined && currentStates.prompts[identifier] !== enabled) {
                    result.needsEntryRestore = true;
                    break;
                }
            }
            if (!result.needsEntryRestore && savedState.promptOrder && currentStates.promptOrder) {
                if (!promptOrderEqual(savedState.promptOrder, currentStates.promptOrder)) {
                    result.needsEntryRestore = true;
                }
            }
        } else {
            result.needsEntryRestore = true;
        }
    } else {
        result.needsEntryRestore = true;
    }

    return result;
}

// ========== Apply States ==========

/**
 * Apply saved prompt states to chatCompletionSettings (API level).
 * Falls back to DOM if API is unavailable.
 * @param {{ prompts: Object<string, boolean>, promptOrder: Array }} savedState
 * @param {string|null} chatIdAtStart - 恢复开始时的 chatId，用于竞态检查
 * @returns {{ skipped: string[], aborted: boolean }}
 */
function applyPromptStates(savedState, chatIdAtStart) {
    const skipped = [];
    const { prompts: savedPrompts, promptOrder: savedOrder } = savedState;

    // 竞态检查：应用前确认 chatId 未变
    if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) {
        console.debug(LOG_PREFIX, 'applyPromptStates aborted: chatId changed during restore.');
        return { skipped, aborted: true };
    }

    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && Array.isArray(oaiSettings.prompts)) {
            const currentIdentifiers = new Set(oaiSettings.prompts.map(p => p.identifier).filter(Boolean));

            for (const [identifier, enabled] of Object.entries(savedPrompts)) {
                if (!currentIdentifiers.has(identifier)) {
                    skipped.push(identifier);
                    continue;
                }
                const prompt = oaiSettings.prompts.find(p => p.identifier === identifier);
                if (prompt) {
                    prompt.enabled = enabled;
                }
            }

            // 智能合并 prompt_order：按 character_id 匹配，只更新 order 数组，不整体覆盖
            if (savedOrder && Array.isArray(savedOrder) && Array.isArray(oaiSettings.prompt_order)) {
                if (savedOrder.length > 0 && typeof savedOrder[0] === 'object') {
                    mergePromptOrder(oaiSettings.prompt_order, savedOrder, skipped);
                } else if (savedOrder.length > 0 && typeof savedOrder[0] === 'string') {
                    applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped);
                }
            }

            if (ctx.saveSettingsDebounced) {
                ctx.saveSettingsDebounced();
            }

            // 竞态检查：保存设置后再次确认 chatId
            if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) {
                console.debug(LOG_PREFIX, 'applyPromptStates: chatId changed after apply, state may be stale.');
                return { skipped, aborted: true };
            }

            console.debug(LOG_PREFIX, 'Applied prompt states via API');
            return { skipped, aborted: false };
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to apply via API, trying DOM fallback:', e);
    }

    applyPromptStatesDOM(savedPrompts, skipped);
    return { skipped, aborted: false };
}

/**
 * 智能合并 prompt_order：按 character_id 找到对应条目，只更新其 order 数组，
 * 保留当前版本可能新增的其他字段（如 preset_id 等）。
 * 不在保存快照中的 character_id 条目保持不变。
 *
 * @param {Array} currentOrder - oaiSettings.prompt_order（当前活跃结构）
 * @param {Array} savedOrder   - 保存的快照（旧版/新版结构均兼容）
 * @param {string[]} skipped   - 跳过标识符列表（输出参数）
 */
function mergePromptOrder(currentOrder, savedOrder, skipped) {
    if (!Array.isArray(currentOrder) || !Array.isArray(savedOrder)) return;

    // 以 character_id 为 key 建立当前结构的 Map
    const currentMap = new Map();
    for (const entry of currentOrder) {
        const key = entry.character_id !== undefined ? String(entry.character_id) : '__default__';
        currentMap.set(key, entry);
    }

    for (const savedEntry of savedOrder) {
        if (!savedEntry || typeof savedEntry !== 'object') continue;
        const key = savedEntry.character_id !== undefined ? String(savedEntry.character_id) : '__default__';
        const currentEntry = currentMap.get(key);

        if (!currentEntry) {
            // 当前结构不存在该 character_id，跳过（可能是旧聊天/新格式不匹配）
            console.debug(LOG_PREFIX, `mergePromptOrder: no matching entry for character_id=${key}, skipping.`);
            continue;
        }

        if (!Array.isArray(savedEntry.order) || !Array.isArray(currentEntry.order)) continue;

        // 只更新 order 数组，其余字段（包括未来可能新增的）保持 currentEntry 原样
        const currentOrderMap = new Map(currentEntry.order.map(item => [item.identifier, item]));
        const newOrder = [];

        for (const savedItem of savedEntry.order) {
            const identifier = typeof savedItem === 'object' ? savedItem.identifier : savedItem;
            if (currentOrderMap.has(identifier)) {
                // 保留当前条目对象（包含 ST 可能新增的字段），只按保存的顺序排列
                newOrder.push(currentOrderMap.get(identifier));
                currentOrderMap.delete(identifier);
            } else {
                // 保存快照里有但当前不存在的 identifier，跳过
                if (identifier) skipped.push(identifier);
            }
        }

        // 当前存在但快照里没有的条目追加到末尾（新增条目不丢失）
        for (const [, item] of currentOrderMap) {
            newOrder.push(item);
        }

        currentEntry.order = newOrder;
    }
}

/**
 * Apply order from a simple identifier list to oai_settings prompt_order
 */
function applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped) {
    if (!oaiSettings.prompt_order || oaiSettings.prompt_order.length === 0) return;

    for (const entry of oaiSettings.prompt_order) {
        if (!entry.order || !Array.isArray(entry.order)) continue;

        const currentOrderMap = new Map(entry.order.map((item) => [item.identifier, item]));
        const newOrder = [];

        for (const identifier of savedOrder) {
            if (currentOrderMap.has(identifier)) {
                newOrder.push(currentOrderMap.get(identifier));
                currentOrderMap.delete(identifier);
            } else {
                if (identifier) skipped.push(identifier);
            }
        }

        for (const [, item] of currentOrderMap) {
            newOrder.push(item);
        }

        entry.order = newOrder;
    }
}

/**
 * DOM fallback for applying prompt states
 */
function applyPromptStatesDOM(savedPrompts, skipped) {
    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.warn(LOG_PREFIX, 'DOM container not found for apply.');
        return;
    }

    const currentIdentifiers = new Set();
    $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
        const id = jQuery(this).attr('data-pm-identifier') || jQuery(this).attr('data-prompt-id');
        if (id) currentIdentifiers.add(id);
    });

    for (const [identifier, enabled] of Object.entries(savedPrompts)) {
        if (!currentIdentifiers.has(identifier)) {
            skipped.push(identifier);
            continue;
        }

        const $row = $container.find(
            `[data-pm-identifier="${identifier}"], [data-prompt-id="${identifier}"]`
        ).first();
        if ($row.length === 0) continue;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            if ($checkbox.prop('checked') !== enabled) {
                $checkbox.prop('checked', enabled).trigger('change');
            }
        }
    }

    console.debug(LOG_PREFIX, 'Applied prompt states via DOM fallback');
}

// ========== Prompt Manager UI Refresh ==========

/**
 * 恢复完成后尝试刷新 Prompt Manager UI，避免 UI 不更新导致用户误判恢复失败。
 * 多策略按优先级尝试，任一成功即止，失败静默。
 */
async function tryRefreshPromptManagerUI() {
    try {
        const ctx = getCtx();

        // Strategy 1: 通过 ctx 上挂载的 PromptManager 实例调用 render
        if (ctx.PromptManager && typeof ctx.PromptManager.render === 'function') {
            ctx.PromptManager.render();
            console.debug(LOG_PREFIX, 'UI refreshed via ctx.PromptManager.render()');
            return;
        }

        // Strategy 2: 触发 ST 内部的 prompt manager 重渲染事件
        const eventTypes = ctx.event_types;
        if (ctx.eventSource && eventTypes) {
            const refreshEvent =
                eventTypes.PROMPT_MANAGER_SETTINGS_RENDERED ||
                eventTypes.OAI_PRESET_CHANGED_AFTER ||
                null;
            if (refreshEvent) {
                ctx.eventSource.emit(refreshEvent);
                console.debug(LOG_PREFIX, `UI refresh event emitted: ${refreshEvent}`);
                return;
            }
        }

        // Strategy 3: 查找并触发预设管理器的更新（兜底 DOM 触发）
        await new Promise(resolve => setTimeout(resolve, 100));
        const $pmContainer = jQuery(
            '#completion_prompt_manager, #prompt_manager_container, [id*="prompt_manager"]'
        ).first();
        if ($pmContainer.length > 0) {
            // 触发 ST 监听的 change 事件来刷新
            $pmContainer.find('select, input').first().trigger('change');
            console.debug(LOG_PREFIX, 'UI refresh triggered via DOM container change event');
        }
    } catch (e) {
        // UI 刷新失败不影响实际数据，静默处理
        console.debug(LOG_PREFIX, 'tryRefreshPromptManagerUI: non-critical error', e);
    }
}

// ========== Preset ==========

/**
 * Get the name of the currently active preset.
 * 主路径：通用 getPresetManager() API（适用所有 API 后端）。
 * DOM fallback：硬编码 #settings_preset_openai / #settings_preset，仅适用 Chat Completion 模式。
 * [Bug #2] 主路径已走通用 API，DOM 仅为兜底，不做动态拼接避免引入新坑。
 * @returns {string|null}
 */
function getCurrentPresetName() {
    try {
        const ctx = getCtx();
        // 主路径：通用 PresetManager API
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm && typeof pm.getSelectedPresetName === 'function') {
            const name = pm.getSelectedPresetName();
            if (name) return name;
        }
        // [Bug #2] DOM fallback：仅适用 Chat Completion 模式的选择器
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            const selectedText = $select.find('option:selected').text();
            if (selectedText) return selectedText.trim();
            if ($select.val()) return $select.val();
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to get current preset name:', e);
    }
    return null;
}

/**
 * Switch to a named preset.
 * [Bug #3 加固] 策略优先级调整：
 *   Strategy 1: PresetManager 原生方法探测（最可靠）
 *   Strategy 2: DOM selector（精确 + trim + 大小写不敏感回退）
 *   Strategy 3: Slash command /preset（最末兜底，黑盒行为）
 * 每个策略切换后都校验 getCurrentPresetName()，防止切错轨道。
 * [Bug #2] DOM 选择器仅适用 Chat Completion 模式，不做动态拼接。
 * @param {string} presetName
 * @returns {Promise<boolean>}
 */
async function switchToPreset(presetName) {
    if (!presetName) return false;

    const currentPreset = getCurrentPresetName();
    if (currentPreset === presetName) {
        console.debug(LOG_PREFIX, `Already on preset "${presetName}", no switch needed.`);
        return true;
    }

    // [Bug #3] Strategy 1: PresetManager 原生方法探测
    // 优先使用 ST 通用 API，避免依赖 DOM 或黑盒斜杠命令
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm) {
            // 探测可能的原生切换方法名（不同 ST 版本方法名可能不同）
            const switchMethod =
                (typeof pm.selectPreset === 'function' && pm.selectPreset) ||
                (typeof pm.changePreset === 'function' && pm.changePreset) ||
                (typeof pm.selectPresetByName === 'function' && pm.selectPresetByName) ||
                null;

            if (switchMethod) {
                await switchMethod.call(pm, presetName);
                await new Promise(resolve => setTimeout(resolve, 300));
                if (getCurrentPresetName() === presetName) {
                    console.log(LOG_PREFIX, `Switched preset to "${presetName}" via PresetManager native method.`);
                    return true;
                }
                // trim + 大小写不敏感校验
                const current = getCurrentPresetName();
                if (current && current.trim().toLowerCase() === presetName.trim().toLowerCase()) {
                    console.log(LOG_PREFIX, `Switched preset to "${presetName}" via PresetManager (case-insensitive match).`);
                    return true;
                }
                console.debug(LOG_PREFIX, `PresetManager native method called but preset name mismatch (got "${current}"), falling through.`);
            }
        }
    } catch (e) {
        console.debug(LOG_PREFIX, 'PresetManager native method approach failed:', e);
    }

    // Strategy 2: DOM selector（精确 + trim + 大小写不敏感回退）
    // [Bug #2] 仅适用 Chat Completion 模式的选择器
    try {
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            let matched = false;
            const targetLower = presetName.trim().toLowerCase();

            // 第一轮：精确匹配 text 或 value
            $select.find('option').each(function () {
                const $opt = jQuery(this);
                if ($opt.text().trim() === presetName || $opt.val() === presetName) {
                    $select.val($opt.val()).trigger('change');
                    matched = true;
                    return false;
                }
            });

            // 第二轮：trim + 大小写不敏感回退
            if (!matched) {
                $select.find('option').each(function () {
                    const $opt = jQuery(this);
                    if ($opt.text().trim().toLowerCase() === targetLower) {
                        $select.val($opt.val()).trigger('change');
                        matched = true;
                        return false;
                    }
                });
            }

            if (matched) {
                console.log(LOG_PREFIX, `Switched preset to "${presetName}" via DOM selector.`);
                return true;
            } else {
                console.warn(LOG_PREFIX, `Preset "${presetName}" not found in selector options. It may have been renamed or deleted.`);
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'DOM selector approach failed:', e);
    }

    // [Bug #3] Strategy 3: Slash command（最末兜底）
    // /preset 在不同 ST 版本/扩展下指向的"预设维度"可能不确定，
    // 因此降为最末兜底，且切换后必须校验 getCurrentPresetName() 确认成功。
    try {
        const ctx = getCtx();
        const escapedName = presetName.replace(/"/g, '\\"');
        if (ctx.executeSlashCommandsWithOptions) {
            await ctx.executeSlashCommandsWithOptions(`/preset "${escapedName}"`);
            await new Promise(resolve => setTimeout(resolve, 300));
            if (getCurrentPresetName() === presetName) return true;
        }
        if (ctx.executeSlashCommands) {
            await ctx.executeSlashCommands(`/preset "${escapedName}"`);
            await new Promise(resolve => setTimeout(resolve, 300));
            if (getCurrentPresetName() === presetName) return true;
        }
    } catch (e) {
        console.warn(LOG_PREFIX, `Slash command approach failed for preset "${presetName}":`, e);
    }

    console.error(LOG_PREFIX, `All strategies failed to switch to preset "${presetName}". It may have been renamed or is unavailable on this device.`);
    return false;
}

// ========== Core: Save / Restore / Delete ==========

/**
 * Save current prompt states to chatMetadata (always shows notification).
 * 保存即覆盖：直接覆盖 presetName + prompts + promptOrder。
 * 保存后设置 justSavedChatId 保护标记，防止自动恢复立刻把预设切回旧值。
 * 状态栏显示「✓ 已保存 HH:MM」作为防误操作软提示。
 *
 * [Bug #4 防降级保护] 如果当前聊天的 metadata 是高版本数据，拒绝覆盖并提示用户升级插件。
 * @returns {boolean}
 */
function saveStatesToMetadata() {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('没有活跃的聊天，无法保存。', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('chatMetadata 不可用，无法保存。', 'Prompt Keeper');
        return false;
    }

    // [Bug #4 防降级保护] 检查现有数据是否为高版本，拒绝覆盖
    const existingRaw = chatMetadata[METADATA_KEY];
    if (existingRaw && typeof existingRaw === 'object' && existingRaw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Refusing to overwrite metadata version ${existingRaw.version} with version ${METADATA_VERSION}. Please update the plugin.`);
        toastr.error(
            `当前聊天的配置数据由更新版本的 Prompt Keeper (v${existingRaw.version}) 创建，当前插件版本无法安全覆盖。请更新插件后再保存。`,
            'Prompt Keeper - 版本不兼容',
            { timeOut: 8000 }
        );
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        toastr.warning('未能读取预设条目状态，请确认预设管理器已加载。', 'Prompt Keeper');
        return false;
    }

    const presetName = getCurrentPresetName();
    const now = Date.now();

    // 构建精简的 metadata 对象，不存 null/undefined 冗余字段
    const stateToSave = {
        version: METADATA_VERSION,
        prompts: states.prompts,
        savedAt: now,
    };
    if (states.promptOrder != null) stateToSave.promptOrder = states.promptOrder;
    if (presetName != null) stateToSave.presetName = presetName;

    chatMetadata[METADATA_KEY] = stateToSave;

    ctx.saveMetadataDebounced();

    // 设置保护标记：本次聊天内自动恢复跳过一次，避免刚保存就被切回旧预设
    justSavedChatId = chatId;

    console.log(LOG_PREFIX, `Saved prompt states for chat: ${chatId}, preset: ${presetName}`);
    updateStatusDisplay(true, now);

    toastr.success(
        `预设条目配置已保存成功！${presetName ? '（预设: ' + presetName + '）' : ''}`,
        'Prompt Keeper',
        { timeOut: 3000 }
    );

    return true;
}

/**
 * Restore prompt states from chatMetadata.
 * 修复竞态：全程记录 chatIdAtStart，每个 await 后检查 chatId 是否变化，变化则立即中止。
 *
 * [Bug #4] 高版本数据走只读路径：可以尝试恢复（数据结构可能兼容），但不做写回操作，
 * 并提示用户升级插件。
 * @param {boolean} silent - If true, suppress success notification
 * @returns {Promise<boolean>}
 */
async function restoreStatesFromMetadata(silent = false) {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    // 记录恢复开始时的 chatId，用于全程竞态检查
    const chatIdAtStart = chatId;

    if (!chatId) {
        if (!silent) toastr.warning('没有活跃的聊天，无法恢复。', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        if (!silent) toastr.warning('chatMetadata 不可用，无法恢复。', 'Prompt Keeper');
        return false;
    }

    // 迁移旧版 metadata 结构
    const rawState = chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);

    if (!savedState || !savedState.prompts) {
        if (!silent) toastr.info('当前聊天没有保存的预设条目配置。', 'Prompt Keeper');
        return false;
    }

    // [Bug #4] 高版本数据提示：可以尝试恢复（尽力兼容），但提醒用户
    const isFutureVersion = savedState.__futureVersion === true;
    if (isFutureVersion) {
        console.warn(LOG_PREFIX, `Restoring from future version data (v${savedState.version}). Results may be incomplete.`);
        if (!silent) {
            toastr.warning(
                `此聊天的配置由更新版本的 Prompt Keeper 创建，恢复可能不完整。建议更新插件。`,
                'Prompt Keeper - 版本提醒',
                { timeOut: 6000 }
            );
        }
    }

    // 脏检查
    const dirty = checkDirtyState(savedState);
    if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
        console.debug(LOG_PREFIX, 'Dirty check passed: current state matches saved state, skipping restore.');
        if (!silent) toastr.info('当前状态已与保存配置一致，无需恢复。', 'Prompt Keeper');
        return true;
    }

    // Step 1: 切换预设
    let presetSwitched = false;
    if (dirty.needsPresetSwitch) {
        console.log(LOG_PREFIX, `Switching preset to "${dirty.targetPreset}"...`);
        presetSwitched = await switchToPreset(dirty.targetPreset);

        // 竞态检查：切换预设后确认 chatId 未变
        if (getCtx().chatId !== chatIdAtStart) {
            console.warn(LOG_PREFIX, `Restore aborted: chatId changed while switching preset (was ${chatIdAtStart}, now ${getCtx().chatId}).`);
            return false;
        }

        if (presetSwitched) {
            await new Promise(resolve => setTimeout(resolve, 600));

            // 竞态检查：等待后再次确认 chatId
            if (getCtx().chatId !== chatIdAtStart) {
                console.warn(LOG_PREFIX, `Restore aborted: chatId changed after preset switch delay.`);
                return false;
            }
        } else {
            const msg = `无法切换到保存的预设 "${dirty.targetPreset}"，该预设可能已改名或在此设备上不存在。`;
            console.warn(LOG_PREFIX, msg);
            if (!silent) toastr.warning(msg + '请手动切换预设后再尝试恢复。', 'Prompt Keeper', { timeOut: 6000 });
            return false;
        }
    }

    // Step 2: 应用条目状态（含竞态检查）
    const { skipped, aborted } = applyPromptStates(savedState, chatIdAtStart);

    if (aborted) {
        console.warn(LOG_PREFIX, `Restore aborted: chatId changed during applyPromptStates.`);
        return false;
    }

    // Step 3: 刷新 Prompt Manager UI
    await tryRefreshPromptManagerUI();

    // 竞态检查：UI 刷新后最终确认
    if (getCtx().chatId !== chatIdAtStart) {
        console.warn(LOG_PREFIX, `Restore completed but chatId changed after UI refresh; result may be stale.`);
        return false;
    }

    if (skipped.length > 0) {
        const msg = `以下条目在当前预设中不存在，已跳过：\n${skipped.join(', ')}`;
        console.warn(LOG_PREFIX, msg);
        if (!silent) toastr.warning(msg, 'Prompt Keeper - 恢复提醒', { timeOut: 8000 });
    }

    const presetInfo = presetSwitched ? `（已切换预设: ${dirty.targetPreset}）` : '';
    if (!silent) {
        toastr.success(`预设条目配置已恢复。${presetInfo}`, 'Prompt Keeper');
    } else {
        toastr.info(`已自动恢复预设条目配置。${presetInfo}`, 'Prompt Keeper', { timeOut: 2000 });
    }

    console.log(LOG_PREFIX, `Restored prompt states for chat: ${chatId}, preset switched: ${presetSwitched}`);
    updateStatusDisplay(true, savedState.savedAt);
    return true;
}

/**
 * Delete saved state from chatMetadata
 * @returns {boolean}
 */
function deleteStateFromMetadata() {
    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('没有活跃的聊天，无法删除。', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('chatMetadata 不可用，无法删除。', 'Prompt Keeper');
        return false;
    }

    if (chatMetadata[METADATA_KEY]) {
        delete chatMetadata[METADATA_KEY];
        ctx.saveMetadataDebounced();
        // 同时清除保护标记
        if (justSavedChatId === chatId) {
            justSavedChatId = null;
        }
        console.log(LOG_PREFIX, `Deleted saved state for chat: ${chatId}`);
        toastr.success('已删除当前聊天的预设条目配置。', 'Prompt Keeper');
        updateStatusDisplay(false);
        return true;
    } else {
        toastr.info('当前聊天没有保存的配置可删除。', 'Prompt Keeper');
        return false;
    }
}

/**
 * Check if current chat has saved state
 * @returns {boolean}
 */
function hasSavedState() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    return !!(chatMetadata && chatMetadata[METADATA_KEY] && chatMetadata[METADATA_KEY].prompts);
}

/**
 * 获取当前聊天的保存时间戳
 * @returns {number|null}
 */
function getSavedAt() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    return chatMetadata && chatMetadata[METADATA_KEY] ? (chatMetadata[METADATA_KEY].savedAt || null) : null;
}

// ========== Event Handlers ==========

/**
 * Handle CHAT_CHANGED event.
 * 仅在 chatId 真正变化时才 schedule 自动恢复，避免同一聊天内触发不必要的恢复。
 */
function onChatChanged() {
    if (!isPluginEnabled()) return;

    const ctx = getCtx();
    const newChatId = ctx.chatId;

    // 聊天确实切换了：清除保护标记，重置 lastHandledChatId
    if (newChatId !== lastHandledChatId) {
        justSavedChatId = null;
        lastHandledChatId = newChatId;
    }

    // 取消上一次 pending 的自动恢复
    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        console.debug(LOG_PREFIX, 'Cancelled pending auto-restore (new chat switch detected).');
    }

    if (!newChatId) {
        requestAnimationFrame(() => updateStatusDisplay(false));
        return;
    }

    const settings = loadPluginSettings();
    const totalDelay = Math.max(800, (settings.autoRestoreDelay || 1500));

    autoRestoreTimer = setTimeout(async () => {
        autoRestoreTimer = null;

        if (!isPluginEnabled()) return;

        const currentCtx = getCtx();
        // 竞态防护：timer 触发时再次确认 chatId 仍是目标
        if (currentCtx.chatId !== newChatId) {
            console.debug(LOG_PREFIX, `Auto-restore cancelled: chatId changed (expected ${newChatId}, got ${currentCtx.chatId}).`);
            return;
        }

        const hasSave = hasSavedState();

        requestAnimationFrame(() => updateStatusDisplay(hasSave, getSavedAt()));

        if (hasSave && isAutoRestoreEnabled()) {
            if (justSavedChatId === newChatId) {
                console.debug(LOG_PREFIX, 'Auto-restore skipped: just saved in this chat, protection active.');
                return;
            }
            console.log(LOG_PREFIX, `Auto-restore triggered for chat: ${newChatId}`);
            await restoreStatesFromMetadata(true);
        }
    }, totalDelay);

    console.debug(LOG_PREFIX, `Chat changed to ${newChatId}, auto-restore scheduled in ${totalDelay}ms.`);
}

// ========== UI ==========

/**
 * 格式化时间戳为 HH:MM 字符串
 * @param {number|null} timestamp
 * @returns {string}
 */
function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
        const d = new Date(timestamp);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } catch (_) {
        return '';
    }
}

/**
 * Update status display (via rAF to avoid layout thrashing on iOS)
 * @param {boolean} hasSave
 * @param {number|null} savedAt - 保存时间戳，显示在状态栏
 */
function updateStatusDisplay(hasSave, savedAt) {
    requestAnimationFrame(() => {
        const $status = jQuery('#prompt-keeper-status');
        if ($status.length === 0) return;

        if (hasSave) {
            const timeStr = formatTime(savedAt || getSavedAt());
            const label = timeStr ? `✓ 已保存 ${timeStr}` : '✓ 已保存';
            $status.text(label).removeClass('pk-not-saved').addClass('pk-saved');
        } else {
            $status.text('⚠ 无保存').removeClass('pk-saved').addClass('pk-not-saved');
        }
    });
}

/**
 * [Bug #1 修复] Start observing the UI bar for removal, re-inject if it disappears.
 *
 * 改进点：
 * - 挂到持久祖先节点（#ai_response_configuration 或 document.body），而非 bar 的直接 parentNode
 * - subtree: true，确保即使中间层被销毁重建也能检测到
 * - 回调改为直接检测 bar 是否还在 DOM 中（而非只看 removedNodes），更健壮
 * - 复用现有节流 + 重注入次数上限
 */
function startUIObserver() {
    if (uiObserver) {
        uiObserver.disconnect();
        uiObserver = null;
    }

    // bar 不存在时不启动 Observer（等 injectUI 成功后再启动）
    if (jQuery('#prompt-keeper-bar').length === 0) return;

    // [Bug #1 核心修复] 选择持久祖先节点，而非 bar 的直接 parentNode
    // 优先使用 #ai_response_configuration（ST 中较稳定的外层容器）
    // 兜底到 document.body（永不销毁）
    const persistentAncestor =
        document.getElementById('ai_response_configuration') ||
        document.getElementById('openai_settings') ||
        document.getElementById('rm_api_block') ||
        document.body;

    uiObserver = new MutationObserver(() => {
        // [Bug #1 核心修复] 不再依赖 removedNodes 匹配特定节点，
        // 而是直接检测 bar 是否还在真实 DOM 中——更简单、更健壮
        // 提前返回：bar 仍在 DOM 中，无需处理
        if (document.getElementById('prompt-keeper-bar')) return;

        // 节流：如果已有待执行的重注入，不重复调度
        if (observerThrottleTimer) return;

        observerThrottleTimer = setTimeout(() => {
            observerThrottleTimer = null;

            // 重注入次数上限检查（防死循环）
            if (observerReinjectionCount >= OBSERVER_REINJECTION_LIMIT) {
                console.warn(LOG_PREFIX, `UI re-injection limit (${OBSERVER_REINJECTION_LIMIT}) reached in ${OBSERVER_REINJECTION_WINDOW / 1000}s. Pausing observer to prevent infinite loop.`);
                return;
            }

            if (!document.getElementById('prompt-keeper-bar')) {
                observerReinjectionCount++;

                // 启动计数重置定时器
                if (!observerReinjectionResetTimer) {
                    observerReinjectionResetTimer = setTimeout(() => {
                        observerReinjectionCount = 0;
                        observerReinjectionResetTimer = null;
                        console.debug(LOG_PREFIX, 'Observer re-injection counter reset.');
                    }, OBSERVER_REINJECTION_WINDOW);
                }

                console.debug(LOG_PREFIX, `UI bar was removed from DOM, re-injecting... (${observerReinjectionCount}/${OBSERVER_REINJECTION_LIMIT})`);
                injectUI();
                // 不需要递归调用 startUIObserver()：Observer 挂在持久祖先上，始终有效
            }
        }, 400);
    });

    uiObserver.observe(persistentAncestor, {
        childList: true,
        subtree: true,  // [Bug #1] 必须为 true，才能检测到深层子树变化
    });

    console.debug(LOG_PREFIX, `UI Observer attached to ${persistentAncestor.id || 'document.body'} with subtree:true`);
}

/**
 * Inject the UI bar into the page.
 * 已存在则直接跳过，避免重复全量 DOM 查找。
 */
function injectUI() {
    if (jQuery('#prompt-keeper-bar').length > 0) return;

    const buttonBarHtml = `
    <div id="prompt-keeper-bar" class="prompt-keeper-bar">
        <div class="prompt-keeper-header">
            <i class="fa-solid fa-bookmark"></i>
            <span>Prompt Keeper</span>
            <span id="prompt-keeper-status" class="pk-not-saved">⚠ 无保存</span>
        </div>
        <div id="prompt-keeper-btn-group" class="prompt-keeper-btn-group">
            <button id="prompt-keeper-save" class="menu_button" title="保存当前预设条目配置">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>保存</span>
            </button>
            <button id="prompt-keeper-restore" class="menu_button" title="恢复保存的预设条目配置">
                <i class="fa-solid fa-rotate-left"></i>
                <span>恢复</span>
            </button>
            <button id="prompt-keeper-delete" class="menu_button" title="删除当前聊天的保存配置">
                <i class="fa-solid fa-trash-can"></i>
                <span>删除</span>
            </button>
        </div>
    </div>`;

    let injected = false;

    // Strategy 1: Insert before Quick Prompt Editor
    if (!injected) {
        const $quickPromptDrawer = jQuery('#quick_prompts_container, #quickPromptEditor, #quick-prompts-inline-drawer').first();
        if ($quickPromptDrawer.length > 0) {
            $quickPromptDrawer.before(buttonBarHtml);
            injected = true;
        }
    }

    // Strategy 2: Find by inline-drawer headers for prompt-related text
    if (!injected) {
        jQuery('.inline-drawer-header').each(function () {
            if (injected) return;
            const text = jQuery(this).text().trim();
            if (text.match(/快速提示词|Quick Prompt|Prompt Editor/i)) {
                const $drawer = jQuery(this).closest('.inline-drawer');
                if ($drawer.length > 0) {
                    $drawer.before(buttonBarHtml);
                    injected = true;
                }
            }
        });
    }

    // Strategy 3: Insert after Top P range block
    if (!injected) {
        const $topP = jQuery('#top_p_block, [data-param="top_p"], #range_block_top_p').first();
        if ($topP.length > 0) {
            const $block = $topP.closest('.range-block, .range_block, .completions_block_inner');
            if ($block.length > 0) {
                $block.after(buttonBarHtml);
            } else {
                $topP.after(buttonBarHtml);
            }
            injected = true;
        }
    }

    // Strategy 4: Insert after the prompt manager list
    if (!injected) {
        const $list = jQuery(
            '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
        ).first();
        if ($list.length > 0) {
            $list.after(buttonBarHtml);
            injected = true;
        }
    }

    // Strategy 5: Insert in AI response configuration area
    if (!injected) {
        const $aiConfig = jQuery('#ai_response_configuration');
        if ($aiConfig.length > 0) {
            $aiConfig.append(buttonBarHtml);
            injected = true;
        }
    }

    // Strategy 6: Insert in openai settings
    if (!injected) {
        const $openai = jQuery('#openai_settings');
        if ($openai.length > 0) {
            $openai.append(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        console.warn(LOG_PREFIX, 'Could not find UI injection point.');
        return;
    }

    // 使用委托事件，只绑定一次
    if (!eventsDelegated) {
        jQuery(document).on('click', '#prompt-keeper-save', () => saveStatesToMetadata());
        jQuery(document).on('click', '#prompt-keeper-restore', () => restoreStatesFromMetadata(false));
        jQuery(document).on('click', '#prompt-keeper-delete', () => deleteStateFromMetadata());
        eventsDelegated = true;
    }

    // 用 rAF 刷新状态，避免注入后立刻触发同步重排
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));

    console.log(LOG_PREFIX, 'UI injected successfully.');
}

/**
 * Try to inject UI with retries.
 * 切换聊天时如果 UI 已存在直接跳过，不做全量 DOM 查找。
 * @param {number} maxRetries
 * @param {number} interval
 */
function tryInjectUI(maxRetries = 15, interval = 1000) {
    // 快速检查：已存在则无需任何重试
    if (jQuery('#prompt-keeper-bar').length > 0) return;

    let attempts = 0;
    const tryInject = () => {
        if (jQuery('#prompt-keeper-bar').length > 0) return;
        injectUI();
        if (jQuery('#prompt-keeper-bar').length === 0 && attempts < maxRetries) {
            attempts++;
            setTimeout(tryInject, interval);
        }
    };
    tryInject();
}

// ========== Settings Panel ==========

/**
 * Load settings panel
 */
function loadSettingsPanel() {
    if (jQuery('#prompt-keeper-settings').length > 0) return;
    jQuery('#extensions_settings2').append(SETTINGS_HTML);

    const settings = loadPluginSettings();
    jQuery('#pk-enabled-toggle').prop('checked', settings.enabled !== false);
    jQuery('#pk-auto-restore-toggle').prop('checked', settings.autoRestore !== false);

    jQuery('#pk-enabled-toggle').on('change', function () {
        const s = loadPluginSettings();
        s.enabled = jQuery(this).prop('checked');
        savePluginSettings();
        if (s.enabled) {
            toastr.success('Prompt Keeper 已启用', 'Prompt Keeper');
        } else {
            toastr.info('Prompt Keeper 已禁用', 'Prompt Keeper');
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    jQuery('#pk-auto-restore-toggle').on('change', function () {
        const s = loadPluginSettings();
        s.autoRestore = jQuery(this).prop('checked');
        savePluginSettings();
        if (s.autoRestore) {
            toastr.success('自动恢复已启用', 'Prompt Keeper');
        } else {
            toastr.info('自动恢复已禁用，切换聊天后需手动恢复', 'Prompt Keeper');
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    console.log(LOG_PREFIX, 'Settings panel loaded.');
}

// ========== Main Init ==========

(function init() {
    const ctx = getCtx();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types;

    eventSource.on(eventTypes.APP_READY, () => {
        loadSettingsPanel();
        tryInjectUI();
        startUIObserver();
        requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
        console.log(LOG_PREFIX, 'Plugin v1.1.0 initialized (APP_READY).');
    });

    // CHAT_CHANGED：切换聊天时更新 UI + 触发自动恢复
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        // UI 快速检查：不存在才注入，避免每次切换都全量遍历 DOM
        if (jQuery('#prompt-keeper-bar').length === 0) {
            tryInjectUI(5, 500);
        }
        onChatChanged();
    });

    console.log(LOG_PREFIX, 'Plugin v1.1.0 loaded, waiting for APP_READY...');
})();
