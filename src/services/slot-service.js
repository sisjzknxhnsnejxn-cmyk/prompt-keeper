/**
 * Prompt Keeper - 存档槽位读写、恢复、删除与默认槽位设置服务
 */

import {
    LOG_PREFIX,
    MAX_SLOTS_PER_CHAT,
    METADATA_KEY,
    METADATA_VERSION,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { applyPromptStates } from '../core/prompt-applier.js';
import { checkDirtyState } from '../core/prompt-dirty-check.js';
import { readPromptStates } from '../core/prompt-reader.js';
import { loadPluginSettings } from '../core/settings.js';
import {
    findSlotName,
    getBestRestoreSlotName,
    getSavedStateFromCurrentChat,
    getSlotEntries,
    syncSlotBackupForChat,
} from '../core/state-migration.js';
import { updateStatusDisplay } from '../ui/status-bar.js';
import {
    hasOwnSlot,
    isPresetNameMatch,
    isSafeSlotName,
    normalizeSlotName,
} from '../utils/format.js';
import {
    getCtxSafe,
    persistChatMetadata,
    showConfirmPopup,
    showInputPopup,
} from '../utils/st-context.js';
import {
    getCurrentPresetName,
    refreshPromptManagerUIUntilStable,
    switchToPreset,
    waitForPromptStatesReady,
} from './preset-service.js';

export function hasSavedState() {
    try {
        const { savedState } = getSavedStateFromCurrentChat();
        return getSlotEntries(savedState).length > 0;
    } catch (_) {
        return false;
    }
}

/**
 * 判断当前打开的聊天是否拥有绑定于该聊天的预设槽位（不含仅从全局兜底池合并的槽位）。
 * 专用于自动恢复判定，避免在欢迎页或无绑定存档的新聊天中误触发自动切换预设。
 */
export function hasChatBoundSavedState() {
    try {
        const ctx = getCtxSafe();
        if (!ctx || !ctx.chatId) return false;
        const { savedState } = getSavedStateFromCurrentChat();
        return Boolean(
            savedState &&
                savedState.__hasChatBoundSlots &&
                getSlotEntries(savedState).length > 0
        );
    } catch (_) {
        return false;
    }
}

export async function saveStatesToMetadata(slotNameOverride = null) {
    if (
        runtimeState.saveInProgress ||
        runtimeState.restoreInProgress ||
        runtimeState.deleteInProgress
    ) {
        console.debug(LOG_PREFIX, 'Save/Restore/Delete already in progress, ignoring duplicate call.');
        return false;
    }
    runtimeState.saveInProgress = true;

    let userCancelledPrompt = false;
    try {
        const ctx = getCtxSafe();
        const chatMetadata = ctx ? ctx.chatMetadata : null;
        const chatId = ctx ? ctx.chatId : null;

        if (!chatMetadata || !chatId) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('当前没有打开的聊天，无法保存预设状态。', 'Prompt Keeper');
            }
            return false;
        }

        const states = readPromptStates();
        if (!states || !states.prompts || Object.keys(states.prompts).length === 0) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('未能读取到任何预设条目状态。', 'Prompt Keeper');
            }
            return false;
        }

        const presetName = getCurrentPresetName();
        const defaultSlotName = normalizeSlotName(presetName);
        const settings = loadPluginSettings();
        let slotName = slotNameOverride ? normalizeSlotName(slotNameOverride) : defaultSlotName;

        if (!slotNameOverride && settings.customSaveName) {
            const rawInput = await showInputPopup('请输入此预设快照的保存名称：', defaultSlotName);
            if (rawInput === null) {
                userCancelledPrompt = true;
                return false;
            }
            slotName = normalizeSlotName(rawInput);
        }

        if (!isSafeSlotName(slotName)) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('该名称为系统保留关键字，请更换其它名称。', 'Prompt Keeper');
            }
            userCancelledPrompt = true;
            return false;
        }

        const { savedState } = getSavedStateFromCurrentChat();
        if (savedState && savedState.__futureVersion) {
            if (typeof toastr !== 'undefined') {
                toastr.error('当前聊天的存档格式来自更高版本插件，为防止数据损坏已禁止覆盖。', 'Prompt Keeper');
            }
            return false;
        }

        const nextState =
            savedState && savedState.version === METADATA_VERSION && savedState.slots
                ? {
                      version: METADATA_VERSION,
                      defaultSlot: savedState.defaultSlot,
                      slots: Object.assign({}, savedState.slots),
                  }
                : {
                      version: METADATA_VERSION,
                      defaultSlot: null,
                      slots: {},
                  };

        const existingKey = settings.customSaveName
            ? hasOwnSlot(nextState.slots, slotName) ? slotName : null
            : findSlotName(nextState, slotName, { preferExactSlotName: true }) || slotName;
        const targetSlotName = existingKey || slotName;
        const isExistingSlot = Boolean(hasOwnSlot(nextState.slots, targetSlotName));
        const currentSlotCount = getSlotEntries(nextState).length;

        if (!isExistingSlot && currentSlotCount >= MAX_SLOTS_PER_CHAT) {
            if (typeof toastr !== 'undefined') {
                toastr.warning(
                    `每个聊天最多保存 ${MAX_SLOTS_PER_CHAT} 个预设槽位，请先删除旧槽位或切换到已有预设覆盖保存。`,
                    'Prompt Keeper'
                );
            }
            return false;
        }

        nextState.slots[targetSlotName] = {
            prompts: Object.assign({}, states.prompts),
            promptOrder: states.promptOrder || null,
            presetName: presetName || targetSlotName,
            savedAt: Date.now(),
        };
        nextState.defaultSlot = targetSlotName;
        chatMetadata[METADATA_KEY] = nextState;
        syncSlotBackupForChat(chatId, nextState);

        runtimeState.justSavedChatId = chatId;
        runtimeState.lastHandledChatId = chatId;
        runtimeState.manualPresetOverrideChatId = null;
        if (runtimeState.autoRestoreTimer) {
            clearTimeout(runtimeState.autoRestoreTimer);
            runtimeState.autoRestoreTimer = null;
        }
        await persistChatMetadata();

        const count = Object.keys(states.prompts).length;
        const orderCount = states.promptOrder ? ' + 排列顺序' : '';
        const totalSlots = getSlotEntries(nextState).length;
        if (typeof toastr !== 'undefined') {
            toastr.success(
                `已保存到槽位「${targetSlotName}」（${count} 个条目开关${orderCount}，槽位 ${totalSlots}/${MAX_SLOTS_PER_CHAT}，已设为自动恢复默认）`,
                'Prompt Keeper'
            );
        }
        console.log(LOG_PREFIX, `Saved ${count} prompt states to slot "${targetSlotName}" (${totalSlots}/${MAX_SLOTS_PER_CHAT})`);
        updateStatusDisplay();
        return true;
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to save states:', e);
        if (typeof toastr !== 'undefined') {
            toastr.error('保存预设状态失败，请查看控制台。', 'Prompt Keeper');
        }
        return false;
    } finally {
        if (userCancelledPrompt) {
            runtimeState.saveInProgress = false;
        } else {
            setTimeout(() => {
                runtimeState.saveInProgress = false;
            }, 600);
        }
    }
}

export async function restoreStatesFromMetadata(
    manual = false,
    expectedChatId = null,
    slotName = null,
    options = {}
) {
    if (
        runtimeState.restoreInProgress ||
        runtimeState.saveInProgress ||
        runtimeState.deleteInProgress
    ) {
        console.debug(LOG_PREFIX, 'Restore/Save/Delete already in progress, ignoring duplicate restore call.');
        return false;
    }
    runtimeState.restoreInProgress = true;

    const allowPresetSwitch = options.allowPresetSwitch !== false;
    let chatIdAtStart = expectedChatId;

    try {
        try {
            const ctx = getCtxSafe();
            if (!chatIdAtStart) chatIdAtStart = ctx ? ctx.chatId : null;
        } catch (_) {}

        const { savedState } = getSavedStateFromCurrentChat();
        if (!savedState || !savedState.slots || getSlotEntries(savedState).length === 0) {
            if (manual && typeof toastr !== 'undefined') {
                toastr.info('当前聊天没有已保存的预设条目状态。', 'Prompt Keeper');
            }
            return false;
        }

        const currentPreset = getCurrentPresetName();
        const targetSlotName = getBestRestoreSlotName(savedState, slotName, currentPreset);
        const slotState =
            targetSlotName && hasOwnSlot(savedState.slots, targetSlotName)
                ? savedState.slots[targetSlotName]
                : null;

        if (!slotState || !slotState.prompts) {
            if (manual && typeof toastr !== 'undefined') {
                toastr.info('未找到可恢复的预设槽位。', 'Prompt Keeper');
            }
            return false;
        }

        if (manual) {
            runtimeState.manualPresetOverrideChatId = null;
            if (chatIdAtStart) {
                runtimeState.lastHandledChatId = chatIdAtStart;
            }
        }

        let dirty = checkDirtyState(slotState, {
            allowPresetSwitch,
            currentPresetName: currentPreset,
        });

        if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
            const ready = await waitForPromptStatesReady(chatIdAtStart, 900);
            if (!ready) {
                console.debug(LOG_PREFIX, 'Prompt states are not ready yet during clean check.');
                return false;
            }
            dirty = checkDirtyState(slotState, {
                allowPresetSwitch,
                currentPresetName: getCurrentPresetName(),
            });
        }

        if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
            console.log(LOG_PREFIX, `Slot "${targetSlotName}" is already in sync — skipping restore.`);
            if (manual && typeof toastr !== 'undefined') {
                toastr.info(`当前状态已与槽位「${targetSlotName}」一致，无需恢复。`, 'Prompt Keeper');
            }
            updateStatusDisplay();
            return true;
        }

        let presetReady = true;
        if (dirty.needsPresetSwitch && dirty.targetPreset) {
            const switched = await switchToPreset(dirty.targetPreset, chatIdAtStart);
            if (!switched) {
                presetReady = false;
                if (typeof toastr !== 'undefined') {
                    toastr.warning(
                        `未能切换到预设 "${dirty.targetPreset}"，将仅尝试恢复同名条目状态。`,
                        'Prompt Keeper'
                    );
                }
            }
        }

        if (chatIdAtStart) {
            const ctxMid = getCtxSafe();
            if (!ctxMid || ctxMid.chatId !== chatIdAtStart) {
                console.debug(LOG_PREFIX, 'Restore aborted after preset switch: chatId changed.');
                return false;
            }
        }

        const promptsReady = await waitForPromptStatesReady(chatIdAtStart);
        if (!promptsReady) {
            console.warn(LOG_PREFIX, 'Prompt states did not become ready in time for restore.');
            updateStatusDisplay();
            return false;
        }

        const { skipped, aborted } = applyPromptStates(slotState, chatIdAtStart);
        if (aborted) return false;

        const uiStable = await refreshPromptManagerUIUntilStable(slotState, chatIdAtStart);
        const postDirty = checkDirtyState(slotState, {
            allowPresetSwitch: allowPresetSwitch && presetReady,
            currentPresetName: getCurrentPresetName(),
        });
        const fullyRestored =
            uiStable &&
            !postDirty.needsEntryRestore &&
            (!allowPresetSwitch || !presetReady || !postDirty.needsPresetSwitch);

        const total = Object.keys(slotState.prompts).length;
        const applied = total - skipped.length;
        const orderNote = slotState.promptOrder ? ' + 排列顺序' : '';
        const presetLabel = slotState.presetName ? ` · 预设: ${slotState.presetName}` : '';

        if (skipped.length > 0) {
            if (typeof toastr !== 'undefined') {
                toastr.info(
                    `已恢复槽位「${targetSlotName}」(${applied}/${total} 个条目${orderNote}${presetLabel}，${skipped.length} 个条目在当前预设中不存在已跳过)`,
                    'Prompt Keeper'
                );
            }
        } else if (manual || fullyRestored) {
            if (typeof toastr !== 'undefined') {
                toastr.success(
                    `已恢复槽位「${targetSlotName}」(${applied} 个条目开关${orderNote}${presetLabel})`,
                    'Prompt Keeper'
                );
            }
        }

        console.log(
            LOG_PREFIX,
            `Restored ${applied}/${total} prompt states from slot "${targetSlotName}" (skipped: ${skipped.length}, stable: ${fullyRestored})`
        );
        updateStatusDisplay();
        return fullyRestored;
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to restore states:', e);
        if (typeof toastr !== 'undefined') {
            toastr.error('恢复预设状态失败，请查看控制台。', 'Prompt Keeper');
        }
        return false;
    } finally {
        runtimeState.restoreInProgress = false;
    }
}

export async function deleteSavedStates(slotName = null, skipConfirm = false) {
    if (
        runtimeState.saveInProgress ||
        runtimeState.restoreInProgress ||
        runtimeState.deleteInProgress
    ) {
        console.debug(LOG_PREFIX, 'Save/Restore/Delete in progress, ignoring delete call.');
        return false;
    }
    runtimeState.deleteInProgress = true;

    try {
        const ctx = getCtxSafe();
        const chatId = ctx ? ctx.chatId : null;
        const { chatMetadata, savedState } = getSavedStateFromCurrentChat();
        const entries = getSlotEntries(savedState);

        if (!savedState || entries.length === 0) {
            if (typeof toastr !== 'undefined') {
                toastr.info('当前聊天没有已保存的预设条目状态。', 'Prompt Keeper');
            }
            return false;
        }

        if (savedState.__futureVersion) {
            if (typeof toastr !== 'undefined') {
                toastr.error('当前聊天的存档格式来自更高版本插件，为防止数据损坏已禁止修改。', 'Prompt Keeper');
            }
            return false;
        }

        const currentPreset = getCurrentPresetName();
        let targetSlot = slotName;
        if (!targetSlot && entries.length === 1) {
            targetSlot = entries[0][0];
        } else if (!targetSlot && currentPreset) {
            targetSlot = findSlotName(savedState, currentPreset);
        }

        if (targetSlot && hasOwnSlot(savedState.slots, targetSlot)) {
            if (!skipConfirm) {
                const confirmed = await showConfirmPopup(`确定要删除槽位「${targetSlot}」的保存状态吗？`);
                if (!confirmed) return false;
            }

            delete savedState.slots[targetSlot];
            const remaining = getSlotEntries(savedState);
            if (remaining.length === 0) {
                if (chatMetadata) delete chatMetadata[METADATA_KEY];
                syncSlotBackupForChat(chatId, null, { deletedSlotName: targetSlot });
            } else {
                if (savedState.defaultSlot === targetSlot) {
                    savedState.defaultSlot = remaining[0][0];
                }
                if (chatMetadata) chatMetadata[METADATA_KEY] = savedState;
                syncSlotBackupForChat(chatId, savedState, { deletedSlotName: targetSlot });
            }

            await persistChatMetadata();
            if (typeof toastr !== 'undefined') {
                toastr.info(`已删除槽位「${targetSlot}」的保存状态。`, 'Prompt Keeper');
            }
            console.log(LOG_PREFIX, `Deleted slot "${targetSlot}" for current chat.`);
            updateStatusDisplay();
            return true;
        }

        if (!skipConfirm) {
            const confirmed = await showConfirmPopup(
                `确定要清空此聊天的全部 ${entries.length} 个预设槽位吗？`
            );
            if (!confirmed) return false;
        }

        if (chatMetadata) delete chatMetadata[METADATA_KEY];
        syncSlotBackupForChat(chatId, null, { clearAllForChat: true });
        await persistChatMetadata();
        if (typeof toastr !== 'undefined') {
            toastr.info('已清除此聊天的全部已保存预设状态。', 'Prompt Keeper');
        }
        console.log(LOG_PREFIX, 'Deleted all saved states for current chat.');
        updateStatusDisplay();
        return true;
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to delete saved states:', e);
        return false;
    } finally {
        runtimeState.deleteInProgress = false;
    }
}

export async function setDefaultSlot(slotName) {
    try {
        const ctx = getCtxSafe();
        const chatId = ctx ? ctx.chatId : null;
        const { chatMetadata, savedState } = getSavedStateFromCurrentChat();
        if (!savedState || !savedState.slots || !hasOwnSlot(savedState.slots, slotName)) {
            return false;
        }
        if (savedState.__futureVersion) {
            if (typeof toastr !== 'undefined') {
                toastr.error('当前聊天的存档格式来自更高版本插件，为防止数据损坏已禁止修改。', 'Prompt Keeper');
            }
            return false;
        }

        savedState.defaultSlot = slotName;
        if (chatMetadata) chatMetadata[METADATA_KEY] = savedState;
        syncSlotBackupForChat(chatId, savedState);
        await persistChatMetadata();

        if (typeof toastr !== 'undefined') {
            toastr.success(`已将「${slotName}」设为打开此聊天时的自动恢复槽位。`, 'Prompt Keeper');
        }
        updateStatusDisplay();
        return true;
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to set default slot:', e);
        return false;
    }
}

