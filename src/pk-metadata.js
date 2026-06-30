function isSafeSlotName(slotName) {
    return !['__proto__', 'prototype', 'constructor'].includes(normalizePresetKey(slotName));
}

function getSaveSlotName(currentPresetName, existingSlots) {
    const settings = loadPluginSettings();
    const defaultSlotName = normalizeSlotName(currentPresetName);

    if (settings.customSaveName !== true) return defaultSlotName;

    const input = window.prompt('请输入本次保存的槽位名称：', defaultSlotName);
    if (input === null) return null;

    const slotName = normalizeSlotName(input);
    if (!slotName || !isSafeSlotName(slotName)) {
        toastr.warning('槽位名称不可用', 'Prompt Keeper');
        return null;
    }

    if (existingSlots && existingSlots[slotName]) {
        const confirmed = window.confirm(`槽位“${slotName}”已存在，是否覆盖？`);
        if (!confirmed) return null;
    }

    return slotName;
}

async function saveStatesToMetadata() {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    const existingRaw = chatMetadata[METADATA_KEY];
    if (existingRaw && typeof existingRaw === 'object' && existingRaw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Refusing to overwrite metadata version ${existingRaw.version} with version ${METADATA_VERSION}. Please update the plugin.`);
        toastr.error(
            `请更新插件后保存`,
            '版本不兼容',
            { timeOut: 8000 }
        );
        return false;
    }

    const states = readPromptStates();
    if (!states) {
        toastr.warning('读取状态失败', 'Prompt Keeper');
        return false;
    }

    const presetName = normalizeSlotName(getCurrentPresetName());
    const now = Date.now();
    const migratedState = migrateState(existingRaw) || { version: METADATA_VERSION, defaultSlot: null, slots: {} };
    const slotEntries = getSlotEntries(migratedState);
    const slotName = getSaveSlotName(presetName, migratedState.slots);

    if (!slotName) {
        console.debug(LOG_PREFIX, 'Save cancelled: no slot name selected.');
        return false;
    }

    if (!migratedState.slots[slotName] && slotEntries.length >= MAX_SLOTS_PER_CHAT) {
        toastr.warning(`最多保存 ${MAX_SLOTS_PER_CHAT} 个槽位`, 'Prompt Keeper');
        return false;
    }

    const stateToSave = {
        prompts: states.prompts,
        savedAt: now,
        presetName,
    };
    if (states.promptOrder != null) stateToSave.promptOrder = states.promptOrder;

    migratedState.version = METADATA_VERSION;
    migratedState.slots[slotName] = stateToSave;
    migratedState.defaultSlot = slotName;

    chatMetadata[METADATA_KEY] = migratedState;

    persistChatMetadata();

    justSavedChatId = chatId;

    console.log(LOG_PREFIX, `Saved prompt states for chat: ${chatId}, slot: ${slotName}, preset: ${presetName}`);
    updateStatusDisplay(true, now);

    toastr.success(
        `已保存：${slotName}`,
        'Prompt Keeper',
        { timeOut: 3000 }
    );

    return true;
}

async function restoreStatesFromMetadata(silent = false, slotName = null, options = {}) {
    if (!isPluginEnabled()) return false;

    const ctx = getCtx();
    const chatId = ctx.chatId;
    const chatIdAtStart = chatId;
    const isAutoRestore = options.autoRestore === true;

    if (!chatId) {
        if (!silent) toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    let chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        if (!silent) toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    if (isAutoRestore) {
        const contextReady = await waitForChatContext(chatIdAtStart);
        if (!contextReady || getCtx().chatId !== chatIdAtStart) {
            console.warn(LOG_PREFIX, `Auto-restore aborted: chat context did not stabilize for chat ${chatIdAtStart}.`);
            return false;
        }
    }

    const savedContext = getSavedStateFromCurrentChat();
    chatMetadata = savedContext.chatMetadata;
    const savedState = savedContext.savedState;

    const slotEntries = getSlotEntries(savedState);
    if (!savedState || slotEntries.length === 0) {
        if (!silent) toastr.info('暂无保存配置', 'Prompt Keeper');
        return false;
    }

    const allowPresetSwitch = options.allowPresetSwitch !== undefined ? options.allowPresetSwitch : true;
    const targetSlotName = getBestRestoreSlotName(savedState, slotName);

    const targetSlot = targetSlotName && savedState.slots ? savedState.slots[targetSlotName] : null;
    if (!targetSlot || !targetSlot.prompts) {
        if (!silent) toastr.warning('槽位不可用', 'Prompt Keeper');
        return false;
    }

    if (isAutoRestore) {
        console.debug(LOG_PREFIX, 'Auto-restore is running silently.');
    }

    const isFutureVersion = savedState.__futureVersion === true;
    if (isFutureVersion) {
        console.warn(LOG_PREFIX, `Restoring from future version data (v${savedState.version}). Results may be incomplete.`);
        if (!silent) {
            toastr.warning(
                `建议更新插件`,
                '版本提醒',
                { timeOut: 6000 }
            );
        }
    }

    const dirty = checkDirtyState(targetSlot, { allowPresetSwitch });
    if (!dirty.needsPresetSwitch && !dirty.needsEntryRestore) {
        console.debug(LOG_PREFIX, 'Dirty check passed: current state matches saved state, skipping restore.');
        if (!silent) toastr.info('无需恢复', 'Prompt Keeper');
        return true;
    }

    let presetSwitched = false;
    if (dirty.needsPresetSwitch) {
        console.log(LOG_PREFIX, `Switching preset to "${dirty.targetPreset}"...`);
        presetSwitched = await switchToPreset(dirty.targetPreset);

        if (getCtx().chatId !== chatIdAtStart) {
            console.warn(LOG_PREFIX, `Restore aborted: chatId changed while switching preset (was ${chatIdAtStart}, now ${getCtx().chatId}).`);
            return false;
        }

        if (presetSwitched) {
            const promptStateReady = await waitForPromptStateReady(targetSlot, chatIdAtStart);

            if (!promptStateReady || getCtx().chatId !== chatIdAtStart) {
                console.warn(LOG_PREFIX, `Restore aborted: chatId changed or prompt state not ready after preset switch.`);
                return false;
            }
        } else {
            const msg = `无法切换到保存的预设 "${dirty.targetPreset}"，该预设可能已改名或在此设备上不存在。`;
            console.warn(LOG_PREFIX, msg);
            if (!silent) toastr.warning('切换预设失败', 'Prompt Keeper', { timeOut: 6000 });
            return false;
        }
    }

    promptKeeperRefreshingUI = true;
    const { skipped, aborted } = applyPromptStates(targetSlot, chatIdAtStart);

    if (aborted) {
        promptKeeperRefreshingUI = false;
        console.warn(LOG_PREFIX, `Restore aborted: chatId changed during applyPromptStates.`);
        return false;
    }

    try {
        await tryRefreshPromptManagerUI();
    } finally {
        promptKeeperRefreshingUI = false;
    }

    if (getCtx().chatId !== chatIdAtStart) {
        console.warn(LOG_PREFIX, `Restore completed but chatId changed after UI refresh; result may be stale.`);
        return false;
    }

    if (skipped.length > 0) {
        const msg = `已跳过缺失条目`;
        console.warn(LOG_PREFIX, msg);
        if (!silent) toastr.warning(msg, '恢复提醒', { timeOut: 8000 });
    }

    const presetInfo = presetSwitched ? '，已切预设' : '';
    if (!silent) {
        toastr.success(`已恢复${presetInfo}`, 'Prompt Keeper');
    }

    console.log(LOG_PREFIX, `Restored prompt states for chat: ${chatId}, preset switched: ${presetSwitched}`);
    updateStatusDisplay(true, targetSlot.savedAt);
    return true;
}

function deleteStateFromMetadata() {
    showSlotPicker('delete');
}

function deleteSlotFromMetadata(slotName) {
    const ctx = getCtx();
    const chatId = ctx.chatId;

    if (!chatId) {
        toastr.warning('无活跃聊天', 'Prompt Keeper');
        return false;
    }

    const chatMetadata = ctx.chatMetadata;
    if (!chatMetadata) {
        toastr.warning('元数据不可用', 'Prompt Keeper');
        return false;
    }

    const savedState = migrateState(chatMetadata[METADATA_KEY]);
    if (savedState && savedState.slots && savedState.slots[slotName]) {
        delete savedState.slots[slotName];
        const remaining = getSlotEntries(savedState);
        if (savedState.defaultSlot === slotName) {
            savedState.defaultSlot = remaining[0] ? remaining[0][0] : null;
        }
        if (remaining.length === 0) {
            delete chatMetadata[METADATA_KEY];
        } else {
            chatMetadata[METADATA_KEY] = savedState;
        }
        persistChatMetadata();
        if (justSavedChatId === chatId) {
            justSavedChatId = null;
        }
        console.log(LOG_PREFIX, `Deleted saved slot for chat: ${chatId}, slot: ${slotName}`);
        toastr.success('已删除', 'Prompt Keeper');
        updateStatusDisplay(remaining.length > 0, getSavedAt());
        return true;
    } else {
        toastr.info('无可删槽位', 'Prompt Keeper');
        return false;
    }
}

function hasSavedState() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    return getSlotEntries(migrateState(chatMetadata && chatMetadata[METADATA_KEY])).length > 0;
}

function getSavedAt() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const savedState = migrateState(chatMetadata && chatMetadata[METADATA_KEY]);
    const slotEntries = getSlotEntries(savedState);
    const currentPresetName = getCurrentPresetName();
    const currentSlotName = findSlotName(savedState, currentPresetName);
    const currentSlot = currentSlotName && savedState && savedState.slots ? savedState.slots[currentSlotName] : null;
    const defaultSlot = currentSlot || getDefaultSlotState(savedState);
    return defaultSlot ? (defaultSlot.savedAt || null) : null;
}

// ========== Event Handlers ==========

function getAutoRestoreDelay() {
    const settings = loadPluginSettings();
    const baseDelay = Math.max(800, settings.autoRestoreDelay || DEFAULT_AUTO_RESTORE_DELAY_MS);
    const ctx = getCtx();
    const mobile = typeof ctx.isMobile === 'function' ? ctx.isMobile() : Boolean(ctx.isMobile);
    return mobile ? Math.max(baseDelay, 2200) : baseDelay;
}

async function scheduleRestoreForCurrentChat(source = 'chat_changed') {
    if (!isPluginEnabled()) return;

    const ctx = getCtx();
    const newChatId = ctx.chatId;

    if (newChatId !== lastHandledChatId) {
        justSavedChatId = null;
        lastHandledChatId = newChatId;
    }

    if (autoRestoreTimer) {
        clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        console.debug(LOG_PREFIX, `Cancelled pending auto-restore (${source}).`);
    }

    if (!newChatId) {
        requestAnimationFrame(() => updateStatusDisplay(false));
        return;
    }

    const totalDelay = getAutoRestoreDelay();

    autoRestoreTimer = setTimeout(async () => {
        autoRestoreTimer = null;

        if (!isPluginEnabled()) return;

        const currentCtx = getCtx();
        if (currentCtx.chatId !== newChatId) {
            console.debug(LOG_PREFIX, `Auto-restore cancelled: chatId changed (expected ${newChatId}, got ${currentCtx.chatId}).`);
            return;
        }

        const contextReady = await waitForChatContext(newChatId);
        if (!contextReady || getCtx().chatId !== newChatId) {
            console.warn(LOG_PREFIX, `Auto-restore cancelled: chat context not ready for ${newChatId}.`);
            return;
        }

        const hasSave = hasSavedState();
        requestAnimationFrame(() => updateStatusDisplay(hasSave, getSavedAt()));

        if (hasSave && isAutoRestoreEnabled()) {
            if (justSavedChatId === newChatId) {
                console.debug(LOG_PREFIX, 'Auto-restore skipped: just saved in this chat, protection active.');
                return;
            }
            console.log(LOG_PREFIX, `Auto-restore triggered for chat: ${newChatId}`);
            await restoreStatesFromMetadata(true, null, { autoRestore: true });
        }
    }, totalDelay);

    console.debug(LOG_PREFIX, `Auto-restore scheduled for ${newChatId} in ${totalDelay}ms (${source}).`);
}

function onChatChanged() {
    if (!isPluginEnabled()) return;
    scheduleRestoreForCurrentChat('chat_changed');
}

function onChatLoaded() {
    if (!isPluginEnabled()) return;
    scheduleRestoreForCurrentChat('chat_loaded');
}

function onPresetChanged() {
    if (promptKeeperRefreshingUI) {
        console.debug(LOG_PREFIX, 'Preset/status event ignored during internal UI refresh.');
        return;
    }
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
}

function onMainApiChanged() {
    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
}

// ========== UI ==========



