// ========== Main Init ==========

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

    eventSource.on(eventTypes.APP_READY, () => {
        if (promptKeeperAppReadyHandled) return;
        promptKeeperAppReadyHandled = true;
        loadSettingsPanel();
        tryInjectUI();
        startUIObserver();
        requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
        console.log(LOG_PREFIX, 'Plugin v2.0.3 initialized (APP_READY).');
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (jQuery('#prompt-keeper-bar').length === 0) {
            tryInjectUI(5, 500);
        }
        onChatChanged();
    });

    if (eventTypes.CHAT_LOADED) {
        eventSource.on(eventTypes.CHAT_LOADED, onChatLoaded);
    }

    if (eventTypes.PRESET_CHANGED) {
        eventSource.on(eventTypes.PRESET_CHANGED, onPresetChanged);
    }

    if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
        eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, onPresetChanged);
    }

    if (eventTypes.MAIN_API_CHANGED) {
        eventSource.on(eventTypes.MAIN_API_CHANGED, onMainApiChanged);
    }

    console.log(LOG_PREFIX, 'Plugin v2.0.3 loaded, waiting for APP_READY...');
}

_pkInit();
