// ========== Prompt Keeper World Book Main ==========

function wbkBindEvent(eventSource, eventType, handler) {
    if (!eventSource || !eventType || typeof eventSource.on !== 'function') return;
    eventSource.on(eventType, handler);
    wbkEventBindings.push({ eventSource, eventType, handler });
}

function wbkUnbindEvents() {
    for (const binding of wbkEventBindings) {
        const { eventSource, eventType, handler } = binding;
        try {
            if (eventSource && typeof eventSource.off === 'function') eventSource.off(eventType, handler);
            else if (eventSource && typeof eventSource.removeListener === 'function') eventSource.removeListener(eventType, handler);
        } catch (error) {
            console.debug(WBK_LOG_PREFIX, `Failed to unbind event ${eventType}:`, error);
        }
    }
    wbkEventBindings = [];
}

function wbkOnAppReady() {
    if (wbkAppReadyHandled) return;
    wbkAppReadyHandled = true;
    wbkEnsureUI('app_ready');
    wbkScheduleUIEnsure('app_ready');
    console.log(WBK_LOG_PREFIX, 'World book module initialized.');
}

function wbkOnChatChanged(source = 'chat_changed') {
    if (!wbkIsEnabled()) {
        wbkRemoveUI();
        return;
    }
    const ctx = wbkGetCtx();
    const chatId = ctx.chatId;
    wbkScheduleUIEnsure(source);
    wbkUpdateStatusDisplay(wbkHasSavedState(), wbkGetSavedAt());
    if (!chatId) return;
    if (wbkLastHandledChatId !== chatId) {
        wbkLastHandledChatId = chatId;
        wbkAutoRestoreRetryCountByChatId = {};
    }
    wbkScheduleRestoreForCurrentChat(source);
}

function wbkScheduleRestoreForCurrentChat(source = 'chat_changed', retryAttempt = 0) {
    if (!wbkIsEnabled()) return;
    const ctx = wbkGetCtx();
    const chatId = ctx.chatId;
    if (!chatId) return;

    if (wbkAutoRestoreTimer) {
        clearTimeout(wbkAutoRestoreTimer);
        wbkAutoRestoreTimer = null;
    }

    const delay = retryAttempt > 0 ? WBK_AUTO_RESTORE_RETRY_DELAY_MS : WBK_AUTO_RESTORE_DELAY_MS;
    wbkAutoRestoreTimer = setTimeout(async () => {
        wbkAutoRestoreTimer = null;
        if (!wbkIsEnabled() || wbkGetCtx().chatId !== chatId) return;

        const hasSave = wbkHasSavedState();
        requestAnimationFrame(() => wbkUpdateStatusDisplay(hasSave, wbkGetSavedAt()));
        if (!hasSave || !wbkIsAutoRestoreEnabled() || wbkJustSavedChatId === chatId) return;

        const restored = await wbkRestoreStatesFromMetadata(true, null, { autoRestore: true });
        if (restored) {
            wbkAutoRestoreRetryCountByChatId[chatId] = 0;
            return;
        }

        const usedRetries = Number(wbkAutoRestoreRetryCountByChatId[chatId] || 0);
        if (wbkGetCtx().chatId === chatId && usedRetries < WBK_AUTO_RESTORE_MAX_RETRIES) {
            wbkAutoRestoreRetryCountByChatId[chatId] = usedRetries + 1;
            console.warn(WBK_LOG_PREFIX, `Auto-restore failed for ${chatId}; retrying (${usedRetries + 1}/${WBK_AUTO_RESTORE_MAX_RETRIES}).`);
            wbkScheduleRestoreForCurrentChat(`${source}_retry`, usedRetries + 1);
        }
    }, delay);
}

function wbkDestroyPromptKeeper(reason = 'manual') {
    if (wbkAutoRestoreTimer) {
        clearTimeout(wbkAutoRestoreTimer);
        wbkAutoRestoreTimer = null;
    }
    wbkClearUIEnsureTimers();
    jQuery(document).off('.promptKeeperWorldBookButtons');
    jQuery(document).off('.promptKeeperWorldBookSettings');
    jQuery('#prompt-keeper-world-book-settings').remove();
    jQuery('#prompt-keeper-world-book-bar').remove();
    wbkCloseSlotPicker();
    wbkUnbindEvents();
    wbkEventHandlersBound = false;
    wbkAppReadyHandled = false;
    wbkLastHandledChatId = null;
    wbkJustSavedChatId = null;
    wbkSaveInProgress = false;
    wbkLastButtonActionById = {};
    wbkLastInteractionByKey = {};
    wbkAutoRestoreRetryCountByChatId = {};
    console.info(WBK_LOG_PREFIX, `World book runtime destroyed (${reason}).`);
}

function _wbkInit() {
    if (wbkEventHandlersBound) return;
    let ctx;
    try {
        ctx = wbkGetCtx();
    } catch (_) {
        setTimeout(_wbkInit, 2000);
        return;
    }

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types || {};
    if (!eventSource || typeof eventSource.on !== 'function') {
        setTimeout(_wbkInit, 2000);
        return;
    }

    wbkEventHandlersBound = true;
    wbkBindEvent(eventSource, eventTypes.APP_READY, wbkOnAppReady);
    wbkBindEvent(eventSource, eventTypes.CHAT_CHANGED, () => wbkOnChatChanged('chat_changed'));
    if (eventTypes.CHAT_LOADED) wbkBindEvent(eventSource, eventTypes.CHAT_LOADED, () => wbkOnChatChanged('chat_loaded'));
    if (eventTypes.CHAT_COMPLETION_PROMPT_READY) wbkBindEvent(eventSource, eventTypes.CHAT_COMPLETION_PROMPT_READY, () => wbkOnChatChanged('prompt_ready'));
    if (eventTypes.WORLDINFO_SETTINGS_UPDATED) wbkBindEvent(eventSource, eventTypes.WORLDINFO_SETTINGS_UPDATED, () => wbkScheduleUIEnsure('worldinfo_settings_updated'));
    wbkScheduleUIEnsure('init_fallback');
}

_wbkInit();
