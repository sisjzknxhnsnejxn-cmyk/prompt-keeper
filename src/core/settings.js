/**
 * Prompt Keeper - 插件设置读写与校验
 */

import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../config/constants.js';
import { getCtxSafe } from '../utils/st-context.js';

/**
 * 读取并初始化插件配置，确保所有默认字段均存在且合法
 */
export function loadPluginSettings() {
    const ctx = getCtxSafe();
    if (!ctx) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    if (!ctx.extensionSettings[SETTINGS_KEY] || typeof ctx.extensionSettings[SETTINGS_KEY] !== 'object') {
        ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, DEFAULT_SETTINGS);
    }

    const settings = ctx.extensionSettings[SETTINGS_KEY];
    if (settings.enabled === undefined) settings.enabled = DEFAULT_SETTINGS.enabled;
    if (settings.autoRestore === undefined) settings.autoRestore = DEFAULT_SETTINGS.autoRestore;
    if (settings.customSaveName === undefined) settings.customSaveName = DEFAULT_SETTINGS.customSaveName;
    if (settings.autoRestoreDelay === undefined) settings.autoRestoreDelay = DEFAULT_SETTINGS.autoRestoreDelay;
    if (!['dark', 'light'].includes(settings.slotPickerTheme)) {
        settings.slotPickerTheme = DEFAULT_SETTINGS.slotPickerTheme;
    }

    return settings;
}

/**
 * 防抖保存插件配置到 SillyTavern 服务端
 */
export function savePluginSettings() {
    const ctx = getCtxSafe();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

/**
 * 插件是否已启用
 */
export function isPluginEnabled() {
    return loadPluginSettings().enabled !== false;
}

/**
 * 切换聊天时自动恢复是否已启用
 */
export function isAutoRestoreEnabled() {
    const s = loadPluginSettings();
    return s.enabled !== false && s.autoRestore !== false;
}
