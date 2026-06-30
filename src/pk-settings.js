// ========== Settings ==========

function getCtx() {
    return SillyTavern.getContext();
}

function loadPluginSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    if (!ctx.extensionSettings[SETTINGS_KEY]) {
        ctx.extensionSettings[SETTINGS_KEY] = Object.assign({}, DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[SETTINGS_KEY];
    if (settings.autoRestore === undefined) settings.autoRestore = DEFAULT_SETTINGS.autoRestore;
    if (settings.customSaveName === undefined) settings.customSaveName = DEFAULT_SETTINGS.customSaveName;
    if (settings.autoRestoreDelay === undefined) settings.autoRestoreDelay = DEFAULT_SETTINGS.autoRestoreDelay;
    if (!['dark', 'light'].includes(settings.slotPickerTheme)) settings.slotPickerTheme = DEFAULT_SETTINGS.slotPickerTheme;
    return settings;
}

function savePluginSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) {
        ctx.saveSettingsDebounced();
    }
}

function persistChatMetadata() {
    const ctx = getCtx();
    if (typeof ctx.saveMetadata === 'function') {
        return ctx.saveMetadata();
    }
    if (typeof ctx.saveMetadataDebounced === 'function') {
        return ctx.saveMetadataDebounced();
    }
    return Promise.resolve();
}

function isPluginEnabled() {
    return loadPluginSettings().enabled !== false;
}

function isAutoRestoreEnabled() {
    const s = loadPluginSettings();
    return s.enabled !== false && s.autoRestore !== false;
}


