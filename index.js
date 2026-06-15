/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) AND the active preset per chat session.
 * Uses chatMetadata for storage. Manual save, auto-restore on chat switch with debounce + dirty check.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.5.0
 * @license MIT
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';
const SETTINGS_KEY = 'promptKeeperPluginSettings';

// Default plugin settings
const DEFAULT_SETTINGS = {
    enabled: true, // 插件默认启动
    autoRestore: true, // 切换聊天时自动恢复
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

/** Debounce timer for auto-restore */
let autoRestoreTimer = null;

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
    // Ensure new settings fields have defaults for existing installs
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
    const settings = loadPluginSettings();
    return settings.enabled !== false;
}

/**
 * Check if auto-restore is enabled
 * @returns {boolean}
 */
function isAutoRestoreEnabled() {
    const settings = loadPluginSettings();
    return settings.enabled !== false && settings.autoRestore !== false;
}

/**
 * Read the current prompt states and order from chatCompletionSettings (API level)
 * Falls back to DOM if API data is unavailable.
 * @returns {{ prompts: Object<string, boolean>, promptOrder: Array } | null}
 */
function readPromptStates() {
    // Strategy 1: API level via chatCompletionSettings (oai_settings)
    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && oaiSettings.prompts && Array.isArray(oaiSettings.prompts)) {
            const prompts = {};
            for (const p of oaiSettings.prompts) {
                if (p.identifier) {
                    prompts[p.identifier] = p.enabled !== false;
                }
            }

            // prompt_order is typically an array of objects with character_id and order
            let promptOrder = null;
            if (oaiSettings.prompt_order && Array.isArray(oaiSettings.prompt_order)) {
                promptOrder = JSON.parse(JSON.stringify(oaiSettings.prompt_order));
            }

            if (Object.keys(prompts).length > 0) {
                console.debug(LOG_PREFIX, 'Read prompt states from API (chatCompletionSettings)');
                return { prompts, promptOrder };
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to read from chatCompletionSettings:', e);
    }

    // Strategy 2: DOM fallback
    return readPromptStatesFromDOM();
}

/**
 * Fallback: Read prompt states from DOM
 * @returns {{ prompts: Object<string, boolean>, promptOrder: Array } | null}
 */
function readPromptStatesFromDOM() {
    const $container = jQuery('#completion_prompt_manager_list');
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'DOM container not found for fallback read.');
        return null;
    }

    const prompts = {};
    const orderArray = [];

    $container.find('[data-pm-identifier]').each(function () {
        const $row = jQuery(this);
        const identifier = $row.attr('data-pm-identifier');
        if (!identifier) return;

        // Read enabled state
        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            prompts[identifier] = $checkbox.prop('checked');
        } else {
            // Try toggle-style elements
            const $toggle = $row.find('.prompt_manager_prompt_toggle');
            if ($toggle.length > 0) {
                prompts[identifier] = $toggle.hasClass('enabled') || $toggle.attr('data-enabled') === 'true';
            }
        }

        // Collect order by DOM position
        orderArray.push(identifier);
    });

    if (Object.keys(prompts).length === 0) {
        console.debug(LOG_PREFIX, 'No prompt entries found in DOM.');
        return null;
    }

    console.debug(LOG_PREFIX, 'Read prompt states from DOM fallback');
    return { prompts, promptOrder: orderArray };
}

/**
 * Dirty check: compare current state with saved state to determine if restore is needed.
 * Returns an object indicating what needs to change.
 * @param {object} savedState - The saved state from chatMetadata
 * @returns {{ needsPresetSwitch: boolean, needsEntryRestore: boolean, targetPreset: string|null }}
 */
function checkDirtyState(savedState) {
    const result = {
        needsPresetSwitch: false,
        needsEntryRestore: false,
        targetPreset: null,
    };

    if (!savedState || !savedState.prompts) return result;

    // Check preset
    if (savedState.presetName) {
        const currentPreset = getCurrentPresetName();
        if (currentPreset && currentPreset !== savedState.presetName) {
            result.needsPresetSwitch = true;
            result.targetPreset = savedState.presetName;
        }
    }

    // Check entry states (only if same preset or no preset switch needed)
    if (!result.needsPresetSwitch) {
        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
                if (currentStates.prompts[identifier] !== undefined && currentStates.prompts[identifier] !== enabled) {
                    result.needsEntryRestore = true;
                    break;
                }
            }
            // Also check order if entries match
            if (!result.needsEntryRestore && savedState.promptOrder && currentStates.promptOrder) {
                const savedOrderStr = JSON.stringify(savedState.promptOrder);
                const currentOrderStr = JSON.stringify(currentStates.promptOrder);
                if (savedOrderStr !== currentOrderStr) {
                    result.needsEntryRestore = true;
                }
            }
        } else {
            // Can't read current state, assume we need restore
            result.needsEntryRestore = true;
        }
    } else {
        // If preset is different, entries will definitely need restore after switch
        result.needsEntryRestore = true;
    }

    return result;
}

/**
 * Apply saved prompt states to chatCompletionSettings (API level)
 * Falls back to DOM if API is unavailable.
 * @param {{ prompts: Object<string, boolean>, promptOrder: Array }} savedState
 * @returns {{ skipped: string[] }} Info about skipped entries
 */
function applyPromptStates(savedState) {
    const skipped = [];
    const { prompts: savedPrompts, promptOrder: savedOrder } = savedState;

    // Strategy 1: API level
    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && oaiSettings.prompts && Array.isArray(oaiSettings.prompts)) {
            // Apply enabled states
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

            // Apply prompt order if available
            if (savedOrder && Array.isArray(savedOrder) && oaiSettings.prompt_order && Array.isArray(oaiSettings.prompt_order)) {
                if (savedOrder.length > 0 && typeof savedOrder[0] === 'object' && savedOrder[0].character_id !== undefined) {
                    // Full prompt_order structure
                    oaiSettings.prompt_order = JSON.parse(JSON.stringify(savedOrder));
                } else if (savedOrder.length > 0 && typeof savedOrder[0] === 'string') {
                    // Simple identifier array from DOM fallback - try to reorder
                    applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped);
                }
            }

            // Save settings to persist changes
            if (ctx.saveSettingsDebounced) {
                ctx.saveSettingsDebounced();
            }

            console.debug(LOG_PREFIX, 'Applied prompt states via API');
            return { skipped };
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to apply via API, trying DOM fallback:', e);
    }

    // Strategy 2: DOM fallback
    applyPromptStatesDOM(savedPrompts, skipped);
    return { skipped };
}

/**
 * Apply order from a simple identifier list to oai_settings prompt_order
 */
function applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped) {
    if (!oaiSettings.prompt_order || oaiSettings.prompt_order.length === 0) return;

    for (const entry of oaiSettings.prompt_order) {
        if (!entry.order || !Array.isArray(entry.order)) continue;

        const currentOrderMap = new Map(entry.order.map((item, idx) => [item.identifier, item]));
        const newOrder = [];

        // First, place items in saved order
        for (const identifier of savedOrder) {
            if (currentOrderMap.has(identifier)) {
                newOrder.push(currentOrderMap.get(identifier));
                currentOrderMap.delete(identifier);
            }
        }

        // Then append any remaining items not in saved order
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
    const $container = jQuery('#completion_prompt_manager_list');
    if ($container.length === 0) {
        console.warn(LOG_PREFIX, 'DOM container not found for apply.');
        return;
    }

    const currentIdentifiers = new Set();
    $container.find('[data-pm-identifier]').each(function () {
        const id = jQuery(this).attr('data-pm-identifier');
        if (id) currentIdentifiers.add(id);
    });

    for (const [identifier, enabled] of Object.entries(savedPrompts)) {
        if (!currentIdentifiers.has(identifier)) {
            skipped.push(identifier);
            continue;
        }

        const $row = $container.find(`[data-pm-identifier="${identifier}"]`);
        if ($row.length === 0) continue;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            const currentState = $checkbox.prop('checked');
            if (currentState !== enabled) {
                $checkbox.prop('checked', enabled).trigger('change');
            }
        }
    }

    console.debug(LOG_PREFIX, 'Applied prompt states via DOM fallback');
}

/**
 * Get the name of the currently active preset
 * @returns {string|null}
 */
function getCurrentPresetName() {
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager();
        if (pm && pm.getSelectedPresetName) {
            return pm.getSelectedPresetName();
        }
        // Fallback: try reading from DOM selector
        const $select = jQuery('#settings_preset_openai, #settings_preset');
        if ($select.length > 0) {
            const selectedText = $select.find('option:selected').text();
            if (selectedText) return selectedText.trim();
        }
        // Fallback: read from select value
        if ($select.length > 0 && $select.val()) {
            return $select.val();
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to get current preset name:', e);
    }
    return null;
}

/**
 * Switch to a named preset by manipulating the preset selector DOM element
 * and falling back to slash commands if DOM approach fails.
 * @param {string} presetName - The preset name to switch to
 * @returns {Promise<boolean>} Whether the switch was successful
 */
async function switchToPreset(presetName) {
    if (!presetName) return false;

    // Check if we're already on this preset
    const currentPreset = getCurrentPresetName();
    if (currentPreset === presetName) {
        console.debug(LOG_PREFIX, `Already on preset "${presetName}", no switch needed.`);
        return true;
    }

    // Strategy 1: DOM selector approach (most reliable)
    try {
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            let matched = false;
            $select.find('option').each(function () {
                const $opt = jQuery(this);
                const optText = $opt.text().trim();
                const optVal = $opt.val();
                if (optText === presetName || optVal === presetName) {
                    $select.val($opt.val()).trigger('change');
                    matched = true;
                    return false; // break
                }
            });
            if (matched) {
                console.log(LOG_PREFIX, `Switched preset to "${presetName}" via DOM selector.`);
                return true;
            }
            console.debug(LOG_PREFIX, `Preset "${presetName}" not found in selector options.`);
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'DOM selector approach failed:', e);
    }

    // Strategy 2: Slash command with properly quoted name
    try {
        const ctx = getCtx();
        const escapedName = presetName.replace(/"/g, '\\"');
        if (ctx.executeSlashCommandsWithOptions) {
            const result = await ctx.executeSlashCommandsWithOptions(`/preset "${escapedName}"`);
            console.log(LOG_PREFIX, `Switched preset to "${presetName}" via /preset command`, result);
            await new Promise(resolve => setTimeout(resolve, 300));
            const afterPreset = getCurrentPresetName();
            if (afterPreset === presetName) {
                return true;
            }
            console.warn(LOG_PREFIX, `Slash command ran but preset is "${afterPreset}" instead of "${presetName}"`);
        }
        if (ctx.executeSlashCommands) {
            await ctx.executeSlashCommands(`/preset "${escapedName}"`);
            console.log(LOG_PREFIX, `Switched preset to "${presetName}" via executeSlashCommands`);
            await new Promise(resolve => setTimeout(resolve, 300));
            const afterPreset = getCurrentPresetName();
            if (afterPreset === presetName) {
                return true;
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, `Slash command approach failed for preset "${presetName}":`, e);
    }

    console.error(LOG_PREFIX, `All strategies failed to switch to preset "${presetName}".`);
    return false;
}

/**
 * Save current prompt states to chatMetadata (always shows notification)
 * @returns {boolean} Whether save was successful
 */
function saveStatesToMetadata() {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('没有活跃的聊天，无法保存。', 'Prompt Keeper');
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        toastr.warning('未能读取预设条目状态，请确认预设管理器已加载。', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('chatMetadata 不可用，无法保存。', 'Prompt Keeper');
        return false;
    }

    // Get current preset name to save alongside prompt states
    const presetName = getCurrentPresetName();

    chatMetadata[METADATA_KEY] = {
        prompts: states.prompts,
        promptOrder: states.promptOrder,
        presetName: presetName,
        savedAt: Date.now(),
    };

    ctx.saveMetadataDebounced();

    console.log(LOG_PREFIX, `Saved prompt states for chat: ${chatId}, preset: ${presetName}`, states.prompts);
    updateStatusDisplay(true);

    toastr.success(`预设条目配置已保存成功！${presetName ? '（预设: ' + presetName + '）' : ''}`, 'Prompt Keeper', { timeOut: 3000 });

    return true;
}

/**
 * Restore prompt states from chatMetadata
 * Handles preset switching (async) before restoring entry states.
 * @param {boolean} silent - If true, suppress success notification (used for auto-restore)
 * @returns {Promise<boolean>}
 */
async function restoreStatesFromMetadata(silent = false) {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        if (!silent) toastr.warning('没有活跃的聊天，无法恢复。', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        if (!silent) toastr.warning('chatMetadata 不可用，无法恢复。', 'Prompt Keeper');
        return false;
    }

    const savedState = chatMetadata[METADATA_KEY];

    if (!savedState || !savedState.prompts) {
        if (!silent) toastr.info('当前聊天没有保存的预设条目配置。', 'Prompt Keeper');
        return false;
    }

    // Dirty check: skip restore if nothing changed
    const dirty = checkDirtyState(savedState);
    if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
        console.debug(LOG_PREFIX, 'Dirty check passed: current state matches saved state, skipping restore.');
        if (!silent) toastr.info('当前状态已与保存配置一致，无需恢复。', 'Prompt Keeper');
        return true;
    }

    // Step 1: Switch preset if a different one was saved
    let presetSwitched = false;
    if (dirty.needsPresetSwitch) {
        console.log(LOG_PREFIX, `Switching preset to "${dirty.targetPreset}"...`);
        presetSwitched = await switchToPreset(dirty.targetPreset);
        if (presetSwitched) {
            // Wait a moment for the preset to fully load before applying entry states
            await new Promise(resolve => setTimeout(resolve, 600));
        } else {
            const msg = `无法切换到保存的预设 "${dirty.targetPreset}"，条目恢复已跳过。`;
            console.warn(LOG_PREFIX, msg);
            if (!silent) toastr.warning(msg + '请手动切换预设后再尝试恢复。', 'Prompt Keeper', { timeOut: 5000 });
            return false;
        }
    }

    // Step 2: Apply prompt entry states (enabled/order)
    const { skipped } = applyPromptStates(savedState);

    if (skipped.length > 0) {
        const msg = `以下条目在当前预设中不存在，已跳过：\n${skipped.join(', ')}`;
        console.warn(LOG_PREFIX, msg);
        if (!silent) toastr.warning(msg, 'Prompt Keeper - 恢复提醒', { timeOut: 8000 });
    }

    const presetInfo = presetSwitched ? `（已切换预设: ${dirty.targetPreset}）` : '';
    if (!silent) {
        toastr.success(`预设条目配置已恢复。${presetInfo}`, 'Prompt Keeper');
    } else {
        // For auto-restore, show a brief non-intrusive notification
        toastr.info(`已自动恢复预设条目配置。${presetInfo}`, 'Prompt Keeper', { timeOut: 2000 });
    }

    console.log(LOG_PREFIX, `Restored prompt states for chat: ${chatId}, preset switched: ${presetSwitched}`);
    updateStatusDisplay(true);
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

// ========== Event Handlers ==========

/**
 * Handle CHAT_CHANGED event - update status display and trigger debounced auto-restore
 */
function onChatChanged() {
    if (!isPluginEnabled()) return;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    // Cancel any pending auto-restore from previous chat switch
    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        console.debug(LOG_PREFIX, 'Cancelled pending auto-restore (new chat switch detected).');
    }

    if (!chatId) {
        updateStatusDisplay(false);
        return;
    }

    // Brief delay to let metadata load, then update status and maybe auto-restore
    setTimeout(() => {
        const hasSave = hasSavedState();
        updateStatusDisplay(hasSave);

        // Trigger debounced auto-restore if enabled and has saved state
        if (hasSave && isAutoRestoreEnabled()) {
            scheduleAutoRestore();
        }
    }, 500);
}

/**
 * Schedule a debounced auto-restore.
 * If another chat switch happens within the delay window, this is cancelled.
 */
function scheduleAutoRestore() {
    const settings = loadPluginSettings();
    const delay = settings.autoRestoreDelay || 1500;

    // Clear any existing timer
    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
    }

    autoRestoreTimer = setTimeout(async () => {
        autoRestoreTimer = null;

        // Double-check conditions are still met
        if (!isAutoRestoreEnabled()) return;
        if (!hasSavedState()) return;

        const ctx = getCtx();
        if (!ctx.chatId) return;

        console.log(LOG_PREFIX, `Auto-restore triggered for chat: ${ctx.chatId}`);
        await restoreStatesFromMetadata(true); // silent mode
    }, delay);

    console.debug(LOG_PREFIX, `Auto-restore scheduled in ${delay}ms.`);
}

// ========== UI ==========

/** MutationObserver instance for monitoring UI removal */
let uiObserver = null;

/** Flag to track if delegated event handlers are already bound */
let eventsDelegated = false;

/**
 * Update status display
 * @param {boolean} hasSave
 */
function updateStatusDisplay(hasSave) {
    const $status = jQuery('#prompt-keeper-status');
    if ($status.length === 0) return;

    if (hasSave) {
        $status.text('✓ 已保存').removeClass('pk-not-saved').addClass('pk-saved');
    } else {
        $status.text('⚠ 无保存').removeClass('pk-saved').addClass('pk-not-saved');
    }
}

/**
 * Start observing the UI bar for removal, re-inject if it disappears.
 * Only observes the bar's direct parent to avoid triggering on unrelated DOM changes (e.g., toastr).
 */
function startUIObserver() {
    if (uiObserver) {
        uiObserver.disconnect();
        uiObserver = null;
    }

    const $bar = jQuery('#prompt-keeper-bar');
    if ($bar.length === 0) return;

    const parentNode = $bar[0].parentNode;
    if (!parentNode) return;

    uiObserver = new MutationObserver((mutations) => {
        // Only react if our bar was actually removed
        for (const mutation of mutations) {
            for (const removed of mutation.removedNodes) {
                if (removed.id === 'prompt-keeper-bar' || (removed.querySelector && removed.querySelector('#prompt-keeper-bar'))) {
                    console.debug(LOG_PREFIX, 'UI bar was removed from DOM, re-injecting...');
                    setTimeout(() => {
                        if (jQuery('#prompt-keeper-bar').length === 0) {
                            injectUI();
                            // Re-attach observer to new parent
                            startUIObserver();
                        }
                    }, 300);
                    return;
                }
            }
        }
    });

    uiObserver.observe(parentNode, {
        childList: true,
        subtree: false,
    });
}

/**
 * Inject the UI bar into the page
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

    // Strategy 1: Insert between Top P and Quick Prompt Editor
    if (!injected) {
        const $quickPromptDrawer = jQuery('#quick_prompts_container, #quickPromptEditor, #quick-prompts-inline-drawer').first();
        if ($quickPromptDrawer.length > 0) {
            $quickPromptDrawer.before(buttonBarHtml);
            injected = true;
        }
    }

    // Strategy 2: Find by searching inline-drawer headers for prompt-related text
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
                injected = true;
            } else {
                $topP.after(buttonBarHtml);
                injected = true;
            }
        }
    }

    // Strategy 4: Insert after the prompt manager list (original fallback)
    if (!injected) {
        const $list = jQuery('#completion_prompt_manager_list');
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

    // Use delegated events bound to document, only once
    if (!eventsDelegated) {
        jQuery(document).on('click', '#prompt-keeper-save', () => saveStatesToMetadata());
        jQuery(document).on('click', '#prompt-keeper-restore', () => restoreStatesFromMetadata(false));
        jQuery(document).on('click', '#prompt-keeper-delete', () => deleteStateFromMetadata());
        eventsDelegated = true;
    }

    // Refresh status display
    updateStatusDisplay(hasSavedState());

    console.log(LOG_PREFIX, 'UI injected successfully.');
}

/**
 * Try to inject UI with retries
 */
function tryInjectUI(maxRetries = 15, interval = 1000) {
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

/**
 * Load settings panel
 */
function loadSettingsPanel() {
    if (jQuery('#prompt-keeper-settings').length > 0) return;
    jQuery('#extensions_settings2').append(SETTINGS_HTML);

    // Load saved settings and apply to checkboxes
    const settings = loadPluginSettings();
    jQuery('#pk-enabled-toggle').prop('checked', settings.enabled !== false);
    jQuery('#pk-auto-restore-toggle').prop('checked', settings.autoRestore !== false);

    // Bind toggle events
    jQuery('#pk-enabled-toggle').on('change', function () {
        const settings = loadPluginSettings();
        settings.enabled = jQuery(this).prop('checked');
        savePluginSettings();
        if (settings.enabled) {
            toastr.success('Prompt Keeper 已启用', 'Prompt Keeper');
        } else {
            toastr.info('Prompt Keeper 已禁用', 'Prompt Keeper');
            // Cancel pending auto-restore if plugin disabled
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    jQuery('#pk-auto-restore-toggle').on('change', function () {
        const settings = loadPluginSettings();
        settings.autoRestore = jQuery(this).prop('checked');
        savePluginSettings();
        if (settings.autoRestore) {
            toastr.success('自动恢复已启用', 'Prompt Keeper');
        } else {
            toastr.info('自动恢复已禁用，切换聊天后需手动恢复', 'Prompt Keeper');
            // Cancel pending auto-restore
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    console.log(LOG_PREFIX, 'Settings panel loaded (inline HTML).');
}

// ========== Main Init ==========

(function init() {
    const ctx = getCtx();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types;

    // Wait for APP_READY before performing DOM operations
    eventSource.on(eventTypes.APP_READY, () => {
        // Load settings panel
        loadSettingsPanel();

        // Inject UI
        tryInjectUI();

        // Start observing for UI disappearance
        startUIObserver();

        // Initial status check
        updateStatusDisplay(hasSavedState());

        console.log(LOG_PREFIX, 'Plugin v2.5.0 initialized (APP_READY).');
    });

    // Listen for chat change (update status + debounced auto-restore)
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        tryInjectUI(5, 500);
        onChatChanged();
    });

    console.log(LOG_PREFIX, 'Plugin v2.5.0 loaded, waiting for APP_READY...');
})();
