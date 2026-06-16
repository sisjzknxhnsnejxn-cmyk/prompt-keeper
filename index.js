/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) AND the active preset per chat session.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.0.1
 * @license MIT
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';
const SETTINGS_KEY = 'promptKeeperPluginSettings';
const METADATA_VERSION = 2;
const MAX_SLOTS_PER_CHAT = 5;
const DEFAULT_AUTO_RESTORE_DELAY_MS = 1500;

const DEFAULT_SETTINGS = {
    enabled: true,
    autoRestore: true,
    autoRestoreDelay: 1500,
    slotPickerTheme: 'light',
};

const AUTO_RESTORE_CONTEXT_TIMEOUT_MS = 2500;
const AUTO_RESTORE_CONTEXT_POLL_MS = 100;
const PRESET_SWITCH_TIMEOUT_MS = 1200;
const PRESET_SWITCH_POLL_MS = 50;
const PROMPT_STATE_READY_TIMEOUT_MS = 1200;
const PROMPT_STATE_READY_POLL_MS = 50;

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

let autoRestoreTimer = null;

/** 上一次处理的 chatId，避免同一聊天内重复触发恢复 */
let lastHandledChatId = null;

/** 保存后保护标记，防止自动恢复立刻切回旧预设 */
let justSavedChatId = null;

let uiObserver = null;
let observerThrottleTimer = null;
let observerPaused = false;
let dragListenersBound = false;
let observerRafId = null;

let observerReinjectionCount = 0;
let observerReinjectionResetTimer = null;
const OBSERVER_REINJECTION_LIMIT = 10;
const OBSERVER_REINJECTION_WINDOW = 30000;

let eventsDelegated = false;
let lastButtonActionTime = 0;
const BUTTON_DEBOUNCE_MS = 400;
const BUTTON_EVENT_TYPES = window.PointerEvent
    ? ['pointerup', 'click']
    : ['touchend', 'click'];
const INTERACTION_DEBOUNCE_MS = 450;

// ========== Settings ==========

function getCtx() {
    return SillyTavern.getContext();
}

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
    if (!['dark', 'light'].includes(settings.slotPickerTheme)) settings.slotPickerTheme = DEFAULT_SETTINGS.slotPickerTheme;
    return settings;
}

function savePluginSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) {
        ctx.saveSettingsDebounced();
    }
}

function persistChatMetadata() {
    const ctx = getCtx();
    if (typeof ctx.saveMetadata === 'function') {
        return ctx.saveMetadata();
    }
    if (typeof ctx.saveMetadataDebounced === 'function') {
        return ctx.saveMetadataDebounced();
    }
    return Promise.resolve();
}

function isPluginEnabled() {
    return loadPluginSettings().enabled !== false;
}

function isAutoRestoreEnabled() {
    const s = loadPluginSettings();
    return s.enabled !== false && s.autoRestore !== false;
}

// ========== Metadata Migration ==========

/**
 * 迁移旧版 metadata 结构到当前版本。
 * 高版本数据原样返回并标记 __futureVersion，避免降级写回。
 */
function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    if (raw.version === 2 && raw.slots && typeof raw.slots === 'object') {
        const slots = Object.assign({}, raw.slots);
        return {
            version: METADATA_VERSION,
            defaultSlot: raw.defaultSlot || Object.keys(slots)[0] || null,
            slots,
        };
    }

    if (!raw.version) {
        const slotName = normalizeSlotName(raw.presetName);
        return {
            version: METADATA_VERSION,
            defaultSlot: slotName,
            slots: {
                [slotName]: {
                    prompts: raw.prompts || {},
                    promptOrder: raw.promptOrder || null,
                    presetName: raw.presetName || slotName,
                    savedAt: raw.savedAt || null,
                },
            },
        };
    }

    if (raw.version === 1) {
        const slotName = normalizeSlotName(raw.presetName);
        return {
            version: METADATA_VERSION,
            defaultSlot: slotName,
            slots: {
                [slotName]: {
                    prompts: raw.prompts || {},
                    promptOrder: raw.promptOrder || null,
                    presetName: raw.presetName || slotName,
                    savedAt: raw.savedAt || null,
                },
            },
        };
    }

    if (raw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Metadata version ${raw.version} is newer than supported version ${METADATA_VERSION}. Data will be treated as read-only to prevent corruption.`);
        const copy = Object.assign({}, raw);
        copy.__futureVersion = true;
        return copy;
    }

    console.warn(LOG_PREFIX, `Unknown metadata version ${raw.version}, treating as current.`);
    return Object.assign({}, raw, { version: METADATA_VERSION });
}

function normalizeSlotName(name) {
    return String(name || '').trim() || '未命名预设';
}

function normalizePresetKey(name) {
    return normalizeSlotName(name).toLowerCase();
}

function findSlotName(state, presetName) {
    if (!state || !state.slots || !presetName) return null;

    const normalizedPreset = normalizePresetKey(presetName);
    for (const [slotName, slot] of Object.entries(state.slots)) {
        if (normalizePresetKey(slotName) === normalizedPreset) return slotName;
        if (slot && normalizePresetKey(slot.presetName) === normalizedPreset) return slotName;
    }

    return null;
}

function getSlotEntries(state) {
    if (!state || !state.slots || typeof state.slots !== 'object') return [];
    return Object.entries(state.slots)
        .filter(([, slot]) => slot && typeof slot === 'object' && slot.prompts)
        .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
}

function getDefaultSlotState(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && state.slots[state.defaultSlot]) return state.slots[state.defaultSlot];
    const first = getSlotEntries(state)[0];
    return first ? first[1] : null;
}

function getDefaultSlotName(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && state.slots[state.defaultSlot]) return state.defaultSlot;
    const first = getSlotEntries(state)[0];
    return first ? first[0] : null;
}

function getBestRestoreSlotName(state, requestedSlotName = null) {
    if (!state || !state.slots) return null;

    let targetSlotName = requestedSlotName;
    if (targetSlotName && !state.slots[targetSlotName]) {
        targetSlotName = findSlotName(state, targetSlotName);
    }
    if (targetSlotName) return targetSlotName;

    const currentPresetName = getCurrentPresetName();
    targetSlotName = findSlotName(state, currentPresetName);
    if (targetSlotName) return targetSlotName;

    return getDefaultSlotName(state);
}

function getSavedStateFromCurrentChat() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);
    persistMigratedStateIfNeeded(chatMetadata, rawState, savedState);
    return { chatMetadata, rawState, savedState };
}

async function waitForChatContext(chatId, timeoutMs = AUTO_RESTORE_CONTEXT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const ctx = getCtx();
        if (ctx.chatId === chatId && ctx.chatMetadata) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const stableCtx = getCtx();
            if (stableCtx.chatId === chatId && stableCtx.chatMetadata === ctx.chatMetadata) {
                return true;
            }
        }
        await new Promise(resolve => setTimeout(resolve, AUTO_RESTORE_CONTEXT_POLL_MS));
    }

    return false;
}

function persistMigratedStateIfNeeded(chatMetadata, rawState, migratedState) {
    if (!chatMetadata || !rawState || !migratedState || migratedState.__futureVersion) return;
    if (rawState.version === METADATA_VERSION && rawState.slots) return;
    chatMetadata[METADATA_KEY] = migratedState;
    persistChatMetadata();
}

// ========== Prompt State Read/Write ==========

/**
 * 读取当前 prompt 状态和顺序，优先 API 层，回退 DOM。
 */
function readPromptStates() {
    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && Array.isArray(oaiSettings.prompts) && oaiSettings.prompts.length > 0) {
            const prompts = {};

            const enabledFromOrder = {};
            if (Array.isArray(oaiSettings.prompt_order)) {
                for (const entry of oaiSettings.prompt_order) {
                    if (Array.isArray(entry.order)) {
                        for (const item of entry.order) {
                            if (item.identifier) {
                                enabledFromOrder[item.identifier] = item.enabled !== false;
                            }
                        }
                    }
                }
            }

            for (const p of oaiSettings.prompts) {
                if (p.identifier) {
                    prompts[p.identifier] = (enabledFromOrder[p.identifier] !== undefined)
                        ? enabledFromOrder[p.identifier]
                        : (p.enabled !== false);
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
 * DOM 回退：从 DOM 读取 prompt 状态。
 */
function readPromptStatesFromDOM() {
    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'DOM container not found for fallback read.');
        return null;
    }

    const prompts = {};
    const orderArray = [];

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
 * 比较两个 promptOrder 是否在语义上一致。
 * 只比较 character_id / identifier / enabled，忽略未知字段。
 */
function promptOrderEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;

    // 元素类型不一致（如 DOM 回退的 string[] vs API 的 object[]），无法可靠比较，跳过
    if (a.length > 0 && b.length > 0 && typeof a[0] !== typeof b[0]) return true;

    for (let i = 0; i < a.length; i++) {
        const ai = a[i], bi = b[i];
        if (ai === bi) continue;
        if (typeof ai !== 'object' || typeof bi !== 'object' || ai === null || bi === null) return false;

        if (String(ai.character_id ?? '') !== String(bi.character_id ?? '')) return false;

        if (!Array.isArray(ai.order) || !Array.isArray(bi.order)) {
            if (ai.order !== bi.order) return false;
            continue;
        }
        if (ai.order.length !== bi.order.length) return false;
        for (let j = 0; j < ai.order.length; j++) {
            const oj = ai.order[j], pj = bi.order[j];
            if (oj === pj) continue;
            if (typeof oj !== 'object' || typeof pj !== 'object' || oj === null || pj === null) return false;
            if (oj.identifier !== pj.identifier) return false;
            if (oj.enabled !== pj.enabled) return false;
        }
    }
    return true;
}

/**
 * 脏检查：对比当前状态与保存状态，决定是否需要恢复。
 */
function checkDirtyState(savedState, options = {}) {
    const allowPresetSwitch = options.allowPresetSwitch !== false;
    const result = {
        needsPresetSwitch: false,
        needsEntryRestore: false,
        targetPreset: null,
    };

    if (!savedState || !savedState.prompts) return result;

    if (allowPresetSwitch && savedState.presetName) {
        const currentPreset = getCurrentPresetName();
        if (currentPreset && currentPreset.trim() !== savedState.presetName.trim()) {
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
 * 应用保存的 prompt 状态，优先 API 层，回退 DOM。
 * @param {{ prompts: Object<string, boolean>, promptOrder: Array }} savedState
 * @param {string|null} chatIdAtStart - 竞态检查用
 */
function applyPromptStates(savedState, chatIdAtStart) {
    const skipped = [];
    const { prompts: savedPrompts, promptOrder: savedOrder } = savedState;

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

            if (Array.isArray(oaiSettings.prompt_order)) {
                for (const entry of oaiSettings.prompt_order) {
                    if (Array.isArray(entry.order)) {
                        for (const item of entry.order) {
                            if (item.identifier && savedPrompts[item.identifier] !== undefined) {
                                item.enabled = savedPrompts[item.identifier];
                            }
                        }
                    }
                }
            }

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
 * 智能合并 prompt_order：按 character_id 匹配，只更新 order 数组。
 */
function mergePromptOrder(currentOrder, savedOrder, skipped) {
    if (!Array.isArray(currentOrder) || !Array.isArray(savedOrder)) return;

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
            console.debug(LOG_PREFIX, `mergePromptOrder: no matching entry for character_id=${key}, skipping.`);
            continue;
        }

        if (!Array.isArray(savedEntry.order) || !Array.isArray(currentEntry.order)) continue;

        const currentOrderMap = new Map(currentEntry.order.map(item => [item.identifier, item]));
        const newOrder = [];

        for (const savedItem of savedEntry.order) {
            const identifier = typeof savedItem === 'object' ? savedItem.identifier : savedItem;
            if (currentOrderMap.has(identifier)) {
                const currentItem = currentOrderMap.get(identifier);
                if (typeof savedItem === 'object' && savedItem.enabled !== undefined) {
                    currentItem.enabled = savedItem.enabled;
                }
                newOrder.push(currentItem);
                currentOrderMap.delete(identifier);
            } else {
                if (identifier) skipped.push(identifier);
            }
        }

        for (const [, item] of currentOrderMap) {
            newOrder.push(item);
        }

        currentEntry.order = newOrder;
    }
}

/**
 * 从字符串 identifier 列表应用顺序。
 * 字符串格式不含 enabled，上层已在调用前同步 enabled 到 prompt_order。
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

async function tryRefreshPromptManagerUI() {
    try {
        const ctx = getCtx();

        const pmInstance = ctx.PromptManager || ctx.promptManager || ctx.promptManagerInstance || null;
        if (pmInstance && typeof pmInstance.render === 'function') {
            pmInstance.render();
            console.debug(LOG_PREFIX, 'UI refreshed via PromptManager.render()');
            return;
        }
        if (pmInstance && typeof pmInstance.renderPromptManager === 'function') {
            pmInstance.renderPromptManager();
            console.debug(LOG_PREFIX, 'UI refreshed via PromptManager.renderPromptManager()');
            return;
        }

        const eventTypes = ctx.event_types;
        if (ctx.eventSource && eventTypes) {
            const refreshEvent =
                eventTypes.OAI_PRESET_CHANGED_AFTER ||
                eventTypes.PROMPT_MANAGER_SETTINGS_RENDERED ||
                null;
            if (refreshEvent) {
                ctx.eventSource.emit(refreshEvent);
                console.debug(LOG_PREFIX, `UI refresh event emitted: ${refreshEvent}`);
                await new Promise(resolve => setTimeout(resolve, 200));
                return;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        const oaiSettings = ctx.chatCompletionSettings;
        if (oaiSettings && Array.isArray(oaiSettings.prompt_order)) {
            const enabledMap = {};
            for (const entry of oaiSettings.prompt_order) {
                if (Array.isArray(entry.order)) {
                    for (const item of entry.order) {
                        if (item.identifier) {
                            enabledMap[item.identifier] = item.enabled !== false;
                        }
                    }
                }
            }

            const $container = jQuery(
                '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
            ).first();
            if ($container.length > 0) {
                let synced = 0;
                $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
                    const $row = jQuery(this);
                    const identifier = $row.attr('data-pm-identifier') || $row.attr('data-prompt-id');
                    if (!identifier || enabledMap[identifier] === undefined) return;

                    const $checkbox = $row.find('input[type="checkbox"]').first();
                    if ($checkbox.length > 0 && $checkbox.prop('checked') !== enabledMap[identifier]) {
                        $checkbox.prop('checked', enabledMap[identifier]).trigger('change');
                        synced++;
                    }
                });
                if (synced > 0) {
                    console.debug(LOG_PREFIX, `UI refresh: synced ${synced} checkbox(es) via DOM fallback`);
                    return;
                }
            }
        }

        const $pmContainer = jQuery(
            '#completion_prompt_manager, #prompt_manager_container, [id*="prompt_manager"]'
        ).first();
        if ($pmContainer.length > 0) {
            $pmContainer.find('select, input').first().trigger('change');
            console.debug(LOG_PREFIX, 'UI refresh triggered via DOM container change event');
        }
    } catch (e) {
        console.debug(LOG_PREFIX, 'tryRefreshPromptManagerUI: non-critical error', e);
    }
}

// ========== Preset ==========

/**
 * 获取当前活跃预设名称。优先通用 PresetManager API，回退 DOM。
 */
function getCurrentPresetName() {
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm && typeof pm.getSelectedPresetName === 'function') {
            const name = pm.getSelectedPresetName();
            if (name) return name;
        }
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

function isPresetNameMatch(currentPreset, targetPreset) {
    return Boolean(currentPreset && targetPreset && currentPreset.trim().toLowerCase() === targetPreset.trim().toLowerCase());
}

async function waitForPresetSwitch(presetName, timeoutMs = PRESET_SWITCH_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (isPresetNameMatch(getCurrentPresetName(), presetName)) return true;
        await new Promise(resolve => setTimeout(resolve, PRESET_SWITCH_POLL_MS));
    }
    return isPresetNameMatch(getCurrentPresetName(), presetName);
}

async function waitForPromptStateReady(savedState, chatIdAtStart, timeoutMs = PROMPT_STATE_READY_TIMEOUT_MS) {
    const savedPrompts = savedState && savedState.prompts ? savedState.prompts : {};
    const savedIdentifiers = new Set(Object.keys(savedPrompts));
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) return false;

        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            const currentIdentifiers = Object.keys(currentStates.prompts);
            if (currentIdentifiers.some(identifier => savedIdentifiers.has(identifier))) {
                return true;
            }
        }

        await new Promise(resolve => setTimeout(resolve, PROMPT_STATE_READY_POLL_MS));
    }

    return true;
}

/**
 * 切换到指定预设。依次尝试 PresetManager API → DOM selector → Slash command。
 */
async function switchToPreset(presetName) {
    if (!presetName) return false;

    const currentPreset = getCurrentPresetName();
    if (currentPreset === presetName) {
        console.debug(LOG_PREFIX, `Already on preset "${presetName}", no switch needed.`);
        return true;
    }

    // Strategy 1: PresetManager 原生方法
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm) {
            const methodCandidates = [
                typeof pm.selectPresetByName === 'function' ? pm.selectPresetByName : null,
                typeof pm.selectPreset === 'function' ? pm.selectPreset : null,
                typeof pm.changePreset === 'function' ? pm.changePreset : null,
            ].filter(Boolean);

            for (const method of methodCandidates) {
                try {
                    await method.call(pm, presetName);
                    await waitForPresetSwitch(presetName);
                    const current = getCurrentPresetName();
                    if (isPresetNameMatch(current, presetName)) {
                        console.log(LOG_PREFIX, `Switched preset to "${presetName}" via PresetManager native method.`);
                        return true;
                    }
                    console.debug(LOG_PREFIX, `PresetManager method ${method.name || '(anonymous)'} called but preset name mismatch (got "${current}"), trying next.`);
                } catch (methodErr) {
                    console.debug(LOG_PREFIX, `PresetManager method ${method.name || '(anonymous)'} threw:`, methodErr);
                }
            }
        }
    } catch (e) {
        console.debug(LOG_PREFIX, 'PresetManager native method approach failed:', e);
    }

    // Strategy 2: DOM selector（精确 + 大小写不敏感回退）
    try {
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            let matched = false;
            const targetLower = presetName.trim().toLowerCase();

            $select.find('option').each(function () {
                const $opt = jQuery(this);
                if ($opt.text().trim() === presetName || $opt.val() === presetName) {
                    $select.val($opt.val()).trigger('change');
                    matched = true;
                    return false;
                }
            });

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
                await waitForPresetSwitch(presetName);
                console.log(LOG_PREFIX, `Switched preset to "${presetName}" via DOM selector.`);
                return true;
            } else {
                console.warn(LOG_PREFIX, `Preset "${presetName}" not found in selector options. It may have been renamed or deleted.`);
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'DOM selector approach failed:', e);
    }

    // Strategy 3: Slash command（最末兜底，切换后校验）
    try {
        const ctx = getCtx();
        const escapedName = presetName.replace(/"/g, '\\"');
        if (ctx.executeSlashCommandsWithOptions) {
            await ctx.executeSlashCommandsWithOptions(`/preset "${escapedName}"`);
            if (await waitForPresetSwitch(presetName)) return true;
        }
        if (ctx.executeSlashCommands) {
            await ctx.executeSlashCommands(`/preset "${escapedName}"`);
            if (await waitForPresetSwitch(presetName)) return true;
        }
    } catch (e) {
        console.warn(LOG_PREFIX, `Slash command approach failed for preset "${presetName}":`, e);
    }

    console.error(LOG_PREFIX, `All strategies failed to switch to preset "${presetName}". It may have been renamed or is unavailable on this device.`);
    return false;
}

// ========== Core: Save / Restore / Delete ==========

function saveStatesToMetadata() {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    const existingRaw = chatMetadata[METADATA_KEY];
    if (existingRaw && typeof existingRaw === 'object' && existingRaw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Refusing to overwrite metadata version ${existingRaw.version} with version ${METADATA_VERSION}. Please update the plugin.`);
        toastr.error(
            `请更新插件后保存`,
            '版本不兼容',
            { timeOut: 8000 }
        );
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        toastr.warning('读取状态失败', 'Prompt Keeper');
        return false;
    }

    const presetName = normalizeSlotName(getCurrentPresetName());
    const now = Date.now();
    const migratedState = migrateState(existingRaw) || { version: METADATA_VERSION, defaultSlot: null, slots: {} };
    const slotEntries = getSlotEntries(migratedState);

    if (!migratedState.slots[presetName] && slotEntries.length >= MAX_SLOTS_PER_CHAT) {
        toastr.warning(`最多保存 ${MAX_SLOTS_PER_CHAT} 个槽位`, 'Prompt Keeper');
        return false;
    }

    const stateToSave = {
        prompts: states.prompts,
        savedAt: now,
        presetName,
    };
    if (states.promptOrder != null) stateToSave.promptOrder = states.promptOrder;

    migratedState.version = METADATA_VERSION;
    migratedState.slots[presetName] = stateToSave;
    migratedState.defaultSlot = presetName;

    chatMetadata[METADATA_KEY] = migratedState;

    persistChatMetadata();

    justSavedChatId = chatId;

    console.log(LOG_PREFIX, `Saved prompt states for chat: ${chatId}, preset: ${presetName}`);
    updateStatusDisplay(true, now);

    toastr.success(
        '已保存',
        'Prompt Keeper',
        { timeOut: 3000 }
    );

    return true;
}

async function restoreStatesFromMetadata(silent = false, slotName = null, options = {}) {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;
    const chatIdAtStart = chatId;
    const isAutoRestore = options.autoRestore === true;

    if (!chatId) {
        if (!silent) toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    let chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        if (!silent) toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    if (isAutoRestore) {
        const contextReady = await waitForChatContext(chatIdAtStart);
        if (!contextReady || getCtx().chatId !== chatIdAtStart) {
            console.warn(LOG_PREFIX, `Auto-restore aborted: chat context did not stabilize for chat ${chatIdAtStart}.`);
            return false;
        }
    }

    const savedContext = getSavedStateFromCurrentChat();
    chatMetadata = savedContext.chatMetadata;
    const savedState = savedContext.savedState;

    const slotEntries = getSlotEntries(savedState);
    if (!savedState || slotEntries.length === 0) {
        if (!silent) toastr.info('暂无保存配置', 'Prompt Keeper');
        return false;
    }

    const allowPresetSwitch = options.allowPresetSwitch !== undefined ? options.allowPresetSwitch : true;
    const targetSlotName = getBestRestoreSlotName(savedState, slotName);

    const targetSlot = targetSlotName && savedState.slots ? savedState.slots[targetSlotName] : null;
    if (!targetSlot || !targetSlot.prompts) {
        if (!silent) toastr.warning('槽位不可用', 'Prompt Keeper');
        return false;
    }

    if (isAutoRestore) {
        toastr.info(
            '正在恢复',
            'Prompt Keeper',
            { timeOut: 1800 }
        );
    }

    const isFutureVersion = savedState.__futureVersion === true;
    if (isFutureVersion) {
        console.warn(LOG_PREFIX, `Restoring from future version data (v${savedState.version}). Results may be incomplete.`);
        if (!silent) {
            toastr.warning(
                `建议更新插件`,
                '版本提醒',
                { timeOut: 6000 }
            );
        }
    }

    const dirty = checkDirtyState(targetSlot, { allowPresetSwitch });
    if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
        console.debug(LOG_PREFIX, 'Dirty check passed: current state matches saved state, skipping restore.');
        if (!silent) toastr.info('无需恢复', 'Prompt Keeper');
        if (isAutoRestore) {
            toastr.info('无需恢复', 'Prompt Keeper', { timeOut: 1800 });
        }
        return true;
    }

    let presetSwitched = false;
    if (dirty.needsPresetSwitch) {
        console.log(LOG_PREFIX, `Switching preset to "${dirty.targetPreset}"...`);
        presetSwitched = await switchToPreset(dirty.targetPreset);

        if (getCtx().chatId !== chatIdAtStart) {
            console.warn(LOG_PREFIX, `Restore aborted: chatId changed while switching preset (was ${chatIdAtStart}, now ${getCtx().chatId}).`);
            return false;
        }

        if (presetSwitched) {
            const promptStateReady = await waitForPromptStateReady(targetSlot, chatIdAtStart);

            if (!promptStateReady || getCtx().chatId !== chatIdAtStart) {
                console.warn(LOG_PREFIX, `Restore aborted: chatId changed or prompt state not ready after preset switch.`);
                return false;
            }
        } else {
            const msg = `无法切换到保存的预设 "${dirty.targetPreset}"，该预设可能已改名或在此设备上不存在。`;
            console.warn(LOG_PREFIX, msg);
            if (!silent || isAutoRestore) toastr.warning('切换预设失败', 'Prompt Keeper', { timeOut: 6000 });
            return false;
        }
    }

    const { skipped, aborted } = applyPromptStates(targetSlot, chatIdAtStart);

    if (aborted) {
        console.warn(LOG_PREFIX, `Restore aborted: chatId changed during applyPromptStates.`);
        return false;
    }

    await tryRefreshPromptManagerUI();

    if (getCtx().chatId !== chatIdAtStart) {
        console.warn(LOG_PREFIX, `Restore completed but chatId changed after UI refresh; result may be stale.`);
        return false;
    }

    if (skipped.length > 0) {
        const msg = `已跳过缺失条目`;
        console.warn(LOG_PREFIX, msg);
        if (!silent) toastr.warning(msg, '恢复提醒', { timeOut: 8000 });
    }

    const presetInfo = presetSwitched ? '，已切预设' : '';
    if (!silent) {
        toastr.success(`已恢复${presetInfo}`, 'Prompt Keeper');
    } else {
        toastr.success(`已自动恢复${presetInfo}`, 'Prompt Keeper', { timeOut: 2500 });
    }

    console.log(LOG_PREFIX, `Restored prompt states for chat: ${chatId}, preset switched: ${presetSwitched}`);
    updateStatusDisplay(true, targetSlot.savedAt);
    return true;
}

function deleteStateFromMetadata() {
    showSlotPicker('delete');
}

function deleteSlotFromMetadata(slotName) {
    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    const savedState = migrateState(chatMetadata[METADATA_KEY]);
    if (savedState && savedState.slots && savedState.slots[slotName]) {
        delete savedState.slots[slotName];
        const remaining = getSlotEntries(savedState);
        if (savedState.defaultSlot === slotName) {
            savedState.defaultSlot = remaining[0] ? remaining[0][0] : null;
        }
        if (remaining.length === 0) {
            delete chatMetadata[METADATA_KEY];
        } else {
            chatMetadata[METADATA_KEY] = savedState;
        }
        persistChatMetadata();
        if (justSavedChatId === chatId) {
            justSavedChatId = null;
        }
        console.log(LOG_PREFIX, `Deleted saved slot for chat: ${chatId}, slot: ${slotName}`);
        toastr.success('已删除', 'Prompt Keeper');
        updateStatusDisplay(remaining.length > 0, getSavedAt());
        return true;
    } else {
        toastr.info('无可删槽位', 'Prompt Keeper');
        return false;
    }
}

function hasSavedState() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    return getSlotEntries(migrateState(chatMetadata && chatMetadata[METADATA_KEY])).length > 0;
}

function getSavedAt() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const savedState = migrateState(chatMetadata && chatMetadata[METADATA_KEY]);
    const currentSlotName = findSlotName(savedState, getCurrentPresetName());
    const currentSlot = currentSlotName && savedState && savedState.slots ? savedState.slots[currentSlotName] : null;
    const defaultSlot = currentSlot || getDefaultSlotState(savedState);
    return defaultSlot ? (defaultSlot.savedAt || null) : null;
}

// ========== Event Handlers ==========

function getAutoRestoreDelay() {
    const settings = loadPluginSettings();
    const baseDelay = Math.max(800, settings.autoRestoreDelay || DEFAULT_AUTO_RESTORE_DELAY_MS);
    const ctx = getCtx();
    const mobile = typeof ctx.isMobile === 'function' ? ctx.isMobile() : Boolean(ctx.isMobile);
    return mobile ? Math.max(baseDelay, 2200) : baseDelay;
}

async function scheduleRestoreForCurrentChat(source = 'chat_changed') {
    if (!isPluginEnabled()) return;

    const ctx = getCtx();
    const newChatId = ctx.chatId;

    if (newChatId !== lastHandledChatId) {
        justSavedChatId = null;
        lastHandledChatId = newChatId;
    }

    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        console.debug(LOG_PREFIX, `Cancelled pending auto-restore (${source}).`);
    }

    if (!newChatId) {
        requestAnimationFrame(() => updateStatusDisplay(false));
        return;
    }

    const totalDelay = getAutoRestoreDelay();

    autoRestoreTimer = setTimeout(async () => {
        autoRestoreTimer = null;

        if (!isPluginEnabled()) return;

        const currentCtx = getCtx();
        if (currentCtx.chatId !== newChatId) {
            console.debug(LOG_PREFIX, `Auto-restore cancelled: chatId changed (expected ${newChatId}, got ${currentCtx.chatId}).`);
            return;
        }

        const contextReady = await waitForChatContext(newChatId);
        if (!contextReady || getCtx().chatId !== newChatId) {
            console.warn(LOG_PREFIX, `Auto-restore cancelled: chat context not ready for ${newChatId}.`);
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
            await restoreStatesFromMetadata(true, null, { autoRestore: true });
        }
    }, totalDelay);

    console.debug(LOG_PREFIX, `Auto-restore scheduled for ${newChatId} in ${totalDelay}ms (${source}).`);
}

function onChatChanged() {
    if (!isPluginEnabled()) return;
    scheduleRestoreForCurrentChat('chat_changed');
}

function onChatLoaded() {
    if (!isPluginEnabled()) return;
    scheduleRestoreForCurrentChat('chat_loaded');
}

function onPresetChanged() {
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
}

function onMainApiChanged() {
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
}

// ========== UI ==========

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

function formatSlotTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
        return new Date(timestamp).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (_) {
        return '未知时间';
    }
}

function closeSlotPicker() {
    jQuery('#prompt-keeper-modal').remove();
}

function shouldHandleInteraction(element) {
    if (!element) return false;
    const now = Date.now();
    const lastHandled = Number(element.dataset.pkLastHandled || 0);
    if (now - lastHandled < INTERACTION_DEBOUNCE_MS) return false;
    element.dataset.pkLastHandled = String(now);
    return true;
}

function toggleSlotPickerTheme() {
    const $modal = jQuery('#prompt-keeper-modal');
    if ($modal.length === 0) return;
    const isLight = $modal.hasClass('pk-modal-light');
    const nextTheme = isLight ? 'dark' : 'light';
    applySlotPickerTheme($modal, nextTheme);

    const settings = loadPluginSettings();
    settings.slotPickerTheme = nextTheme;
    savePluginSettings();
}

function getSlotPickerThemeLabel(theme) {
    return theme === 'light' ? '☀ 日间' : '🌙 夜间';
}

function applySlotPickerTheme($modal, theme) {
    $modal
        .toggleClass('pk-modal-light', theme === 'light')
        .toggleClass('pk-modal-dark', theme === 'dark');
    $modal.find('.pk-modal-theme').text(getSlotPickerThemeLabel(theme));
}

function animatePressedButton($btn) {
    if (!$btn || !$btn.length) return;
    $btn.removeClass('pk-btn-active');
    void $btn[0].offsetWidth;
    $btn.addClass('pk-btn-active');
    setTimeout(() => $btn.removeClass('pk-btn-active'), 220);
}

function showSlotPicker(mode) {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);
    persistMigratedStateIfNeeded(chatMetadata, rawState, savedState);
    const slotEntries = getSlotEntries(savedState);

    if (slotEntries.length === 0) {
        toastr.info('暂无保存槽位', 'Prompt Keeper');
        return;
    }

    closeSlotPicker();

    const isDelete = mode === 'delete';
    const title = isDelete ? '删除槽位' : '恢复槽位';
    const settings = loadPluginSettings();
    const theme = settings.slotPickerTheme === 'dark' ? 'dark' : 'light';
    const $modal = jQuery(`
        <div id="prompt-keeper-modal" class="pk-modal-overlay pk-modal-${theme}">
            <div class="pk-modal-card" role="dialog" aria-modal="true" aria-label="${title}">
                <div class="pk-modal-header">
                    <strong>${title}</strong>
                    <button type="button" class="pk-modal-theme" title="切换主题">${getSlotPickerThemeLabel(theme)}</button>
                </div>
                <div class="pk-modal-list"></div>
                <button type="button" class="pk-modal-cancel">取消</button>
            </div>
        </div>
    `);

    const $list = $modal.find('.pk-modal-list');
    for (const [name, slot] of slotEntries) {
        const isDefault = savedState.defaultSlot === name;
        const $item = jQuery(`
            <button type="button" class="pk-slot-item ${isDelete ? 'pk-slot-delete' : ''}">
                <span class="pk-slot-main">
                    <span class="pk-slot-name"></span>
                    ${isDefault ? '<span class="pk-slot-default">默认</span>' : ''}
                </span>
                <span class="pk-slot-time"></span>
            </button>
        `);
        $item.find('.pk-slot-name').text(name);
        $item.find('.pk-slot-time').text(formatSlotTime(slot.savedAt));
        const onSlotPress = async function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (!shouldHandleInteraction($item[0]) || $item.prop('disabled')) return;

            animatePressedButton($item);
            $item.addClass('pk-slot-selected pk-slot-working').prop('disabled', true);
            $list.find('.pk-slot-item').not($item).prop('disabled', true).addClass('pk-slot-disabled');

            if (isDelete) {
                const confirmed = window.confirm('删除此槽位？');
                if (!confirmed) {
                    $item.removeClass('pk-slot-selected pk-slot-working').prop('disabled', false);
                    $list.find('.pk-slot-item').not($item).prop('disabled', false).removeClass('pk-slot-disabled');
                    return;
                }
                deleteSlotFromMetadata(name);
            } else {
                $item.find('.pk-slot-time').text('恢复中…');
                await restoreStatesFromMetadata(false, name);
            }
            closeSlotPicker();
        };
        for (const eventType of BUTTON_EVENT_TYPES) {
            $item[0].addEventListener(eventType, onSlotPress, { passive: false });
        }
        $list.append($item);
    }

    const themeButton = $modal.find('.pk-modal-theme')[0];
    const cancelButton = $modal.find('.pk-modal-cancel')[0];

    const onThemePress = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!shouldHandleInteraction(themeButton)) return;
        animatePressedButton(jQuery(themeButton));
        toggleSlotPickerTheme();
    };
    const onCancelPress = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!shouldHandleInteraction(cancelButton)) return;
        animatePressedButton(jQuery(cancelButton));
        closeSlotPicker();
    };

    for (const eventType of BUTTON_EVENT_TYPES) {
        themeButton.addEventListener(eventType, onThemePress, { passive: false });
        cancelButton.addEventListener(eventType, onCancelPress, { passive: false });
    }

    $modal.on('click.pk pointerup.pk touchend.pk', function (e) {
        if (e.target === this) closeSlotPicker();
    });

    jQuery(document.body).append($modal);
    console.debug(LOG_PREFIX, `Slot picker opened in ${mode} mode with ${slotEntries.length} slot(s).`);
}

function handlePromptKeeperButtonAction(selector, $btn) {
    const actions = {
        '#prompt-keeper-save': () => saveStatesToMetadata(),
        '#prompt-keeper-restore': () => showSlotPicker('restore'),
        '#prompt-keeper-delete': () => deleteStateFromMetadata(),
    };

    const action = actions[selector];
    if (!action) return;
    executeButtonAction(action, $btn);
}

function getPromptKeeperButtonFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const target of path) {
        if (target && target.id && ['prompt-keeper-save', 'prompt-keeper-restore', 'prompt-keeper-delete'].includes(target.id)) {
            return target;
        }
    }
    return e.target && e.target.closest
        ? e.target.closest('#prompt-keeper-save, #prompt-keeper-restore, #prompt-keeper-delete')
        : null;
}

function onPromptKeeperButtonPress(e) {
    const button = getPromptKeeperButtonFromEvent(e);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    handlePromptKeeperButtonAction(`#${button.id}`, jQuery(button));
}

function pauseUIObserver() {
    observerPaused = true;
    console.debug(LOG_PREFIX, 'UI Observer paused (drag in progress).');
}

function resumeUIObserver() {
    observerPaused = false;
    console.debug(LOG_PREFIX, 'UI Observer resumed (drag ended).');
    if (!document.getElementById('prompt-keeper-bar')) {
        console.debug(LOG_PREFIX, 'Bar missing after drag, re-injecting.');
        injectUI();
    }
}

function bindDragPauseListeners() {
    if (dragListenersBound) return;
    dragListenersBound = true;

    jQuery(document).on('mousedown touchstart', '[data-pm-identifier] .drag-handle, [data-pm-identifier].ui-sortable-handle, .prompt_manager_prompt .drag-handle, .prompt-manager-detach-action-menu', function () {
        pauseUIObserver();
    });

    jQuery(document).on('mouseup touchend', function () {
        if (observerPaused) {
            setTimeout(resumeUIObserver, 300);
        }
    });

    jQuery(document).on('sortstart', function () {
        pauseUIObserver();
    });
    jQuery(document).on('sortstop sortupdate', function () {
        setTimeout(resumeUIObserver, 300);
    });

    console.debug(LOG_PREFIX, 'Drag pause/resume listeners bound.');
}

function startUIObserver() {
    if (uiObserver) {
        uiObserver.disconnect();
        uiObserver = null;
    }

    if (jQuery('#prompt-keeper-bar').length === 0) return;

    bindDragPauseListeners();

    const barElement = document.getElementById('prompt-keeper-bar');
    const barParent = barElement ? barElement.parentNode : null;

    // 优先监听 bar 的直接父节点（范围最小），否则退回外层持久容器
    let observeTarget = null;
    let useSubtree = false;

    if (barParent && barParent !== document.body) {
        observeTarget = barParent;
        useSubtree = false;
    } else {
        observeTarget =
            document.getElementById('ai_response_configuration') ||
            document.getElementById('openai_settings') ||
            document.getElementById('rm_api_block') ||
            document.body;
        useSubtree = true;
    }

    uiObserver = new MutationObserver(() => {
        if (observerPaused) return;
        if (observerRafId) return;

        observerRafId = requestAnimationFrame(() => {
            observerRafId = null;
            if (observerPaused) return;
            if (document.getElementById('prompt-keeper-bar')) return;
            if (observerThrottleTimer) return;

            observerThrottleTimer = setTimeout(() => {
                observerThrottleTimer = null;

                if (observerReinjectionCount >= OBSERVER_REINJECTION_LIMIT) {
                    console.warn(LOG_PREFIX, `UI re-injection limit (${OBSERVER_REINJECTION_LIMIT}) reached in ${OBSERVER_REINJECTION_WINDOW / 1000}s. Pausing observer to prevent infinite loop.`);
                    return;
                }

                if (!document.getElementById('prompt-keeper-bar')) {
                    observerReinjectionCount++;

                    if (!observerReinjectionResetTimer) {
                        observerReinjectionResetTimer = setTimeout(() => {
                            observerReinjectionCount = 0;
                            observerReinjectionResetTimer = null;
                            console.debug(LOG_PREFIX, 'Observer re-injection counter reset.');
                            if (!document.getElementById('prompt-keeper-bar')) {
                                console.debug(LOG_PREFIX, 'Bar still missing after counter reset, attempting re-injection.');
                                injectUI();
                            }
                        }, OBSERVER_REINJECTION_WINDOW);
                    }

                    console.debug(LOG_PREFIX, `UI bar was removed from DOM, re-injecting... (${observerReinjectionCount}/${OBSERVER_REINJECTION_LIMIT})`);
                    injectUI();
                }
            }, 400);
        });
    });

    uiObserver.observe(observeTarget, {
        childList: true,
        subtree: useSubtree,
    });

    console.debug(LOG_PREFIX, `UI Observer attached to ${observeTarget.id || observeTarget.tagName} with subtree:${useSubtree}`);
}

/**
 * 按钮动作执行器：防重复触发（iOS 上 click+touchend 可能双触发）
 */
function executeButtonAction(action, $btn) {
    const now = Date.now();
    if (now - lastButtonActionTime < BUTTON_DEBOUNCE_MS) {
        console.debug(LOG_PREFIX, 'Button action debounced (too fast).');
        return;
    }
    lastButtonActionTime = now;

    // 视觉反馈：按钮短暂高亮
    animatePressedButton($btn);

    action();
}

/**
 * 直接绑定按钮事件（非事件委托）。
 * 同时绑定 click 和 touchend，iOS Safari 上 touchend 更可靠。
 * 防重复触发通过 BUTTON_DEBOUNCE_MS 时间窗口控制。
 */
function bindButtonEvents() {
    const selectors = ['#prompt-keeper-save', '#prompt-keeper-restore', '#prompt-keeper-delete'];

    for (const selector of selectors) {
        const $btn = jQuery(selector);
        if ($btn.length === 0) continue;
        const button = $btn[0];

        // 移除可能的旧绑定，防止重复
        $btn.off('click.pk touchend.pk pointerup.pk');
        for (const eventType of BUTTON_EVENT_TYPES) {
            button.removeEventListener(eventType, onPromptKeeperButtonPress, true);
            button.addEventListener(eventType, onPromptKeeperButtonPress, { capture: true, passive: false });
        }

        $btn.on('click.pk', function (e) {
            e.preventDefault();
            e.stopPropagation();
            handlePromptKeeperButtonAction(selector, jQuery(this));
        });

        $btn.on('touchend.pk', function (e) {
            e.preventDefault();
            e.stopPropagation();
            handlePromptKeeperButtonAction(selector, jQuery(this));
        });

        $btn.on('pointerup.pk', function (e) {
            e.preventDefault();
            e.stopPropagation();
            handlePromptKeeperButtonAction(selector, jQuery(this));
        });
    }

    if (!eventsDelegated) {
        eventsDelegated = true;
        for (const eventType of BUTTON_EVENT_TYPES) {
            document.addEventListener(eventType, onPromptKeeperButtonPress, { capture: true, passive: false });
        }
        jQuery(document).on('click.pk touchend.pk pointerup.pk', '#prompt-keeper-save, #prompt-keeper-restore, #prompt-keeper-delete', function (e) {
            e.preventDefault();
            e.stopPropagation();
            handlePromptKeeperButtonAction(`#${this.id}`, jQuery(this));
        });
    }

    console.debug(LOG_PREFIX, 'Button events directly bound.');
}

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
            <button type="button" id="prompt-keeper-save" class="menu_button" title="保存当前预设条目配置">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>保存</span>
            </button>
            <button type="button" id="prompt-keeper-restore" class="menu_button" title="恢复保存的预设条目配置">
                <i class="fa-solid fa-rotate-left"></i>
                <span>恢复</span>
            </button>
            <button type="button" id="prompt-keeper-delete" class="menu_button" title="删除当前聊天的保存配置">
                <i class="fa-solid fa-trash-can"></i>
                <span>删除</span>
            </button>
        </div>
    </div>`;

    let injected = false;

    if (!injected) {
        const $quickPromptDrawer = jQuery('#quick_prompts_container, #quickPromptEditor, #quick-prompts-inline-drawer').first();
        if ($quickPromptDrawer.length > 0) {
            $quickPromptDrawer.before(buttonBarHtml);
            injected = true;
        }
    }

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

    if (!injected) {
        const $list = jQuery(
            '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
        ).first();
        if ($list.length > 0) {
            $list.after(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        const $aiConfig = jQuery('#ai_response_configuration');
        if ($aiConfig.length > 0) {
            $aiConfig.append(buttonBarHtml);
            injected = true;
        }
    }

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


    // 直接绑定按钮事件（非事件委托，iOS 兼容）
    bindButtonEvents();

    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));

    console.log(LOG_PREFIX, 'UI injected successfully.');
}

function tryInjectUI(maxRetries = 15, interval = 1000) {
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
            toastr.success('已启用', 'Prompt Keeper');
        } else {
            toastr.info('已禁用', 'Prompt Keeper');
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
            toastr.success('自动恢复已开', 'Prompt Keeper');
        } else {
            toastr.info('自动恢复已关', 'Prompt Keeper');
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    console.log(LOG_PREFIX, 'Settings panel loaded.');
}

// ========== Main Init ==========

function _pkInit() {
    let ctx;
    try {
        ctx = getCtx();
    } catch (_) {
        console.warn(LOG_PREFIX, 'SillyTavern global not ready. Will retry in 2s.');
        setTimeout(_pkInit, 2000);
        return;
    }

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types;

    if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
        console.error(LOG_PREFIX, 'SillyTavern context is incomplete (eventSource or event_types missing). Plugin cannot initialize. Will retry in 2s.');
        setTimeout(_pkInit, 2000);
        return;
    }

    eventSource.on(eventTypes.APP_READY, () => {
        loadSettingsPanel();
        tryInjectUI();
        startUIObserver();
        requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
        console.log(LOG_PREFIX, 'Plugin v2.0.1 initialized (APP_READY).');
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (jQuery('#prompt-keeper-bar').length === 0) {
            tryInjectUI(5, 500);
        }
        onChatChanged();
    });

    if (eventTypes.CHAT_LOADED) {
        eventSource.on(eventTypes.CHAT_LOADED, onChatLoaded);
    }

    if (eventTypes.PRESET_CHANGED) {
        eventSource.on(eventTypes.PRESET_CHANGED, onPresetChanged);
    }

    if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
        eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, onPresetChanged);
    }

    if (eventTypes.MAIN_API_CHANGED) {
        eventSource.on(eventTypes.MAIN_API_CHANGED, onMainApiChanged);
    }

    console.log(LOG_PREFIX, 'Plugin v2.0.1 loaded, waiting for APP_READY...');
}

_pkInit();
