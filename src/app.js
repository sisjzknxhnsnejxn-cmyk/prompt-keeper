/**
 * Prompt Keeper - 插件生命周期控制器（初始化、事件绑定、销毁与热重载）
 */

import { LOG_PREFIX, PLUGIN_VERSION } from './config/constants.js';
import { resetRuntimeState, runtimeState } from './config/runtime-state.js';
import { isPluginEnabled, loadPluginSettings, syncPluginSettingsWithServer } from './core/settings.js';
import { onChatChanged, onUserPresetChanged } from './services/auto-restore-service.js';
import { hasSavedState } from './services/slot-service.js';
import {
    clearSettingsRetryTimer,
    injectSettingsPanel,
    syncSettingsPanelUI,
    tryInjectSettingsPanel,
} from './ui/settings-panel.js';
import { closeInputModal } from './ui/input-modal.js';
import { closeSlotPickerModal } from './ui/slot-picker-modal.js';
import { updateStatusDisplay } from './ui/status-bar.js';
import {
    bindPromptKeeperButtonDelegation,
    ensurePCUIWatchdog,
    scheduleEnsurePromptKeeperUI,
    startUIObserver,
    tryInjectUI,
    unbindPromptKeeperButtonDelegation,
} from './ui/ui-observer.js';
import { getCtxSafe } from './utils/st-context.js';

export function registerEventSourceListener(eventSource, eventName, handler) {
    if (!eventSource || !eventName || typeof handler !== 'function') return;
    if (typeof eventSource.on === 'function') {
        eventSource.on(eventName, handler);
        runtimeState.promptKeeperEventBindings.push({ eventSource, eventName, handler });
    }
}

export function unbindPromptKeeperEventListeners() {
    for (const binding of runtimeState.promptKeeperEventBindings) {
        try {
            if (binding.eventSource && typeof binding.eventSource.removeListener === 'function') {
                binding.eventSource.removeListener(binding.eventName, binding.handler);
            } else if (binding.eventSource && typeof binding.eventSource.off === 'function') {
                binding.eventSource.off(binding.eventName, binding.handler);
            }
        } catch (_) {}
    }
    runtimeState.promptKeeperEventBindings = [];

    if (typeof jQuery !== 'undefined') {
        jQuery(document).off('.promptkeeper');
        jQuery(document).off('.promptkeeperPreset');
        jQuery(document).off('.promptkeeperDrawer');
    }
}

export function destroyPromptKeeper() {
    clearSettingsRetryTimer();
    unbindPromptKeeperEventListeners();
    unbindPromptKeeperButtonDelegation();
    closeInputModal();
    closeSlotPickerModal();
    resetRuntimeState();

    if (typeof jQuery !== 'undefined') {
        jQuery('#prompt-keeper-bar').remove();
        jQuery('#prompt-keeper-settings').remove();
    }
}

export function initPromptKeeper(attempt = 0) {
    if (runtimeState.initRetryTimer) {
        clearTimeout(runtimeState.initRetryTimer);
        runtimeState.initRetryTimer = null;
    }

    const ctx = getCtxSafe();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
        if (attempt < 30) {
            runtimeState.initRetryTimer = setTimeout(() => {
                runtimeState.initRetryTimer = null;
                initPromptKeeper(attempt + 1);
            }, 300);
        } else {
            console.error(LOG_PREFIX, 'SillyTavern context/eventSource not available after 30 attempts, aborting.');
        }
        return;
    }

    if (runtimeState.promptKeeperEventHandlersBound) return;
    runtimeState.promptKeeperEventHandlersBound = true;

    const { eventSource, event_types } = ctx;

    const ensureUIMounted = (source = 'init') => {
        loadPluginSettings();
        tryInjectSettingsPanel(0);
        syncSettingsPanelUI();
        bindPromptKeeperButtonDelegation();

        if (isPluginEnabled()) {
            tryInjectUI(0);
            scheduleEnsurePromptKeeperUI(source);
            startUIObserver();
            ensurePCUIWatchdog();
        }
    };

    const handleAppReady = () => {
        const isFirstReady = !runtimeState.promptKeeperAppReadyHandled;
        runtimeState.promptKeeperAppReadyHandled = true;

        syncPluginSettingsWithServer();
        ensureUIMounted('appReady');
        syncSettingsPanelUI();

        if (isFirstReady && isPluginEnabled()) {
            // 无论当前聊天是否已有存档，先记录当前 chatId，防止后续在同聊天保存+切预设+点正则重载时被误判为新聊天
            try {
                const currentCtx = getCtxSafe();
                if (currentCtx && currentCtx.chatId && !runtimeState.lastHandledChatId) {
                    runtimeState.lastHandledChatId = currentCtx.chatId;
                }
            } catch (_) {}

            if (hasSavedState()) {
                // 启动时若已有存档，重置 lastHandledChatId 以便首次正常执行自动恢复
                runtimeState.lastHandledChatId = null;
                onChatChanged();
            } else {
                updateStatusDisplay();
            }
        }
    };

    registerEventSourceListener(eventSource, event_types.APP_READY, handleAppReady);
    registerEventSourceListener(eventSource, event_types.CHAT_CHANGED, () => {
        scheduleEnsurePromptKeeperUI('chatChanged');
        onChatChanged();
    });

    if (event_types.CHAT_LOADED) {
        registerEventSourceListener(eventSource, event_types.CHAT_LOADED, () => {
            scheduleEnsurePromptKeeperUI('chatLoaded');
            onChatChanged();
        });
    }

    if (event_types.SETTINGS_LOADED_AFTER) {
        registerEventSourceListener(eventSource, event_types.SETTINGS_LOADED_AFTER, () => {
            syncPluginSettingsWithServer();
            syncSettingsPanelUI();
            if (!isPluginEnabled()) return;
            scheduleEnsurePromptKeeperUI('settingsLoadedAfter');
            updateStatusDisplay();
        });
    }

    if (event_types.EXTENSION_SETTINGS_LOADED) {
        registerEventSourceListener(eventSource, event_types.EXTENSION_SETTINGS_LOADED, () => {
            syncPluginSettingsWithServer();
            syncSettingsPanelUI();
            if (!isPluginEnabled()) return;
            scheduleEnsurePromptKeeperUI('extensionSettingsLoaded');
            updateStatusDisplay();
        });
    }

    if (event_types.SETTINGS_LOADED) {
        registerEventSourceListener(eventSource, event_types.SETTINGS_LOADED, () => {
            syncPluginSettingsWithServer();
            syncSettingsPanelUI();
            if (!isPluginEnabled()) return;
            updateStatusDisplay();
        });
    }

    if (event_types.OAI_PRESET_CHANGED_AFTER) {
        registerEventSourceListener(eventSource, event_types.OAI_PRESET_CHANGED_AFTER, () => {
            if (!isPluginEnabled()) return;
            onUserPresetChanged('OAI_PRESET_CHANGED_AFTER');
            scheduleEnsurePromptKeeperUI('oaiPresetChangedAfter');
        });
    }

    if (event_types.PRESET_CHANGED) {
        registerEventSourceListener(eventSource, event_types.PRESET_CHANGED, () => {
            if (!isPluginEnabled()) return;
            onUserPresetChanged('PRESET_CHANGED');
            scheduleEnsurePromptKeeperUI('presetChanged');
        });
    }

    if (event_types.MAIN_API_CHANGED) {
        registerEventSourceListener(eventSource, event_types.MAIN_API_CHANGED, () => {
            if (!isPluginEnabled()) return;
            scheduleEnsurePromptKeeperUI('mainApiChanged');
        });
    }

    if (typeof jQuery !== 'undefined') {
        jQuery(document)
            .off('promptManagerUpdated.promptkeeper')
            .on('promptManagerUpdated.promptkeeper', () => {
                if (!isPluginEnabled() || runtimeState.promptKeeperRefreshingUI) return;
                runtimeState.promptKeeperRefreshingUI = true;
                try {
                    scheduleEnsurePromptKeeperUI('promptManagerUpdated');
                } finally {
                    runtimeState.promptKeeperRefreshingUI = false;
                }
            });

        jQuery(document)
            .off('change.promptkeeperPreset', '#settings_preset_openai, #settings_preset, #main_api')
            .on('change.promptkeeperPreset', '#settings_preset_openai, #settings_preset, #main_api', function () {
                if (!isPluginEnabled()) return;
                const elId = this && this.id ? this.id : '';
                if (elId === 'settings_preset_openai' || elId === 'settings_preset') {
                    onUserPresetChanged(`dom_change:${elId}`);
                }
                scheduleEnsurePromptKeeperUI('presetOrApiSelectChange');
                setTimeout(updateStatusDisplay, 120);
            });

        jQuery(document)
            .off('click.promptkeeperDrawer touchend.promptkeeperDrawer', '#ai-config-button, #leftNavDrawerIcon, #left-nav-panel .drawer-toggle')
            .on('click.promptkeeperDrawer touchend.promptkeeperDrawer', '#ai-config-button, #leftNavDrawerIcon, #left-nav-panel .drawer-toggle', () => {
                if (!isPluginEnabled()) return;
                scheduleEnsurePromptKeeperUI('drawerOpen');
            });
    }

    // 先尝试挂载一次（应对在 APP_READY 之后热重载或延迟加载的场景），
    // 同时不锁死 promptKeeperAppReadyHandled，确保真正的 APP_READY 到来时还会再次挂载。
    ensureUIMounted('init');
    if (isPluginEnabled() && hasSavedState()) {
        onChatChanged();
    } else {
        updateStatusDisplay();
    }
    console.log(LOG_PREFIX, `Extension initialized (v${PLUGIN_VERSION}).`);
}
