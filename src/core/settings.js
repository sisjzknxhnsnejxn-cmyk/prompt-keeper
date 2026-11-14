/**
 * Prompt Keeper - 插件设置读写、双保险本地持久化备份与校验
 */

import {
    DEFAULT_SETTINGS,
    SETTINGS_BACKUP_STORAGE_KEY,
    SETTINGS_KEY,
    SLOTS_BACKUP_STORAGE_KEY,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { getCtxSafe } from '../utils/st-context.js';

let inMemorySettings = null;
let legacyAccountStorageCleaned = false;

function getLocalStorageSafe() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
    } catch (_) {}
    return null;
}

/**
 * 清理 v2.2.3 遗留在 SillyTavern accountStorage 中的大体量冗余备份键，
 * 防止 accountStorage.getState() 将重复数据打包进 /api/settings/save 导致 settings.json 膨胀。
 */
export function cleanupLegacyAccountStorage() {
    if (legacyAccountStorageCleaned || !runtimeState.promptKeeperAppReadyHandled) return;
    try {
        const ctx = getCtxSafe();
        if (
            ctx &&
            ctx.accountStorage &&
            typeof ctx.accountStorage.getItem === 'function' &&
            typeof ctx.accountStorage.removeItem === 'function'
        ) {
            legacyAccountStorageCleaned = true;
            if (ctx.accountStorage.getItem(SETTINGS_BACKUP_STORAGE_KEY) !== null) {
                ctx.accountStorage.removeItem(SETTINGS_BACKUP_STORAGE_KEY);
            }
            if (ctx.accountStorage.getItem(SLOTS_BACKUP_STORAGE_KEY) !== null) {
                ctx.accountStorage.removeItem(SLOTS_BACKUP_STORAGE_KEY);
            }
        }
    } catch (_) {}
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
    const storage = getLocalStorageSafe();
    if (!storage) return null;
    try {
        const rawText = storage.getItem(SETTINGS_BACKUP_STORAGE_KEY);
        if (!rawText) return null;
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === 'object') {
            return sanitizeSettingsObject(parsed, DEFAULT_SETTINGS);
        }
    } catch (_) {}
    return null;
}

export function writeSettingsBackupToStorage(settings) {
    if (!settings || typeof settings !== 'object') return;
    const storage = getLocalStorageSafe();
    if (!storage) return;
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
    try {
        storage.setItem(SETTINGS_BACKUP_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
}

/**
 * 纯只读加载插件设置（严禁在读取期间触发 saveSettingsDebounced 等服务端写操作）
 */
export function loadPluginSettings() {
    const ctx = getCtxSafe();
    const hasExtensionSettingsContainer = Boolean(
        ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object'
    );

    if (hasExtensionSettingsContainer) {
        const existingServerObj = ctx.extensionSettings[SETTINGS_KEY];
        if (existingServerObj && typeof existingServerObj === 'object') {
            if (inMemorySettings === existingServerObj) {
                return inMemorySettings;
            }
            const backup = readSettingsBackupFromStorage();
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
            return existingServerObj;
        }
    }

    if (inMemorySettings) {
        return inMemorySettings;
    }

    const backup = readSettingsBackupFromStorage();
    const fallbackBase = sanitizeSettingsObject(backup, DEFAULT_SETTINGS);

    if (hasExtensionSettingsContainer && runtimeState.promptKeeperAppReadyHandled) {
        ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, fallbackBase);
        inMemorySettings = ctx.extensionSettings[SETTINGS_KEY];
        return inMemorySettings;
    }

    inMemorySettings = fallbackBase;
    return inMemorySettings;
}

/**
 * 当 SillyTavern 完成服务端设置加载（SETTINGS_LOADED / EXTENSION_SETTINGS_LOADED / APP_READY）时调用，
 * 将内存与服务端设置对象对齐，不在启动中途抢跑触发写请求。
 */
export function syncPluginSettingsWithServer() {
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
    if (runtimeState.promptKeeperAppReadyHandled && backup && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return restored;
}

/**
 * 防抖保存插件配置到 SillyTavern 服务端，并立即同步写入本地备份（仅在用户主动变更配置或槽位时调用）
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

        if (runtimeState.promptKeeperAppReadyHandled && typeof ctx.saveSettingsDebounced === 'function') {
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
