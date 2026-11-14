/**
 * Prompt Keeper - 聊天元数据版本迁移与槽位查询
 */

import {
    AUTO_RESTORE_CONTEXT_POLL_MS,
    AUTO_RESTORE_CONTEXT_TIMEOUT_MS,
    LOG_PREFIX,
    MAX_BACKUP_CHATS,
    MAX_GLOBAL_SLOTS,
    MAX_SLOTS_PER_CHAT,
    METADATA_KEY,
    METADATA_VERSION,
    SLOTS_BACKUP_STORAGE_KEY,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { pkScheduleIdleTask } from '../utils/dom-events.js';
import { hasOwnSlot, isSafeSlotName, normalizePresetKey, normalizeSlotName } from '../utils/format.js';
import { getCtxSafe, persistChatMetadata } from '../utils/st-context.js';
import { loadPluginSettings, savePluginSettings } from './settings.js';

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
        promptOrder: Array.isArray(slot.promptOrder) ? slot.promptOrder : null,
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

let cachedSlotsBackupStore = null;

function getLocalStorageSafe() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
    } catch (_) {}
    return null;
}

function createEmptySlotsBackup() {
    return {
        version: METADATA_VERSION,
        byChat: {},
        globalSlots: {},
    };
}

export function invalidateSlotsBackupCache() {
    cachedSlotsBackupStore = null;
}

function normalizeSlotsBackupObject(raw) {
    const base = createEmptySlotsBackup();
    if (!raw || typeof raw !== 'object') return base;

    if (raw.globalSlots && typeof raw.globalSlots === 'object') {
        base.globalSlots = sanitizeSlotsMap(raw.globalSlots);
    }

    if (raw.byChat && typeof raw.byChat === 'object') {
        for (const [chatId, chatState] of Object.entries(raw.byChat)) {
            if (!chatId || chatId === '__proto__' || chatId === 'constructor' || chatId === 'prototype') {
                continue;
            }
            const migrated = migrateState(chatState);
            if (migrated && !migrated.__futureVersion && Object.keys(migrated.slots).length > 0) {
                base.byChat[chatId] = {
                    version: METADATA_VERSION,
                    defaultSlot: migrated.defaultSlot,
                    slots: migrated.slots,
                    updatedAt: Number(chatState && chatState.updatedAt) || Date.now(),
                };
            }
        }
    }

    if (raw.chatBindings && typeof raw.chatBindings === 'object') {
        for (const [chatId, binding] of Object.entries(raw.chatBindings)) {
            if (
                !chatId ||
                chatId === '__proto__' ||
                chatId === 'constructor' ||
                chatId === 'prototype' ||
                !binding ||
                typeof binding !== 'object' ||
                base.byChat[chatId]
            ) {
                continue;
            }
            const slotNames = Array.isArray(binding.slotNames) ? binding.slotNames : [];
            const reconstructedSlots = {};
            for (const name of slotNames) {
                if (isSafeSlotName(name) && hasOwnSlot(base.globalSlots, name)) {
                    reconstructedSlots[name] = base.globalSlots[name];
                }
            }
            if (Object.keys(reconstructedSlots).length > 0) {
                const defaultSlot =
                    binding.defaultSlot && hasOwnSlot(reconstructedSlots, binding.defaultSlot)
                        ? binding.defaultSlot
                        : Object.keys(reconstructedSlots)[0];
                base.byChat[chatId] = {
                    version: METADATA_VERSION,
                    defaultSlot,
                    slots: reconstructedSlots,
                    updatedAt: Number(binding.updatedAt) || 0,
                };
            }
        }
    }

    return base;
}

export function loadSlotsBackupStore() {
    if (cachedSlotsBackupStore) {
        return cachedSlotsBackupStore;
    }

    let fromStorage = null;
    const storage = getLocalStorageSafe();
    if (storage) {
        try {
            const text = storage.getItem(SLOTS_BACKUP_STORAGE_KEY);
            if (text) {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') {
                    fromStorage = normalizeSlotsBackupObject(parsed);
                }
            }
        } catch (_) {}
    }

    let fromSettings = null;
    try {
        const settings = loadPluginSettings();
        if (settings && settings.slotsBackup && typeof settings.slotsBackup === 'object') {
            fromSettings = normalizeSlotsBackupObject(settings.slotsBackup);
        }
    } catch (_) {}

    const merged = createEmptySlotsBackup();
    const sources = [fromStorage, fromSettings].filter(Boolean);

    for (const src of sources) {
        for (const [slotName, slot] of Object.entries(src.globalSlots)) {
            const existing = merged.globalSlots[slotName];
            if (!existing || (slot.savedAt || 0) >= (existing.savedAt || 0)) {
                merged.globalSlots[slotName] = slot;
            }
        }
        for (const [chatId, chatEntry] of Object.entries(src.byChat)) {
            const existing = merged.byChat[chatId];
            if (!existing || (chatEntry.updatedAt || 0) >= (existing.updatedAt || 0)) {
                merged.byChat[chatId] = chatEntry;
            }
        }
    }

    cachedSlotsBackupStore = merged;
    return merged;
}

export function persistSlotsBackupStore(backupStore) {
    const normalized = normalizeSlotsBackupObject(backupStore);

    const globalEntries = Object.entries(normalized.globalSlots).sort(
        (a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)
    );
    normalized.globalSlots = {};
    for (const [k, v] of globalEntries.slice(0, MAX_GLOBAL_SLOTS)) {
        normalized.globalSlots[k] = v;
    }

    const chatEntries = Object.entries(normalized.byChat).sort(
        (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)
    );
    normalized.byChat = {};
    const compactChatBindings = {};
    for (const [k, v] of chatEntries.slice(0, MAX_BACKUP_CHATS)) {
        normalized.byChat[k] = v;
        compactChatBindings[k] = {
            defaultSlot: v.defaultSlot || null,
            slotNames: Object.keys(v.slots || {}),
            updatedAt: Number(v.updatedAt) || Date.now(),
        };
    }

    cachedSlotsBackupStore = normalized;

    const storage = getLocalStorageSafe();
    if (storage) {
        try {
            storage.setItem(SLOTS_BACKUP_STORAGE_KEY, JSON.stringify(normalized));
        } catch (_) {}
    }

    try {
        const settings = loadPluginSettings();
        if (settings && typeof settings === 'object') {
            settings.slotsBackup = {
                version: METADATA_VERSION,
                globalSlots: normalized.globalSlots,
                chatBindings: compactChatBindings,
            };
            savePluginSettings();
        }
    } catch (_) {}
}

export function syncSlotBackupForChat(chatId, savedState, options = {}) {
    const store = loadSlotsBackupStore();
    const { deletedSlotName = null, clearAllForChat = false } = options;

    if (deletedSlotName && isSafeSlotName(deletedSlotName)) {
        delete store.globalSlots[deletedSlotName];
        for (const chatEntry of Object.values(store.byChat)) {
            if (chatEntry && chatEntry.slots && hasOwnSlot(chatEntry.slots, deletedSlotName)) {
                delete chatEntry.slots[deletedSlotName];
                const rem = Object.keys(chatEntry.slots);
                if (rem.length === 0) {
                    chatEntry.defaultSlot = null;
                } else if (chatEntry.defaultSlot === deletedSlotName) {
                    chatEntry.defaultSlot = rem[0];
                }
            }
        }
    }

    if (clearAllForChat) {
        if (chatId && store.byChat[chatId] && store.byChat[chatId].slots) {
            for (const key of Object.keys(store.byChat[chatId].slots)) {
                delete store.globalSlots[key];
            }
            delete store.byChat[chatId];
        } else {
            store.globalSlots = {};
        }
        persistSlotsBackupStore(store);
        return;
    }

    const migrated = migrateState(savedState);
    if (chatId) {
        if (migrated && !migrated.__futureVersion && Object.keys(migrated.slots).length > 0) {
            store.byChat[chatId] = {
                version: METADATA_VERSION,
                defaultSlot: migrated.defaultSlot,
                slots: sanitizeSlotsMap(migrated.slots),
                updatedAt: Date.now(),
            };
            for (const [slotName, slot] of Object.entries(store.byChat[chatId].slots)) {
                store.globalSlots[slotName] = slot;
            }
        } else if (!deletedSlotName) {
            delete store.byChat[chatId];
        }
    }

    persistSlotsBackupStore(store);
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

    const backupStore = loadSlotsBackupStore();
    let hasChatBoundSlots = Boolean(savedState && getSlotEntries(savedState).length > 0);

    if (!hasChatBoundSlots && chatId && backupStore.byChat[chatId]) {
        const recovered = migrateState(backupStore.byChat[chatId]);
        if (recovered && getSlotEntries(recovered).length > 0) {
            savedState = recovered;
            hasChatBoundSlots = true;
        }
    }

    const globalSlotEntries = Object.entries(backupStore.globalSlots)
        .filter(([k, v]) => isSafeSlotName(k) && v && typeof v === 'object' && v.prompts)
        .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));

    if (globalSlotEntries.length > 0) {
        if (!savedState || !savedState.slots) {
            savedState = {
                version: METADATA_VERSION,
                defaultSlot: globalSlotEntries[0][0],
                slots: {},
            };
        } else {
            savedState = {
                version: METADATA_VERSION,
                defaultSlot: savedState.defaultSlot,
                slots: Object.assign({}, savedState.slots),
            };
        }

        for (const [slotName, slotData] of globalSlotEntries) {
            if (hasOwnSlot(savedState.slots, slotName)) continue;
            if (Object.keys(savedState.slots).length >= MAX_SLOTS_PER_CHAT) break;
            savedState.slots[slotName] = slotData;
        }

        if (!savedState.defaultSlot || !hasOwnSlot(savedState.slots, savedState.defaultSlot)) {
            const first = getSlotEntries(savedState)[0];
            savedState.defaultSlot = first ? first[0] : null;
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
