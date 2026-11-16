/**
 * Prompt Keeper - 聊天元数据版本迁移与槽位查询
 */

import {
    AUTO_RESTORE_CONTEXT_POLL_MS,
    AUTO_RESTORE_CONTEXT_TIMEOUT_MS,
    LOG_PREFIX,
    METADATA_KEY,
    METADATA_VERSION,
    SLOTS_BACKUP_STORAGE_KEY,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { pkScheduleIdleTask } from '../utils/dom-events.js';
import { hasOwnSlot, isSafeSlotName, normalizePresetKey, normalizeSlotName } from '../utils/format.js';
import { getCtxSafe, persistChatMetadata } from '../utils/st-context.js';
import { compactPromptOrder } from './prompt-reader.js';
import { loadPluginSettings, savePluginSettings } from './settings.js';
import { getFileBackupForChat, updateFileBackupForChat } from './slots-file-backup.js';

function getLocalStorageSafe() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
    } catch (_) {}
    return null;
}

function isPlainChatKey(chatId) {
    return Boolean(
        chatId &&
            typeof chatId === 'string' &&
            chatId !== '__proto__' &&
            chatId !== 'constructor' &&
            chatId !== 'prototype'
    );
}

function sanitizeSingleSlot(slot, fallbackSlotName = '') {
    if (!slot || typeof slot !== 'object' || !slot.prompts || typeof slot.prompts !== 'object') {
        return null;
    }
    const cleanPrompts = {};
    for (const [k, v] of Object.entries(slot.prompts)) {
        if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        cleanPrompts[k] = Boolean(v);
    }
    return {
        prompts: cleanPrompts,
        promptOrder: Array.isArray(slot.promptOrder) ? compactPromptOrder(slot.promptOrder, cleanPrompts) : null,
        presetName: slot.presetName || fallbackSlotName,
        savedAt: Number(slot.savedAt) || 0,
    };
}

function sanitizeSlotsMap(rawSlots) {
    const cleanSlots = {};
    if (!rawSlots || typeof rawSlots !== 'object') return cleanSlots;

    for (const [key, value] of Object.entries(rawSlots)) {
        if (!isSafeSlotName(key)) continue;
        const cleanSlot = sanitizeSingleSlot(value, key);
        if (!cleanSlot) continue;
        cleanSlots[key] = cleanSlot;
    }
    return cleanSlots;
}

export function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    if (raw.version === 2 && raw.slots && typeof raw.slots !== 'function') {
        const slots = sanitizeSlotsMap(raw.slots);
        const slotKeys = Object.keys(slots);
        const defaultSlot = raw.defaultSlot && hasOwnSlot(slots, raw.defaultSlot)
            ? raw.defaultSlot
            : (slotKeys[0] || null);
        return {
            version: METADATA_VERSION,
            defaultSlot,
            slots,
        };
    }

    if (!raw.version || raw.version === 1) {
        const slotName = normalizeSlotName(raw.presetName);
        const slots = {};
        const cleanSlot = sanitizeSingleSlot(
            {
                prompts: raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : {},
                promptOrder: raw.promptOrder || null,
                presetName: raw.presetName || slotName,
                savedAt: raw.savedAt || null,
            },
            slotName
        );
        if (cleanSlot) {
            slots[slotName] = cleanSlot;
        }
        return {
            version: METADATA_VERSION,
            defaultSlot: slotName,
            slots,
        };
    }

    if (raw.version > METADATA_VERSION) {
        console.warn(
            LOG_PREFIX,
            `Metadata version ${raw.version} is newer than supported version ${METADATA_VERSION}. Data will be treated as read-only to prevent corruption.`
        );
        const copy = Object.assign({}, raw);
        copy.__futureVersion = true;
        return copy;
    }

    console.warn(LOG_PREFIX, `Unknown metadata version ${raw.version}, treating as current.`);
    return Object.assign({}, raw, { version: METADATA_VERSION });
}

export function getSlotEntries(state) {
    if (!state || !state.slots || typeof state.slots !== 'object') return [];
    return Object.entries(state.slots)
        .filter(([key, slot]) => isSafeSlotName(key) && slot && typeof slot === 'object' && slot.prompts)
        .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
}

export function findSlotName(state, presetName, options = {}) {
    if (!state || !state.slots || !presetName) return null;

    const normalizedPreset = normalizePresetKey(presetName);
    const preferExactSlotName = options.preferExactSlotName === true;
    const entries = getSlotEntries(state);

    if (preferExactSlotName) {
        for (const [slotName] of entries) {
            if (normalizePresetKey(slotName) === normalizedPreset) return slotName;
        }
        for (const [slotName, slot] of entries) {
            if (slot && normalizePresetKey(slot.presetName) === normalizedPreset) return slotName;
        }
        return null;
    }

    for (const [slotName, slot] of entries) {
        if (normalizePresetKey(slotName) === normalizedPreset) return slotName;
        if (slot && normalizePresetKey(slot.presetName) === normalizedPreset) return slotName;
    }

    return null;
}


export function getDefaultSlotState(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && hasOwnSlot(state.slots, state.defaultSlot)) {
        return state.slots[state.defaultSlot];
    }
    const first = getSlotEntries(state)[0];
    return first ? first[1] : null;
}

export function getDefaultSlotName(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && hasOwnSlot(state.slots, state.defaultSlot)) {
        return state.defaultSlot;
    }
    const first = getSlotEntries(state)[0];
    return first ? first[0] : null;
}

export function getBestRestoreSlotName(state, requestedSlotName = null, currentPresetName = null) {
    if (!state || !state.slots) return null;

    let targetSlotName = requestedSlotName;
    if (targetSlotName && !hasOwnSlot(state.slots, targetSlotName)) {
        targetSlotName = findSlotName(state, targetSlotName);
    }
    if (targetSlotName && hasOwnSlot(state.slots, targetSlotName)) {
        return targetSlotName;
    }

    if (currentPresetName) {
        const settings = loadPluginSettings();
        targetSlotName = findSlotName(state, currentPresetName, {
            preferExactSlotName: settings.customSaveName !== true,
        });
        if (targetSlotName && hasOwnSlot(state.slots, targetSlotName)) {
            return targetSlotName;
        }
    }

    return getDefaultSlotName(state);
}

/**
 * 旧版 localStorage 备份的一次性读取（仅用于迁移到服务端文件备份，不再写入）。
 * @returns {Object|null} { [chatId]: { version, defaultSlot, slots, updatedAt } }
 */
export function readLegacyLocalSlotsBackup() {
    const result = {};

    const collect = (raw) => {
        if (!raw || typeof raw !== 'object') return;

        const globalSlots =
            raw.globalSlots && typeof raw.globalSlots === 'object'
                ? sanitizeSlotsMap(raw.globalSlots)
                : {};

        if (raw.byChat && typeof raw.byChat === 'object') {
            for (const [chatId, chatState] of Object.entries(raw.byChat)) {
                if (!isPlainChatKey(chatId)) continue;
                const migrated = migrateState(chatState);
                if (!migrated || migrated.__futureVersion) continue;
                if (Object.keys(migrated.slots).length === 0) continue;
                const updatedAt = Number(chatState && chatState.updatedAt) || 0;
                const existing = result[chatId];
                if (existing && (existing.updatedAt || 0) > updatedAt) continue;
                result[chatId] = {
                    version: METADATA_VERSION,
                    defaultSlot: migrated.defaultSlot,
                    slots: migrated.slots,
                    updatedAt: updatedAt || Date.now(),
                };
            }
        }

        // v2.2.x 的紧凑格式：chatBindings 仅记录槽位名，数据体在 globalSlots 中
        if (raw.chatBindings && typeof raw.chatBindings === 'object') {
            for (const [chatId, binding] of Object.entries(raw.chatBindings)) {
                if (!isPlainChatKey(chatId) || result[chatId]) continue;
                if (!binding || typeof binding !== 'object') continue;
                const slotNames = Array.isArray(binding.slotNames) ? binding.slotNames : [];
                const reconstructedSlots = {};
                for (const name of slotNames) {
                    if (isSafeSlotName(name) && hasOwnSlot(globalSlots, name)) {
                        reconstructedSlots[name] = globalSlots[name];
                    }
                }
                if (Object.keys(reconstructedSlots).length === 0) continue;
                result[chatId] = {
                    version: METADATA_VERSION,
                    defaultSlot:
                        binding.defaultSlot && hasOwnSlot(reconstructedSlots, binding.defaultSlot)
                            ? binding.defaultSlot
                            : Object.keys(reconstructedSlots)[0],
                    slots: reconstructedSlots,
                    updatedAt: Number(binding.updatedAt) || 0,
                };
            }
        }
    };

    const storage = getLocalStorageSafe();
    if (storage) {
        try {
            const text = storage.getItem(SLOTS_BACKUP_STORAGE_KEY);
            if (text) collect(JSON.parse(text));
        } catch (_) {}
    }

    try {
        const settings = loadPluginSettings();
        if (settings && settings.slotsBackup) collect(settings.slotsBackup);
    } catch (_) {}

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * 清除已迁移到服务端文件的旧版 localStorage / settings.json 备份，避免重复占用空间。
 */
export function clearLegacyLocalSlotsBackup() {
    const storage = getLocalStorageSafe();
    if (storage) {
        try {
            storage.removeItem(SLOTS_BACKUP_STORAGE_KEY);
        } catch (_) {}
    }

    try {
        const settings = loadPluginSettings();
        if (settings && typeof settings === 'object' && settings.slotsBackup) {
            delete settings.slotsBackup;
            savePluginSettings();
        }
    } catch (_) {}
}

/**
 * 将当前聊天的槽位状态同步到服务端文件备份。
 * 严格按聊天隔离：只写入 / 删除 chatId 自己的条目，绝不触碰其它聊天。
 * @param {string|null} chatId 当前聊天 id
 * @param {object|null} savedState 当前聊天的槽位状态；为空表示该聊天已无槽位
 * @param {object} options
 * @param {boolean} options.clearAllForChat 是否清空该聊天的全部槽位备份
 */
export function syncSlotBackupForChat(chatId, savedState, options = {}) {
    if (!chatId) return;
    const { clearAllForChat = false } = options;

    if (clearAllForChat) {
        updateFileBackupForChat(chatId, null);
        return;
    }

    const migrated = migrateState(savedState);
    if (migrated && !migrated.__futureVersion && Object.keys(migrated.slots).length > 0) {
        updateFileBackupForChat(chatId, {
            defaultSlot: migrated.defaultSlot,
            slots: sanitizeSlotsMap(migrated.slots),
            updatedAt: Date.now(),
        });
        return;
    }

    updateFileBackupForChat(chatId, null);
}

export function persistMigratedStateIfNeeded(chatMetadata, rawState, migratedState, options = {}) {
    if (!chatMetadata || !rawState || !migratedState || migratedState.__futureVersion) return;
    if (rawState.version === METADATA_VERSION && rawState.slots) return;

    chatMetadata[METADATA_KEY] = migratedState;

    const persist = () => {
        runtimeState.migratedStatePersistTimer = null;
        runtimeState.migratedStatePersistIdleId = null;
        if (!runtimeState.promptKeeperAppReadyHandled) return;
        const ctx = getCtxSafe();
        if (!ctx || !ctx.chatId) return;
        persistChatMetadata();
    };

    if (options.deferred === true) {
        if (runtimeState.migratedStatePersistTimer || runtimeState.migratedStatePersistIdleId) return;
        runtimeState.migratedStatePersistTimer = setTimeout(() => {
            runtimeState.migratedStatePersistTimer = null;
            runtimeState.migratedStatePersistIdleId = pkScheduleIdleTask(persist, 2000);
        }, 1800);
        return;
    }

    persist();
}

/**
 * 纯只读查询当前聊天的预设槽位状态（严禁在读取函数中执行 persistChatMetadata 或 savePluginSettings 等写操作）
 *
 * 数据来源严格按当前聊天隔离：
 *   1. 当前聊天的 chatMetadata（主存档）
 *   2. 服务端文件备份中属于当前 chatId 的条目（主存档丢失时的兜底）
 * 不再跨聊天合并任何槽位。
 */
export function getSavedStateFromCurrentChat() {
    const ctx = getCtxSafe();
    const chatMetadata = ctx ? ctx.chatMetadata : null;
    const chatId = ctx ? ctx.chatId : null;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    let savedState = migrateState(rawState);

    if (savedState && savedState.__futureVersion) {
        return { chatMetadata, rawState, savedState };
    }

    let hasChatBoundSlots = Boolean(savedState && getSlotEntries(savedState).length > 0);

    if (!hasChatBoundSlots && chatId) {
        const fileEntry = getFileBackupForChat(chatId);
        if (fileEntry) {
            const recovered = migrateState(fileEntry);
            if (recovered && !recovered.__futureVersion && getSlotEntries(recovered).length > 0) {
                savedState = recovered;
                hasChatBoundSlots = true;
            }
        }
    }

    if (savedState && typeof savedState === 'object') {
        Object.defineProperty(savedState, '__hasChatBoundSlots', {
            value: hasChatBoundSlots,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }

    return { chatMetadata, rawState, savedState };
}

export async function waitForChatContext(chatId, timeoutMs = AUTO_RESTORE_CONTEXT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const ctx = getCtxSafe();
        if (ctx && ctx.chatId === chatId && ctx.chatMetadata) {
            await new Promise((resolve) => {
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(resolve);
                } else {
                    setTimeout(resolve, 16);
                }
            });
            const stableCtx = getCtxSafe();
            if (stableCtx && stableCtx.chatId === chatId && stableCtx.chatMetadata === ctx.chatMetadata) {
                return true;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, AUTO_RESTORE_CONTEXT_POLL_MS));
    }

    return false;
}
