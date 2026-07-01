// ========== Main Init ==========

function bindPromptKeeperEvent(eventSource, eventType, handler) {
    if (!eventSource || !eventType || typeof eventSource.on !== 'function') return;
    eventSource.on(eventType, handler);
    promptKeeperEventBindings.push({ eventSource, eventType, handler });
}

function unbindPromptKeeperEvents() {
    for (const binding of promptKeeperEventBindings) {
        const { eventSource, eventType, handler } = binding;
        try {
            if (eventSource && typeof eventSource.off === 'function') {
                eventSource.off(eventType, handler);
            } else if (eventSource && typeof eventSource.removeListener === 'function') {
                eventSource.removeListener(eventType, handler);
            }
        } catch (error) {
            console.debug(LOG_PREFIX, `Failed to unbind event ${eventType}:`, error);
        }
    }
    promptKeeperEventBindings = [];
}

function onPromptKeeperAppReady() {
    if (promptKeeperAppReadyHandled) return;
    promptKeeperAppReadyHandled = true;
    ensurePromptKeeperUI('app_ready');
    schedulePromptKeeperUIEnsure('app_ready');
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
    console.log(LOG_PREFIX, 'Plugin v3.0.0 initialized (APP_READY).');
}

function destroyPromptKeeper(reason = 'manual') {
    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
    }
    if (observerThrottleTimer) {
        clearTimeout(observerThrottleTimer);
        observerThrottleTimer = null;
    }
    if (observerReinjectionResetTimer) {
        clearTimeout(observerReinjectionResetTimer);
        observerReinjectionResetTimer = null;
    }
    if (migratedStatePersistTimer) {
        clearTimeout(migratedStatePersistTimer);
        migratedStatePersistTimer = null;
    }
    if (migratedStatePersistIdleId) {
        pkCancelIdleTask(migratedStatePersistIdleId);
        migratedStatePersistIdleId = null;
    }
    clearPromptKeeperUIEnsureTimers();
    stopPcUIWatchdog();
    if (observerRafId) {
        cancelAnimationFrame(observerRafId);
        observerRafId = null;
    }
    if (statusDisplayRafId) {
        cancelAnimationFrame(statusDisplayRafId);
        statusDisplayRafId = null;
    }
    if (uiObserver) {
        uiObserver.disconnect();
        uiObserver = null;
    }

    for (const eventType of ['pointerup', 'touchend', 'click']) {
        document.removeEventListener(eventType, onPromptKeeperButtonPress, true);
        document.removeEventListener(eventType, onPromptKeeperButtonPress, false);
    }

    jQuery(PROMPT_KEEPER_BUTTON_SELECTOR).each(function () {
        for (const eventType of ['pointerup', 'touchend', 'click']) {
            this.removeEventListener(eventType, onPromptKeeperButtonPress, true);
            this.removeEventListener(eventType, onPromptKeeperButtonPress, false);
        }
        this.removeEventListener('keydown', onPromptKeeperButtonKeyDown, false);
    });

    jQuery(document).off('.promptKeeper');
    jQuery('#prompt-keeper-settings').remove();
    jQuery('#prompt-keeper-bar').remove();
    closeSlotPicker();
    unbindPromptKeeperEvents();

    lastHandledChatId = null;
    autoRestoreRetryCountByChatId = {};
    justSavedChatId = null;
    observerPaused = false;
    dragListenersBound = false;
    promptKeeperButtonDelegationBound = false;
    promptKeeperButtonDelegatedEvents = '';
    promptKeeperEventHandlersBound = false;
    promptKeeperAppReadyHandled = false;
    promptKeeperRefreshingUI = false;
    uiInjectInProgress = false;
    pendingStatusDisplay = null;
    lastStatusDisplaySignature = '';
    saveInProgress = false;
    lastButtonActionById = {};

    console.info(LOG_PREFIX, `Runtime destroyed (${reason}).`);
}

function _pkInit() {
    if (promptKeeperEventHandlersBound) {
        console.debug(LOG_PREFIX, 'Init skipped: event handlers already bound.');
        return;
    }

    let ctx;
    try {
        ctx = getCtx();
    } catch (_) {
        console.warn(LOG_PREFIX, 'SillyTavern global not ready. Will retry in 2s.');
        setTimeout(_pkInit, 2000);
        return;
    }

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types;

    if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
        console.error(LOG_PREFIX, 'SillyTavern context is incomplete (eventSource or event_types missing). Plugin cannot initialize. Will retry in 2s.');
        setTimeout(_pkInit, 2000);
        return;
    }

    promptKeeperEventHandlersBound = true;

    bindPromptKeeperEvent(eventSource, eventTypes.APP_READY, onPromptKeeperAppReady);

    bindPromptKeeperEvent(eventSource, eventTypes.CHAT_CHANGED, () => {
        schedulePromptKeeperUIEnsure('chat_changed');
        onChatChanged();
    });

    if (eventTypes.CHAT_LOADED) {
        bindPromptKeeperEvent(eventSource, eventTypes.CHAT_LOADED, () => {
            schedulePromptKeeperUIEnsure('chat_loaded');
            onChatLoaded();
        });
    }

    if (eventTypes.PRESET_CHANGED) {
        bindPromptKeeperEvent(eventSource, eventTypes.PRESET_CHANGED, onPresetChanged);
    }

    if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
        bindPromptKeeperEvent(eventSource, eventTypes.OAI_PRESET_CHANGED_AFTER, onPresetChanged);
    }

    if (eventTypes.MAIN_API_CHANGED) {
        bindPromptKeeperEvent(eventSource, eventTypes.MAIN_API_CHANGED, onMainApiChanged);
    }

    console.log(LOG_PREFIX, 'Plugin v3.0.0 loaded, waiting for APP_READY...');
}

_pkInit();
