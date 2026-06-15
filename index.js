/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) AND the active preset per chat session.
 * Uses chatMetadata for storage, auto-saves before generation, auto-restores on chat switch.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.3.0
 * @license MIT
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';
const SETTINGS_KEY = 'promptKeeperPluginSettings';

// Default plugin settings
const DEFAULT_SETTINGS = {
    enabled: true, // 插件默认启动
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
        </div>
        <hr class="sysHR" />
        <div class="settings_section">
            <label><strong>自动保存时机：</strong> 发送消息之前</label>
            <label><strong>自动恢复时机：</strong> 切换到已保存配置的聊天时</label>
        </div>
    </div>
</div>`;


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
    return ctx.extensionSettings[SETTINGS_KEY];
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
 * Switch to a named preset using STScript /preset command
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

    try {
        const ctx = getCtx();
        // Use executeSlashCommandsWithOptions to run /preset command
        if (ctx.executeSlashCommandsWithOptions) {
            const result = await ctx.executeSlashCommandsWithOptions(`/preset ${presetName}`);
            console.log(LOG_PREFIX, `Switched preset to "${presetName}" via /preset command`, result);
            return true;
        }
        // Fallback: try executeSlashCommands
        if (ctx.executeSlashCommands) {
            await ctx.executeSlashCommands(`/preset ${presetName}`);
            console.log(LOG_PREFIX, `Switched preset to "${presetName}" via executeSlashCommands`);
            return true;
        }
        console.warn(LOG_PREFIX, 'No slash command execution method available for preset switch.');
        return false;
    } catch (e) {
        console.error(LOG_PREFIX, `Failed to switch to preset "${presetName}":`, e);
        return false;
    }
}

/**
 * Save current prompt states to chatMetadata
 * @returns {boolean} Whether save was successful
 */
function saveStatesToMetadata() {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        console.debug(LOG_PREFIX, 'No active chat, skip save.');
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        console.debug(LOG_PREFIX, 'No prompt states to save.');
        return false;
    }

    // Directly modify chatMetadata (do NOT cache the reference long-term)
    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        console.debug(LOG_PREFIX, 'chatMetadata not available, skip save.');
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

    // 保存成功弹窗通知
    toastr.success(`预设条目配置已保存成功！${presetName ? '（预设: ' + presetName + '）' : ''}`, 'Prompt Keeper', { timeOut: 3000 });

    return true;
}

/**
 * Restore prompt states from chatMetadata
 * Handles preset switching (async) before restoring entry states.
 * @param {boolean} silent - If true, don't show toastr notifications
 * @returns {Promise<boolean>}
 */
async function restoreStatesFromMetadata(silent = false) {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        console.debug(LOG_PREFIX, 'No active chat, skip restore.');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        console.debug(LOG_PREFIX, 'chatMetadata not available, skip restore.');
        return false;
    }

    const savedState = chatMetadata[METADATA_KEY];

    if (!savedState || !savedState.prompts) {
        if (!silent) {
            toastr.info('当前聊天没有保存的预设条目配置。', 'Prompt Keeper');
        }
        return false;
    }

    // Step 1: Switch preset if a different one was saved
    let presetSwitched = false;
    if (savedState.presetName) {
        const currentPreset = getCurrentPresetName();
        if (currentPreset && currentPreset !== savedState.presetName) {
            console.log(LOG_PREFIX, `Switching preset from "${currentPreset}" to "${savedState.presetName}"...`);
            presetSwitched = await switchToPreset(savedState.presetName);
            if (presetSwitched) {
                // Wait a moment for the preset to fully load before applying entry states
                await new Promise(resolve => setTimeout(resolve, 600));
            } else {
                const msg = `无法切换到保存的预设 "${savedState.presetName}"，将在当前预设上恢复条目状态。`;
                console.warn(LOG_PREFIX, msg);
                if (!silent) {
                    toastr.warning(msg, 'Prompt Keeper', { timeOut: 5000 });
                }
            }
        }
    }

    // Step 2: Apply prompt entry states (enabled/order)
    const { skipped } = applyPromptStates(savedState);

    if (skipped.length > 0) {
        const msg = `以下条目在当前预设中不存在，已跳过：\n${skipped.join(', ')}`;
        console.warn(LOG_PREFIX, msg);
        toastr.warning(msg, 'Prompt Keeper - 恢复提醒', { timeOut: 8000 });
    }

    if (!silent) {
        const presetInfo = presetSwitched ? `（已切换预设: ${savedState.presetName}）` : '';
        toastr.success(`预设条目配置已恢复。${presetInfo}`, 'Prompt Keeper');
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
        console.warn(LOG_PREFIX, 'No active chat, cannot delete.');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        console.warn(LOG_PREFIX, 'chatMetadata not available, cannot delete.');
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
 * Handle GENERATION_STARTED event - auto save before sending
 */
function onGenerationStarted() {
    if (!isPluginEnabled()) return;
    console.debug(LOG_PREFIX, 'Generation started, auto-saving prompt states...');
    saveStatesToMetadata();
}

/**
 * Handle CHAT_CHANGED event - auto restore (async to support preset switching)
 */
function onChatChanged() {
    if (!isPluginEnabled()) return;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        updateStatusDisplay(false);
        return;
    }

    // Brief delay to let metadata load
    setTimeout(async () => {
        if (hasSavedState()) {
            updateStatusDisplay(true);
            const restored = await restoreStatesFromMetadata(true);
            if (restored) {
                toastr.info('预设条目配置已自动恢复。', 'Prompt Keeper', { timeOut: 3000 });
            }
        } else {
            updateStatusDisplay(false);
        }
    }, 500);
}

// ========== UI ==========

/** MutationObserver instance for monitoring UI removal */
let uiObserver = null;

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
 * Start observing the UI bar for removal, re-inject if it disappears
 */
function startUIObserver() {
    if (uiObserver) {
        uiObserver.disconnect();
    }

    uiObserver = new MutationObserver(() => {
        if (jQuery('#prompt-keeper-bar').length === 0) {
            console.debug(LOG_PREFIX, 'UI bar disappeared, re-injecting...');
            // Small delay to avoid conflicts with ongoing DOM updates
            setTimeout(() => {
                if (jQuery('#prompt-keeper-bar').length === 0) {
                    injectUI();
                }
            }, 300);
        }
    });

    // Observe the body for childList changes in the subtree
    uiObserver.observe(document.body, {
        childList: true,
        subtree: true,
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

    // Bind events
    jQuery('#prompt-keeper-restore').on('click', () => restoreStatesFromMetadata());
    jQuery('#prompt-keeper-delete').on('click', () => deleteStateFromMetadata());

    // Refresh status display
    if (hasSavedState()) {
        updateStatusDisplay(true);
    } else {
        updateStatusDisplay(false);
    }

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

    // Load saved setting and apply to checkbox
    const settings = loadPluginSettings();
    jQuery('#pk-enabled-toggle').prop('checked', settings.enabled !== false);

    // Bind toggle event
    jQuery('#pk-enabled-toggle').on('change', function () {
        const settings = loadPluginSettings();
        settings.enabled = jQuery(this).prop('checked');
        savePluginSettings();
        if (settings.enabled) {
            toastr.success('Prompt Keeper 已启用', 'Prompt Keeper');
        } else {
            toastr.info('Prompt Keeper 已禁用', 'Prompt Keeper');
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
        if (hasSavedState()) {
            updateStatusDisplay(true);
        } else {
            updateStatusDisplay(false);
        }

        console.log(LOG_PREFIX, 'Plugin v2.3.0 initialized (APP_READY).');
    });

    // Listen for generation start (auto-save before sending)
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);

    // Listen for chat change (auto-restore)
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        tryInjectUI(5, 500);
        onChatChanged();
    });

    console.log(LOG_PREFIX, 'Plugin v2.3.0 loaded, waiting for APP_READY...');
})();
