/**
 * Prompt Keeper - 集中式运行时可变状态管理
 * 统一管理异步互斥锁、定时器句柄、DOM 观察器与事件绑定，确保热重载与销毁时零泄漏。
 */

import { pkCancelIdleTask } from '../utils/dom-events.js';

export const runtimeState = {
    // 自动恢复与聊天追踪状态
    autoRestoreTimer: null,
    autoRestoreRetryCountByChatId: Object.create(null),
    lastHandledChatId: null,
    justSavedChatId: null,
    manualPresetOverrideChatId: null,
    internalPresetSwitchInProgress: false,

    // 异步操作互斥锁（防止保存、恢复、删除并发踩踏底层状态）
    saveInProgress: false,
    restoreInProgress: false,
    deleteInProgress: false,

    // 元数据迁移延迟持久化定时器
    migratedStatePersistTimer: null,
    migratedStatePersistIdleId: null,

    // UI 注入与 Observer 状态
    uiObserver: null,
    observerThrottleTimer: null,
    observerPaused: false,
    dragListenersBound: false,
    observerRafId: null,
    observerReinjectionCount: 0,
    observerReinjectionResetTimer: null,
    uiEnsureTimers: [],
    uiRetryTimer: null,
    pcUIWatchdogTimer: null,
    uiInjectInProgress: false,
    lastUIInjectAt: 0,

    // 顶栏状态显示与按钮事件防抖状态
    statusDisplayRafId: null,
    pendingStatusDisplay: null,
    lastStatusDisplaySignature: '',
    lastButtonActionById: Object.create(null),
    promptKeeperButtonDelegationBound: false,
    promptKeeperButtonDelegatedEvents: '',
    touchStartCoords: null,
    documentTouchTrackingBound: false,

    // 模态框键盘监听清理函数
    modalEscapeCleanup: null,

    // 插件主生命周期与事件绑定状态
    initRetryTimer: null,
    promptKeeperEventHandlersBound: false,
    promptKeeperAppReadyHandled: false,
    promptKeeperRefreshingUI: false,
    promptKeeperEventBindings: [],
};

/**
 * 清理所有 UI 确保定时器
 */
export function clearUIEnsureTimers() {
    for (const timer of runtimeState.uiEnsureTimers) {
        clearTimeout(timer);
    }
    runtimeState.uiEnsureTimers = [];

    if (runtimeState.uiRetryTimer) {
        clearTimeout(runtimeState.uiRetryTimer);
        runtimeState.uiRetryTimer = null;
    }
}

/**
 * 清理所有定时器、动画帧并重置全部运行时状态
 */
export function resetRuntimeState() {
    if (runtimeState.initRetryTimer) {
        clearTimeout(runtimeState.initRetryTimer);
        runtimeState.initRetryTimer = null;
    }
    if (runtimeState.autoRestoreTimer) {
        clearTimeout(runtimeState.autoRestoreTimer);
        runtimeState.autoRestoreTimer = null;
    }
    if (runtimeState.observerThrottleTimer) {
        clearTimeout(runtimeState.observerThrottleTimer);
        runtimeState.observerThrottleTimer = null;
    }
    if (runtimeState.observerReinjectionResetTimer) {
        clearTimeout(runtimeState.observerReinjectionResetTimer);
        runtimeState.observerReinjectionResetTimer = null;
    }
    if (runtimeState.migratedStatePersistTimer) {
        clearTimeout(runtimeState.migratedStatePersistTimer);
        runtimeState.migratedStatePersistTimer = null;
    }
    if (runtimeState.migratedStatePersistIdleId) {
        pkCancelIdleTask(runtimeState.migratedStatePersistIdleId);
        runtimeState.migratedStatePersistIdleId = null;
    }

    clearUIEnsureTimers();

    if (runtimeState.pcUIWatchdogTimer) {
        clearInterval(runtimeState.pcUIWatchdogTimer);
        runtimeState.pcUIWatchdogTimer = null;
    }
    if (runtimeState.observerRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(runtimeState.observerRafId);
        runtimeState.observerRafId = null;
    }
    if (runtimeState.statusDisplayRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(runtimeState.statusDisplayRafId);
        runtimeState.statusDisplayRafId = null;
    }
    if (runtimeState.uiObserver) {
        runtimeState.uiObserver.disconnect();
        runtimeState.uiObserver = null;
    }
    if (typeof runtimeState.modalEscapeCleanup === 'function') {
        runtimeState.modalEscapeCleanup();
        runtimeState.modalEscapeCleanup = null;
    }

    runtimeState.autoRestoreRetryCountByChatId = Object.create(null);
    runtimeState.lastHandledChatId = null;
    runtimeState.justSavedChatId = null;
    runtimeState.manualPresetOverrideChatId = null;
    runtimeState.internalPresetSwitchInProgress = false;
    runtimeState.saveInProgress = false;
    runtimeState.restoreInProgress = false;
    runtimeState.deleteInProgress = false;
    runtimeState.observerPaused = false;
    runtimeState.dragListenersBound = false;
    runtimeState.observerReinjectionCount = 0;
    runtimeState.uiInjectInProgress = false;
    runtimeState.lastUIInjectAt = 0;
    runtimeState.pendingStatusDisplay = null;
    runtimeState.lastStatusDisplaySignature = '';
    runtimeState.lastButtonActionById = Object.create(null);
    runtimeState.promptKeeperButtonDelegationBound = false;
    runtimeState.promptKeeperButtonDelegatedEvents = '';
    runtimeState.touchStartCoords = null;
    runtimeState.documentTouchTrackingBound = false;
    runtimeState.promptKeeperEventHandlersBound = false;
    runtimeState.promptKeeperAppReadyHandled = false;
    runtimeState.promptKeeperRefreshingUI = false;
}
