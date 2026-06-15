/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) per chat session.
 * Uses chatMetadata for storage, auto-saves before generation, auto-restores on chat switch.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.1.0
 * @license MIT
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';

/**
 * Get current SillyTavern context
 * @returns {object}
 */
function getCtx() {
    return SillyTavern.getContext();
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
                // prompt_order structure: array of { character_id, order: [{identifier, enabled}] }
                // Or it can be a simple array depending on ST version
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
 * Save current prompt states to chatMetadata
 * @returns {boolean} Whether save was successful
 */
function saveStatesToMetadata() {
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

    chatMetadata[METADATA_KEY] = {
        prompts: states.prompts,
        promptOrder: states.promptOrder,
        savedAt: Date.now(),
    };

    ctx.saveMetadataDebounced();

    console.log(LOG_PREFIX, `Saved prompt states for chat: ${chatId}`, states.prompts);
    updateStatusDisplay(true);
    return true;
}

/**
 * Restore prompt states from chatMetadata
 * @param {boolean} silent - If true, don't show toastr notifications
 * @returns {boolean}
 */
function restoreStatesFromMetadata(silent = false) {
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

    const { skipped } = applyPromptStates(savedState);

    if (skipped.length > 0) {
        const msg = `以下条目在当前预设中不存在，已跳过：\n${skipped.join(', ')}`;
        console.warn(LOG_PREFIX, msg);
        if (!silent) {
            toastr.warning(msg, 'Prompt Keeper', { timeOut: 8000 });
        }
    }

    if (!silent) {
        toastr.success('预设条目配置已恢复。', 'Prompt Keeper');
    }

    console.log(LOG_PREFIX, `Restored prompt states for chat: ${chatId}`);
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
    console.debug(LOG_PREFIX, 'Generation started, auto-saving prompt states...');
    saveStatesToMetadata();
}

/**
 * Handle CHAT_CHANGED event - auto restore
 */
function onChatChanged() {
    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        updateStatusDisplay(false);
        return;
    }

    // Brief delay to let metadata load
    setTimeout(() => {
        if (hasSavedState()) {
            updateStatusDisplay(true);
            restoreStatesFromMetadata(true);
            toastr.info('预设条目配置已自动恢复。', 'Prompt Keeper', { timeOut: 3000 });
        } else {
            updateStatusDisplay(false);
        }
    }, 500);
}

// ========== UI ==========

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

    // Strategy 1: Insert after the prompt manager list
    const $list = jQuery('#completion_prompt_manager_list');
    if ($list.length > 0) {
        $list.after(buttonBarHtml);
        injected = true;
    }

    // Strategy 2: Insert in AI response configuration area
    if (!injected) {
        const $aiConfig = jQuery('#ai_response_configuration');
        if ($aiConfig.length > 0) {
            $aiConfig.append(buttonBarHtml);
            injected = true;
        }
    }

    // Strategy 3: Insert in openai settings
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
 * Load settings panel using renderExtensionTemplateAsync
 */
async function loadSettingsPanel() {
    try {
        const ctx = getCtx();
        const settingsHtml = await ctx.renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        jQuery('#extensions_settings2').append(settingsHtml);
        console.log(LOG_PREFIX, 'Settings panel loaded.');
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to load settings panel:', e);
    }
}

// ========== Main Init ==========

(function init() {
    const ctx = getCtx();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes;

    // Wait for APP_READY before performing DOM operations
    eventSource.on(eventTypes.APP_READY, () => {
        // Load settings panel
        loadSettingsPanel();

        // Inject UI
        tryInjectUI();

        // Initial status check
        if (hasSavedState()) {
            updateStatusDisplay(true);
        } else {
            updateStatusDisplay(false);
        }

        console.log(LOG_PREFIX, 'Plugin v2.1.0 initialized (APP_READY).');
    });

    // Listen for generation start (auto-save before sending)
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);

    // Listen for chat change (auto-restore)
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        tryInjectUI(5, 500);
        onChatChanged();
    });

    console.log(LOG_PREFIX, 'Plugin v2.1.0 loaded, waiting for APP_READY...');
})();
