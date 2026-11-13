/**
 * Prompt Keeper (预设条目状态保持器) — ES Module 核心入口
 */

import { destroyPromptKeeper, initPromptKeeper } from './app.js';
import { LOG_PREFIX, PLUGIN_VERSION } from './config/constants.js';
import { applyPromptStates } from './core/prompt-applier.js';
import { checkDirtyState, promptOrderEqual } from './core/prompt-dirty-check.js';
import { readPromptStates } from './core/prompt-reader.js';
import {
    isAutoRestoreEnabled,
    isPluginEnabled,
    loadPluginSettings,
    savePluginSettings,
} from './core/settings.js';
import {
    findSlotName,
    getBestRestoreSlotName,
    getDefaultSlotName,
    getDefaultSlotState,
    getSavedStateFromCurrentChat,
    getSlotEntries,
    migrateState,
} from './core/state-migration.js';
import { onChatChanged } from './services/auto-restore-service.js';
import {
    getCurrentPresetName,
    refreshPromptManagerUI,
    switchToPreset,
} from './services/preset-service.js';
import {
    deleteSavedStates,
    hasSavedState,
    restoreStatesFromMetadata,
    saveStatesToMetadata,
    setDefaultSlot,
} from './services/slot-service.js';
import { injectSettingsPanel, tryInjectSettingsPanel } from './ui/settings-panel.js';
import { closeSlotPickerModal, openSlotPickerModal } from './ui/slot-picker-modal.js';
import { updateStatusDisplay } from './ui/status-bar.js';
import { injectUI, scheduleEnsurePromptKeeperUI, startUIObserver, tryInjectUI } from './ui/ui-observer.js';

/**
 * 启动或热重载插件实例
 */
export function bootstrapPromptKeeper() {
    try {
        if (
            typeof window !== 'undefined' &&
            window.PromptKeeper &&
            typeof window.PromptKeeper.destroy === 'function'
        ) {
            window.PromptKeeper.destroy();
        }

        if (typeof window !== 'undefined') {
            window.PromptKeeper = {
                version: PLUGIN_VERSION,
                init: initPromptKeeper,
                destroy: destroyPromptKeeper,
                reload: () => {
                    if (typeof window.PromptKeeperReload === 'function') {
                        return window.PromptKeeperReload();
                    }
                    return bootstrapPromptKeeper();
                },
                saveStatesToMetadata,
                restoreStatesFromMetadata,
                deleteSavedStates,
                setDefaultSlot,
                hasSavedState,
                readPromptStates,
                applyPromptStates,
                checkDirtyState,
                promptOrderEqual,
                migrateState,
                getSlotEntries,
                findSlotName,
                getDefaultSlotState,
                getDefaultSlotName,
                getBestRestoreSlotName,
                getSavedStateFromCurrentChat,
                getCurrentPresetName,
                switchToPreset,
                refreshPromptManagerUI,
                loadPluginSettings,
                savePluginSettings,
                isPluginEnabled,
                isAutoRestoreEnabled,
                updateStatusDisplay,
                openSlotPickerModal,
                closeSlotPickerModal,
                injectUI,
                tryInjectUI,
                startUIObserver,
                injectSettingsPanel,
                tryInjectSettingsPanel,
                 loadSettingsPanel: injectSettingsPanel,
                scheduleEnsurePromptKeeperUI,
                onChatChanged,
            };
        }

        initPromptKeeper(0);
        return window.PromptKeeper;
    } catch (error) {
        console.error(LOG_PREFIX, 'Failed to initialize Prompt Keeper:', error);
        return null;
    }
}

export { initPromptKeeper, destroyPromptKeeper };
