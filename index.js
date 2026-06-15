/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states per chat session.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 1.0.0
 * @license MIT
 */

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';

// Default settings
const defaultSettings = {
    restoreMode: 'auto', // 'auto' | 'ask' | 'notify'
    configs: {},         // { [chatId]: { [promptIdentifier]: boolean } }
};

/**
 * Initialize extension settings with defaults
 */
function initSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }
    const settings = extension_settings[EXTENSION_NAME];
    if (settings.restoreMode === undefined) {
        settings.restoreMode = defaultSettings.restoreMode;
    }
    if (settings.configs === undefined) {
        settings.configs = {};
    }
}

/**
 * Get the current chat ID from ST context
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
 * Read the current prompt entry states from the DOM
 * @returns {Object|null} Map of prompt identifier to enabled state
 */
function readPromptStates() {
    const states = {};
    // Try multiple possible container selectors
    const $container = jQuery('#completion_prompt_manager_list');
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'Container #completion_prompt_manager_list not found.');
        return null;
    }

    $container.find('[data-pm-identifier]').each(function () {
        const $row = jQuery(this);
        const identifier = $row.attr('data-pm-identifier');
        if (!identifier) return;

        // Try multiple checkbox selectors that ST might use
        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length === 0) return;

        states[identifier] = $checkbox.prop('checked');
    });

    if (Object.keys(states).length === 0) {
        console.debug(LOG_PREFIX, 'No entries with data-pm-identifier found. Trying toggle approach...');
        // Fallback: try to read from the prompt manager's internal state via ST context
        return readPromptStatesFromContext();
    }

    return states;
}

/**
 * Fallback: Read prompt states from SillyTavern's internal context/API
 * @returns {Object|null}
 */
function readPromptStatesFromContext() {
    try {
        const context = getContext();
        if (!context) return null;

        // Access prompt manager prompts from ST's internal structure
        const promptManager = context.PromptManager || context.promptManager;
        if (!promptManager) {
            // Try to access via the global power_user or oai_settings
            const prompts = window?.oai_settings?.prompts;
            if (prompts && Array.isArray(prompts)) {
                const states = {};
                for (const prompt of prompts) {
                    if (prompt.identifier) {
                        states[prompt.identifier] = prompt.enabled !== false;
                    }
                }
                if (Object.keys(states).length > 0) return states;
            }
            return null;
        }

        const serviceSettings = promptManager.serviceSettings;
        if (!serviceSettings || !serviceSettings.prompts) return null;

        const states = {};
        for (const prompt of serviceSettings.prompts) {
            if (prompt.identifier) {
                states[prompt.identifier] = prompt.enabled !== false;
            }
        }

        return Object.keys(states).length > 0 ? states : null;
    } catch (e) {
        console.error(LOG_PREFIX, 'Error reading from context:', e);
        return null;
    }
}

/**
 * Save prompt states for the current chat
 */
function saveCurrentConfig() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(LOG_PREFIX, 'No active chat, cannot save.');
        updateStatusDisplay(false);
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        console.warn(LOG_PREFIX, 'No prompt states found in DOM.');
        updateStatusDisplay(false);
        return false;
    }

    extension_settings[EXTENSION_NAME].configs[chatId] = states;
    saveSettingsDebounced();

    const now = new Date();
    const timeStr = formatTimestamp(now);
    console.log(LOG_PREFIX, 'Saved config for chat:', chatId, states);
    updateStatusDisplay(true, timeStr);
    return true;
}

/**
 * Restore prompt states for the current chat
 * @param {boolean} silent - If true, don't show toastr notifications
 * @returns {boolean}
 */
function restoreCurrentConfig(silent = false) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(LOG_PREFIX, 'No active chat, cannot restore.');
        return false;
    }

    const settings = extension_settings[EXTENSION_NAME];
    const savedConfig = settings.configs[chatId];
    if (!savedConfig) {
        if (!silent) {
            toastr.info('No saved configuration for this chat.', 'Prompt Keeper');
        }
        return false;
    }

    applyPromptStates(savedConfig);
    console.log(LOG_PREFIX, 'Restored config for chat:', chatId, savedConfig);

    if (!silent) {
        toastr.success('Prompt configuration restored.', 'Prompt Keeper');
    }
    return true;
}

/**
 * Apply prompt states to the DOM
 * @param {Object} config - Map of prompt identifier to enabled state
 */
function applyPromptStates(config) {
    const $container = jQuery('#completion_prompt_manager_list');
    if ($container.length === 0) {
        console.warn(LOG_PREFIX, 'Prompt manager list not found in DOM.');
        return;
    }

    for (const [identifier, enabled] of Object.entries(config)) {
        const $row = $container.find(`[data-pm-identifier="${identifier}"]`);
        if ($row.length === 0) continue;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length === 0) continue;

        const currentState = $checkbox.prop('checked');
        if (currentState !== enabled) {
            $checkbox.prop('checked', enabled).trigger('change');
        }
    }
}

/**
 * Delete saved config for the current chat
 */
function deleteCurrentConfig() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(LOG_PREFIX, 'No active chat, cannot delete.');
        return false;
    }

    const settings = extension_settings[EXTENSION_NAME];
    if (settings.configs[chatId]) {
        delete settings.configs[chatId];
        saveSettingsDebounced();
        console.log(LOG_PREFIX, 'Deleted config for chat:', chatId);
        toastr.success('Configuration deleted for this chat.', 'Prompt Keeper');
        updateStatusDisplay(false);
        return true;
    } else {
        toastr.info('No saved configuration to delete.', 'Prompt Keeper');
        return false;
    }
}

/**
 * Handle chat changed event
 */
function onChatChanged() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        updateStatusDisplay(false);
        return;
    }

    const settings = extension_settings[EXTENSION_NAME];
    const savedConfig = settings.configs[chatId];

    if (!savedConfig) {
        updateStatusDisplay(false);
        return;
    }

    updateStatusDisplay(true);

    switch (settings.restoreMode) {
        case 'auto':
            // Wait a brief moment for the DOM to update after chat switch
            requestAnimationFrame(() => {
                restoreCurrentConfig(true);
                toastr.info('Prompt configuration auto-restored.', 'Prompt Keeper');
            });
            break;

        case 'ask':
            if (confirm('[Prompt Keeper] Saved prompt configuration found for this chat. Restore it?')) {
                restoreCurrentConfig(true);
                toastr.success('Prompt configuration restored.', 'Prompt Keeper');
            }
            break;

        case 'notify':
            toastr.info(
                'Saved prompt configuration available. Use the Restore button to apply.',
                'Prompt Keeper',
                { timeOut: 5000 }
            );
            break;
    }
}

/**
 * Handle prompt checkbox change event (auto-save)
 */
function onPromptStateChanged() {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    saveCurrentConfig();
}

/**
 * Format a Date object as a readable timestamp
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Update the status display in the UI
 * @param {boolean} hasSave
 * @param {string} [timeStr]
 */
function updateStatusDisplay(hasSave, timeStr) {
    const $status = jQuery('#prompt-keeper-status');
    if ($status.length === 0) return;

    if (hasSave) {
        const display = timeStr ? `✓ Saved (Last: ${timeStr})` : '✓ Saved';
        $status.text(display).removeClass('pk-not-saved').addClass('pk-saved');
    } else {
        $status.text('⚠ Not Saved').removeClass('pk-saved').addClass('pk-not-saved');
    }
}

/**
 * Inject the UI buttons near the Prompt Manager area
 */
function injectUI() {
    const buttonBarHtml = `
    <div id="prompt-keeper-bar" class="prompt-keeper-bar">
        <span id="prompt-keeper-status" class="pk-not-saved">⚠ Not Saved</span>
        <div id="prompt-keeper-btn-group" class="prompt-keeper-btn-group">
            <button id="prompt-keeper-save" class="menu_button" title="Save current prompt configuration">
                <i class="fa-solid fa-floppy-disk"></i>
                <span data-i18n="Save">Save</span>
            </button>
            <button id="prompt-keeper-restore" class="menu_button" title="Restore saved prompt configuration">
                <i class="fa-solid fa-rotate-left"></i>
                <span data-i18n="Restore">Restore</span>
            </button>
            <button id="prompt-keeper-delete" class="menu_button" title="Delete saved configuration for this chat">
                <i class="fa-solid fa-trash-can"></i>
                <span data-i18n="Delete">Delete</span>
            </button>
        </div>
    </div>`;

    // Inject before the prompt entries list (条目列表前面)
    const $list = jQuery('#completion_prompt_manager_list');
    if ($list.length > 0) {
        $list.before(buttonBarHtml);
    } else {
        // Fallback: try to inject before the prompt manager container
        const $target = jQuery('#completion_prompt_manager');
        if ($target.length > 0) {
            $target.prepend(buttonBarHtml);
        } else {
            const $fallback = jQuery('#ai_response_configuration');
            if ($fallback.length > 0) {
                $fallback.prepend(buttonBarHtml);
            }
        }
    }

    // Bind button events
    jQuery('#prompt-keeper-save').on('click', function () {
        saveCurrentConfig();
    });

    jQuery('#prompt-keeper-restore').on('click', function () {
        restoreCurrentConfig();
    });

    jQuery('#prompt-keeper-delete').on('click', function () {
        deleteCurrentConfig();
    });
}

/**
 * Load the settings HTML panel
 */
async function loadSettingsPanel() {
    const settingsHtml = await jQuery.get(`/scripts/extensions/third-party/${EXTENSION_NAME}/settings.html`);
    jQuery('#extensions_settings2').append(settingsHtml);

    // Bind restore mode radio buttons
    const currentMode = extension_settings[EXTENSION_NAME].restoreMode || 'auto';
    jQuery(`input[name="pk-restore-mode"][value="${currentMode}"]`).prop('checked', true);

    jQuery('input[name="pk-restore-mode"]').on('change', function () {
        extension_settings[EXTENSION_NAME].restoreMode = jQuery(this).val();
        saveSettingsDebounced();
        console.log(LOG_PREFIX, 'Restore mode changed to:', jQuery(this).val());
    });
}

/**
 * Main initialization
 */
jQuery(async () => {
    // Initialize settings
    initSettings();

    // Load settings panel
    await loadSettingsPanel();

    // Inject UI buttons
    injectUI();

    // Listen for chat changes
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Listen for prompt checkbox state changes via event delegation
    // Use broad selector since ST may not use .prompt_manager_enabled class
    jQuery(document).on(
        'change',
        '#completion_prompt_manager_list [data-pm-identifier] input[type="checkbox"]',
        onPromptStateChanged
    );

    // Update status on load
    const chatId = getCurrentChatId();
    if (chatId && extension_settings[EXTENSION_NAME].configs[chatId]) {
        updateStatusDisplay(true);
    } else {
        updateStatusDisplay(false);
    }

    console.log(LOG_PREFIX, 'Plugin loaded successfully.');
});
