/**
 * Prompt Keeper - 插件设置读写、双保险本地持久化备份与校验
 */

import {
    DEFAULT_SETTINGS,
    SETTINGS_BACKUP_STORAGE_KEY,
    SETTINGS_KEY,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { getCtxSafe } from '../utils/st-context.js';

let inMemorySettings = null;

function getStorageAdapters() {
    const adapters = [];
    // AccountStorage 在 SillyTavern 完成 initUserStorage / APP_READY 前处于未就绪态，
    // 提前访问会触发控制台 "AccountStorage not ready" 警告且无法读取服务端状态。
    if (runtimeState.promptKeeperAppReadyHandled) {
        try {
            const ctx = getCtxSafe();
            if (
                ctx &&
                ctx.accountStorage &&
                typeof ctx.accountStorage.getItem === 'function' &&
                typeof ctx.accountStorage.setItem === 'function'
            ) {
                adapters.push(ctx.accountStorage);
            }
        } catch (_) {}
    }
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            adapters.push(window.localStorage);
        }
    } catch (_) {}
    return adapters;
}

function sanitizeSettingsObject(raw, fallback = DEFAULT_SETTINGS) {
    const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SETTINGS;
    const src = raw && typeof raw === 'object' ? raw : {};

    let delay = Number(src.autoRestoreDelay);
    if (!Number.isFinite(delay) || delay < 300) {
        delay = Number.isFinite(Number(base.autoRestoreDelay))
            ? Number(base.autoRestoreDelay)
            : DEFAULT_SETTINGS.autoRestoreDelay;
    } else if (delay > 5000) {
        delay = 5000;
    }

    const theme = ['dark', 'light'].includes(src.slotPickerTheme)
        ? src.slotPickerTheme
        : ['dark', 'light'].includes(base.slotPickerTheme)
          ? base.slotPickerTheme
          : DEFAULT_SETTINGS.slotPickerTheme;

    const normalized = {
        enabled: src.enabled !== undefined ? Boolean(src.enabled) : Boolean(base.enabled),
        autoRestore: src.autoRestore !== undefined ? Boolean(src.autoRestore) : Boolean(base.autoRestore),
        customSaveName:
            src.customSaveName !== undefined ? Boolean(src.customSaveName) : Boolean(base.customSaveName),
        autoRestoreDelay: delay,
        slotPickerTheme: theme,
    };

    if (src.slotsBackup && typeof src.slotsBackup === 'object') {
        normalized.slotsBackup = src.slotsBackup;
    } else if (base.slotsBackup && typeof base.slotsBackup === 'object') {
        normalized.slotsBackup = base.slotsBackup;
    }
    return normalized;
}

export function readSettingsBackupFromStorage() {
    for (const storage of getStorageAdapters()) {
        try {
            const rawText = storage.getItem(SETTINGS_BACKUP_STORAGE_KEY);
            if (!rawText) continue;
            const parsed = JSON.parse(rawText);
            if (parsed && typeof parsed === 'object') {
                return sanitizeSettingsObject(parsed, DEFAULT_SETTINGS);
            }
        } catch (_) {}
    }
    return null;
}

export function writeSettingsBackupToStorage(settings) {
    if (!settings || typeof settings !== 'object') return;
    const payload = {
        enabled: Boolean(settings.enabled),
        autoRestore: Boolean(settings.autoRestore),
        customSaveName: Boolean(settings.customSaveName),
        autoRestoreDelay: Number(settings.autoRestoreDelay) || DEFAULT_SETTINGS.autoRestoreDelay,
        slotPickerTheme: ['dark', 'light'].includes(settings.slotPickerTheme)
            ? settings.slotPickerTheme
            : DEFAULT_SETTINGS.slotPickerTheme,
        updatedAt: Date.now(),
    };
    const serialized = JSON.stringify(payload);
    for (const storage of getStorageAdapters()) {
        try {
            storage.setItem(SETTINGS_BACKUP_STORAGE_KEY, serialized);
        } catch (_) {}
    }
}

/**
 * 读取并初始化插件配置，确保所有默认字段均存在且合法。
 * 在 SillyTavern 尚未完成 extension_settings 加载前，不提前用默认值覆盖 ctx.extensionSettings[SETTINGS_KEY]。
 */
export function loadPluginSettings() {
    const backup = readSettingsBackupFromStorage();
    const fallbackBase = sanitizeSettingsObject(inMemorySettings || backup || DEFAULT_SETTINGS, DEFAULT_SETTINGS);
    const ctx = getCtxSafe();

    if (!ctx || !ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
        inMemorySettings = fallbackBase;
        return inMemorySettings;
    }

    const existingServerObj = ctx.extensionSettings[SETTINGS_KEY];
    if (existingServerObj && typeof existingServerObj === 'object') {
        const merged = sanitizeSettingsObject(existingServerObj, backup || DEFAULT_SETTINGS);
        existingServerObj.enabled = merged.enabled;
        existingServerObj.autoRestore = merged.autoRestore;
        existingServerObj.customSaveName = merged.customSaveName;
        existingServerObj.autoRestoreDelay = merged.autoRestoreDelay;
        existingServerObj.slotPickerTheme = merged.slotPickerTheme;
        if (merged.slotsBackup && !existingServerObj.slotsBackup) {
            existingServerObj.slotsBackup = merged.slotsBackup;
        }
        inMemorySettings = existingServerObj;
        writeSettingsBackupToStorage(existingServerObj);
        return existingServerObj;
    }

    if (runtimeState.promptKeeperAppReadyHandled) {
        ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, fallbackBase);
        inMemorySettings = ctx.extensionSettings[SETTINGS_KEY];
        if (backup) {
            writeSettingsBackupToStorage(inMemorySettings);
            if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
        }
        return inMemorySettings;
    }

    inMemorySettings = fallbackBase;
    return inMemorySettings;
}

/**
 * 当 SillyTavern 完成服务端设置加载（SETTINGS_LOADED / EXTENSION_SETTINGS_LOADED / APP_READY）时调用，
 * 确保服务端设置与本地备份双向对齐。
 */
export function syncPluginSettingsWithServer() {
    runtimeState.promptKeeperAppReadyHandled = true;
    const backup = readSettingsBackupFromStorage();
    const ctx = getCtxSafe();
    if (!ctx || !ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
        return loadPluginSettings();
    }

    const serverSettings = ctx.extensionSettings[SETTINGS_KEY];
    if (serverSettings && typeof serverSettings === 'object') {
        const merged = sanitizeSettingsObject(serverSettings, backup || DEFAULT_SETTINGS);
        serverSettings.enabled = merged.enabled;
        serverSettings.autoRestore = merged.autoRestore;
        serverSettings.customSaveName = merged.customSaveName;
        serverSettings.autoRestoreDelay = merged.autoRestoreDelay;
        serverSettings.slotPickerTheme = merged.slotPickerTheme;
        inMemorySettings = serverSettings;
        writeSettingsBackupToStorage(serverSettings);
        return serverSettings;
    }

    const restored = sanitizeSettingsObject(inMemorySettings || backup || DEFAULT_SETTINGS, DEFAULT_SETTINGS);
    ctx.extensionSettings[SETTINGS_KEY] = restored;
    inMemorySettings = restored;
    writeSettingsBackupToStorage(restored);
    if (backup && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return restored;
}

/**
 * 防抖保存插件配置到 SillyTavern 服务端，并立即同步写入本地备份
 */
export function savePluginSettings() {
    const ctx = getCtxSafe();
    const current = inMemorySettings || loadPluginSettings();

    if (ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
        if (!ctx.extensionSettings[SETTINGS_KEY] || typeof ctx.extensionSettings[SETTINGS_KEY] !== 'object') {
            ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, current);
        } else if (ctx.extensionSettings[SETTINGS_KEY] !== current) {
            Object.assign(ctx.extensionSettings[SETTINGS_KEY], current);
        }
        inMemorySettings = ctx.extensionSettings[SETTINGS_KEY];
        writeSettingsBackupToStorage(inMemorySettings);

        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
        return;
    }

    writeSettingsBackupToStorage(current);
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
