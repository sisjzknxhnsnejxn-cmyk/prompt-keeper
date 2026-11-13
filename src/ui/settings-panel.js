/**
 * Prompt Keeper - 扩展设置面板注入与事件绑定
 */

import { DEFAULT_AUTO_RESTORE_DELAY_MS, LOG_PREFIX } from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { loadPluginSettings, savePluginSettings } from '../core/settings.js';
import { closeSlotPickerModal } from './slot-picker-modal.js';
import { updateStatusDisplay } from './status-bar.js';
import { buildSettingsPanelHTML } from './templates.js';
import { ensurePCUIWatchdog, startUIObserver, tryInjectUI } from './ui-observer.js';

let settingsRetryTimer = null;

export function injectSettingsPanel() {
    if (typeof jQuery === 'undefined') return false;
    const $existing = jQuery('#prompt-keeper-settings');
    if ($existing.length > 0 && typeof document !== 'undefined' && document.body && document.body.contains($existing[0])) {
        return true;
    }

    const $container = jQuery('#extensions_settings2, #extensions_settings').first();
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'Extensions settings container not found yet.');
        return false;
    }

    $existing.remove();
    const settings = loadPluginSettings();
    const html = buildSettingsPanelHTML(settings);
    $container.append(html);

    jQuery('#pk-setting-enabled').on('change', function () {
        const s = loadPluginSettings();
        s.enabled = jQuery(this).prop('checked');
        savePluginSettings();

        const $bar = jQuery('#prompt-keeper-bar');
        if (s.enabled) {
            if ($bar.length === 0) {
                tryInjectUI(0);
            } else {
                $bar.show();
                updateStatusDisplay();
            }
            startUIObserver();
            ensurePCUIWatchdog();
        } else {
            $bar.hide();
            closeSlotPickerModal();
            if (runtimeState.autoRestoreTimer) {
                clearTimeout(runtimeState.autoRestoreTimer);
                runtimeState.autoRestoreTimer = null;
            }
        }
        if (typeof toastr !== 'undefined') {
            toastr.info(s.enabled ? 'Prompt Keeper 已启用' : 'Prompt Keeper 已禁用', 'Prompt Keeper');
        }
    });

    jQuery('#pk-setting-auto-restore').on('change', function () {
        const s = loadPluginSettings();
        s.autoRestore = jQuery(this).prop('checked');
        savePluginSettings();
    });

    jQuery('#pk-setting-custom-save-name').on('change', function () {
        const s = loadPluginSettings();
        s.customSaveName = jQuery(this).prop('checked');
        savePluginSettings();
    });

    jQuery('#pk-setting-delay').on('change', function () {
        const s = loadPluginSettings();
        let val = parseInt(String(jQuery(this).val()), 10);
        if (Number.isNaN(val) || val < 300) val = 300;
        if (val > 5000) val = 5000;
        jQuery(this).val(val);
        s.autoRestoreDelay = val;
        savePluginSettings();
    });

    console.log(LOG_PREFIX, 'Settings panel injected.');
    return true;
}

export function clearSettingsRetryTimer() {
    if (settingsRetryTimer) {
        clearTimeout(settingsRetryTimer);
        settingsRetryTimer = null;
    }
}

export function tryInjectSettingsPanel(attempt = 0) {
    clearSettingsRetryTimer();

    if (injectSettingsPanel()) {
        return true;
    }

    if (attempt < 25) {
        const delay = attempt < 6 ? 350 : 800;
        settingsRetryTimer = setTimeout(() => {
            settingsRetryTimer = null;
            tryInjectSettingsPanel(attempt + 1);
        }, delay);
    }
    return false;
}
