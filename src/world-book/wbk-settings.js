// ========== Prompt Keeper World Book Settings ==========

function wbkGetCtx() {
    return SillyTavern.getContext();
}

function wbkLoadSettings() {
    const ctx = wbkGetCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings[WBK_SETTINGS_KEY]) {
        ctx.extensionSettings[WBK_SETTINGS_KEY] = Object.assign({}, WBK_DEFAULT_SETTINGS);
    }

    const settings = ctx.extensionSettings[WBK_SETTINGS_KEY];
    for (const [key, value] of Object.entries(WBK_DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    if (!['dark', 'light'].includes(settings.slotPickerTheme)) {
        settings.slotPickerTheme = WBK_DEFAULT_SETTINGS.slotPickerTheme;
    }
    if (!WBK_SELECTED_BOOKS_RESTORE_MODES.includes(settings.selectedBooksRestoreMode)) {
        settings.selectedBooksRestoreMode = WBK_DEFAULT_SETTINGS.selectedBooksRestoreMode;
    }
    return settings;
}

function wbkSaveSettings() {
    const ctx = wbkGetCtx();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function wbkPersistChatMetadata() {
    const ctx = wbkGetCtx();
    if (typeof ctx.saveMetadata === 'function') return ctx.saveMetadata();
    if (typeof ctx.saveMetadataDebounced === 'function') return ctx.saveMetadataDebounced();
    return Promise.resolve();
}

function wbkIsEnabled() {
    return wbkLoadSettings().enabled !== false;
}

function wbkIsAutoRestoreEnabled() {
    const settings = wbkLoadSettings();
    return settings.enabled !== false && settings.autoRestore === true;
}

function wbkUniqueStrings(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
        const normalized = String(value || '').trim();
        if (!normalized || seen.has(normalized.toLowerCase())) continue;
        seen.add(normalized.toLowerCase());
        result.push(normalized);
    }
    return result;
}

function wbkNormalizeSlotName(name) {
    return String(name || '').trim() || '世界书配置';
}

function wbkIsSafeSlotName(slotName) {
    return !['__proto__', 'prototype', 'constructor'].includes(String(slotName || '').trim().toLowerCase());
}
