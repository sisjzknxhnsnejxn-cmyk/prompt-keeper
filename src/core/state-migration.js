/**
 * Prompt Keeper - 聊天元数据版本迁移与槽位查询
 */

import {
    AUTO_RESTORE_CONTEXT_POLL_MS,
    AUTO_RESTORE_CONTEXT_TIMEOUT_MS,
    LOG_PREFIX,
    METADATA_KEY,
    METADATA_VERSION,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { pkScheduleIdleTask } from '../utils/dom-events.js';
import { hasOwnSlot, isSafeSlotName, normalizePresetKey, normalizeSlotName } from '../utils/format.js';
import { getCtxSafe, persistChatMetadata } from '../utils/st-context.js';
import { loadPluginSettings } from './settings.js';

function sanitizeSlotsMap(rawSlots) {
    const cleanSlots = Object.create(null);
    if (!rawSlots || typeof rawSlots !== 'object') return cleanSlots;

    for (const [key, value] of Object.entries(rawSlots)) {
        if (!isSafeSlotName(key)) continue;
        if (!value || typeof value !== 'object') continue;
        cleanSlots[key] = value;
    }
    return cleanSlots;
}

export function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    if (raw.version === 2 && raw.slots && typeof raw.slots === 'object') {
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
        const slots = Object.create(null);
        slots[slotName] = {
            prompts: raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : {},
            promptOrder: raw.promptOrder || null,
            presetName: raw.presetName || slotName,
            savedAt: raw.savedAt || null,
        };
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

export function persistMigratedStateIfNeeded(chatMetadata, rawState, migratedState, options = {}) {
    if (!chatMetadata || !rawState || !migratedState || migratedState.__futureVersion) return;
    if (rawState.version === METADATA_VERSION && rawState.slots) return;

    chatMetadata[METADATA_KEY] = migratedState;

    const persist = () => {
        runtimeState.migratedStatePersistTimer = null;
        runtimeState.migratedStatePersistIdleId = null;
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

export function getSavedStateFromCurrentChat() {
    const ctx = getCtxSafe();
    const chatMetadata = ctx ? ctx.chatMetadata : null;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);
    persistMigratedStateIfNeeded(chatMetadata, rawState, savedState, { deferred: true });
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
