/**
 * Prompt Keeper - 聊天切换自动恢复与重试调度服务
 */

import {
    AUTO_RESTORE_MAX_RETRIES,
    AUTO_RESTORE_RETRY_DELAY_MS,
    DEFAULT_AUTO_RESTORE_DELAY_MS,
    LOG_PREFIX,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { isAutoRestoreEnabled, isPluginEnabled, loadPluginSettings } from '../core/settings.js';
import { getSavedStateFromCurrentChat, waitForChatContext } from '../core/state-migration.js';
import { updateStatusDisplay } from '../ui/status-bar.js';
import { scheduleEnsurePromptKeeperUI } from '../ui/ui-observer.js';
import { getCtxSafe, isChatCompletionActive } from '../utils/st-context.js';
import { hasChatBoundSavedState, restoreStatesFromMetadata } from './slot-service.js';

/**
 * 当用户在当前聊天主动手动切换预设时调用：
 * 锁定当前会话不再触发自动恢复，防止后续点正则生效（触发 reloadCurrentChat -> CHAT_CHANGED）或挂起的定时器把预设拉回旧存档。
 */
export function onUserPresetChanged(source = 'preset_change') {
    if (
        runtimeState.internalPresetSwitchInProgress ||
        runtimeState.restoreInProgress ||
        runtimeState.saveInProgress
    ) {
        return;
    }

    const ctx = getCtxSafe();
    const currentChatId = ctx && ctx.chatId ? ctx.chatId : runtimeState.lastHandledChatId;
    if (currentChatId) {
        runtimeState.manualPresetOverrideChatId = currentChatId;
        runtimeState.lastHandledChatId = currentChatId;
        delete runtimeState.autoRestoreRetryCountByChatId[currentChatId];
    }

    if (runtimeState.autoRestoreTimer) {
        clearTimeout(runtimeState.autoRestoreTimer);
        runtimeState.autoRestoreTimer = null;
        console.debug(LOG_PREFIX, `Cancelled pending auto-restore due to manual preset change (${source}).`);
    }

    updateStatusDisplay();
}

export function scheduleAutoRestoreRetry(chatId, reason) {
    if (!chatId || !isAutoRestoreEnabled()) return;
    if (runtimeState.manualPresetOverrideChatId === chatId || runtimeState.justSavedChatId === chatId) {
        return;
    }

    const currentRetry = runtimeState.autoRestoreRetryCountByChatId[chatId] || 0;
    if (currentRetry >= AUTO_RESTORE_MAX_RETRIES) {
        console.warn(LOG_PREFIX, `Auto-restore retry limit reached for chat ${chatId} (${reason}).`);
        return;
    }

    const nextRetry = currentRetry + 1;
    runtimeState.autoRestoreRetryCountByChatId[chatId] = nextRetry;
    console.debug(
        LOG_PREFIX,
        `Scheduling auto-restore retry ${nextRetry}/${AUTO_RESTORE_MAX_RETRIES} for chat ${chatId} (${reason}) in ${AUTO_RESTORE_RETRY_DELAY_MS}ms`
    );

    if (runtimeState.autoRestoreTimer) {
        clearTimeout(runtimeState.autoRestoreTimer);
        runtimeState.autoRestoreTimer = null;
    }

    runtimeState.autoRestoreTimer = setTimeout(async () => {
        runtimeState.autoRestoreTimer = null;

        try {
            const ctx = getCtxSafe();
            if (!ctx || ctx.chatId !== chatId || !isAutoRestoreEnabled()) return;
            if (runtimeState.manualPresetOverrideChatId === chatId || runtimeState.justSavedChatId === chatId) {
                return;
            }

            const contextReady = await waitForChatContext(chatId, 2000);
            if (!contextReady || !hasChatBoundSavedState()) return;
            if (runtimeState.manualPresetOverrideChatId === chatId || runtimeState.justSavedChatId === chatId) {
                return;
            }

            const restored = await restoreStatesFromMetadata(false, chatId);
            if (restored) {
                delete runtimeState.autoRestoreRetryCountByChatId[chatId];
            } else {
                scheduleAutoRestoreRetry(chatId, 'restore returned false');
            }
        } catch (e) {
            console.warn(LOG_PREFIX, 'Auto-restore retry failed:', e);
        }
    }, AUTO_RESTORE_RETRY_DELAY_MS);
}

export function onChatChanged() {
    if (!isPluginEnabled()) return;

    scheduleEnsurePromptKeeperUI('chatChanged');

    let chatIdAtEvent = null;
    try {
        const ctx = getCtxSafe();
        chatIdAtEvent = ctx ? ctx.chatId : null;
    } catch (_) {}

    // 同一聊天内重复触发 CHAT_CHANGED（例如点击正则生效触发 reloadCurrentChat()）：
    // 只刷新顶栏状态，绝不重新触发自动恢复把用户切好的新预设拉回旧预设！
    if (
        chatIdAtEvent &&
        (chatIdAtEvent === runtimeState.lastHandledChatId ||
            chatIdAtEvent === runtimeState.manualPresetOverrideChatId)
    ) {
        runtimeState.lastHandledChatId = chatIdAtEvent;
        console.debug(LOG_PREFIX, `Duplicate CHAT_CHANGED for "${chatIdAtEvent}" (e.g. regex reload), refreshing status only.`);
        updateStatusDisplay();
        return;
    }

    if (runtimeState.autoRestoreTimer) {
        clearTimeout(runtimeState.autoRestoreTimer);
        runtimeState.autoRestoreTimer = null;
    }

    // 真正切换到了另一个不同的聊天，重置会话级保护锁
    runtimeState.lastHandledChatId = chatIdAtEvent;
    runtimeState.manualPresetOverrideChatId = null;
    runtimeState.justSavedChatId = null;

    if (!isAutoRestoreEnabled()) {
        updateStatusDisplay();
        return;
    }

    const settings = loadPluginSettings();
    const delayMs =
        typeof settings.autoRestoreDelay === 'number' && settings.autoRestoreDelay >= 300
            ? settings.autoRestoreDelay
            : DEFAULT_AUTO_RESTORE_DELAY_MS;

    runtimeState.autoRestoreTimer = setTimeout(async () => {
        runtimeState.autoRestoreTimer = null;

        let targetChatId = chatIdAtEvent;
        try {
            const ctxNow = getCtxSafe();
            if (ctxNow && ctxNow.chatId) {
                targetChatId = ctxNow.chatId;
            }
        } catch (_) {}

        if (!targetChatId) {
            updateStatusDisplay();
            return;
        }

        // 同步记录实际落定的 chatId，防止启动时 chatIdAtEvent 为空而落定后点正则误触发
        runtimeState.lastHandledChatId = targetChatId;

        if (
            runtimeState.manualPresetOverrideChatId === targetChatId ||
            runtimeState.justSavedChatId === targetChatId
        ) {
            console.debug(LOG_PREFIX, `Auto-restore skipped for "${targetChatId}": user override or just saved.`);
            updateStatusDisplay();
            return;
        }

        if (!isChatCompletionActive()) {
            console.debug(LOG_PREFIX, 'Auto-restore skipped: current mainApi is not openai.');
            updateStatusDisplay();
            return;
        }

        const contextReady = await waitForChatContext(targetChatId);
        if (!contextReady) {
            console.debug(LOG_PREFIX, `Auto-restore skipped: chat context did not settle in time for "${targetChatId}".`);
            updateStatusDisplay();
            scheduleAutoRestoreRetry(targetChatId, 'context not settled');
            return;
        }

        if (
            runtimeState.manualPresetOverrideChatId === targetChatId ||
            runtimeState.justSavedChatId === targetChatId
        ) {
            updateStatusDisplay();
            return;
        }

        if (hasChatBoundSavedState()) {
            const { savedState } = getSavedStateFromCurrentChat();
            const defaultSlotName = savedState ? savedState.defaultSlot : null;
            console.log(
                LOG_PREFIX,
                `Chat changed — auto-restoring prompt states${defaultSlotName ? ` (default slot: ${defaultSlotName})` : ''}...`
            );
            const restored = await restoreStatesFromMetadata(false, targetChatId, defaultSlotName);
            if (restored) {
                delete runtimeState.autoRestoreRetryCountByChatId[targetChatId];
            } else {
                scheduleAutoRestoreRetry(targetChatId, 'initial restore incomplete');
            }
        } else {
            updateStatusDisplay();
        }
    }, delayMs);
}
