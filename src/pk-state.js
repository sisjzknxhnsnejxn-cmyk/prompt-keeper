// ========== Metadata Migration ==========

/**
 * 迁移旧版 metadata 结构到当前版本。
 * 高版本数据原样返回并标记 __futureVersion，避免降级写回。
 */
function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    if (raw.version === 2 && raw.slots && typeof raw.slots === 'object') {
        const slots = Object.assign({}, raw.slots);
        return {
            version: METADATA_VERSION,
            defaultSlot: raw.defaultSlot || Object.keys(slots)[0] || null,
            slots,
        };
    }

    if (!raw.version) {
        const slotName = normalizeSlotName(raw.presetName);
        return {
            version: METADATA_VERSION,
            defaultSlot: slotName,
            slots: {
                [slotName]: {
                    prompts: raw.prompts || {},
                    promptOrder: raw.promptOrder || null,
                    presetName: raw.presetName || slotName,
                    savedAt: raw.savedAt || null,
                },
            },
        };
    }

    if (raw.version === 1) {
        const slotName = normalizeSlotName(raw.presetName);
        return {
            version: METADATA_VERSION,
            defaultSlot: slotName,
            slots: {
                [slotName]: {
                    prompts: raw.prompts || {},
                    promptOrder: raw.promptOrder || null,
                    presetName: raw.presetName || slotName,
                    savedAt: raw.savedAt || null,
                },
            },
        };
    }

    if (raw.version > METADATA_VERSION) {
        console.warn(LOG_PREFIX, `Metadata version ${raw.version} is newer than supported version ${METADATA_VERSION}. Data will be treated as read-only to prevent corruption.`);
        const copy = Object.assign({}, raw);
        copy.__futureVersion = true;
        return copy;
    }

    console.warn(LOG_PREFIX, `Unknown metadata version ${raw.version}, treating as current.`);
    return Object.assign({}, raw, { version: METADATA_VERSION });
}

function normalizeSlotName(name) {
    return String(name || '').trim() || '未命名预设';
}

function normalizePresetKey(name) {
    return normalizeSlotName(name).toLowerCase();
}

function findSlotName(state, presetName, options = {}) {
    if (!state || !state.slots || !presetName) return null;

    const normalizedPreset = normalizePresetKey(presetName);
    const preferExactSlotName = options.preferExactSlotName === true;

    if (preferExactSlotName) {
        for (const [slotName] of getSlotEntries(state)) {
            if (normalizePresetKey(slotName) === normalizedPreset) return slotName;
        }

        for (const [slotName, slot] of getSlotEntries(state)) {
            if (slot && normalizePresetKey(slot.presetName) === normalizedPreset) return slotName;
        }

        return null;
    }

    for (const [slotName, slot] of getSlotEntries(state)) {
        if (normalizePresetKey(slotName) === normalizedPreset) return slotName;
        if (slot && normalizePresetKey(slot.presetName) === normalizedPreset) return slotName;
    }

    return null;
}

function getSlotEntries(state) {
    if (!state || !state.slots || typeof state.slots !== 'object') return [];
    return Object.entries(state.slots)
        .filter(([, slot]) => slot && typeof slot === 'object' && slot.prompts)
        .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
}

function getDefaultSlotState(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && state.slots[state.defaultSlot]) return state.slots[state.defaultSlot];
    const first = getSlotEntries(state)[0];
    return first ? first[1] : null;
}

function getDefaultSlotName(state) {
    if (!state || !state.slots) return null;
    if (state.defaultSlot && state.slots[state.defaultSlot]) return state.defaultSlot;
    const first = getSlotEntries(state)[0];
    return first ? first[0] : null;
}

function getBestRestoreSlotName(state, requestedSlotName = null) {
    if (!state || !state.slots) return null;

    let targetSlotName = requestedSlotName;
    if (targetSlotName && !state.slots[targetSlotName]) {
        targetSlotName = findSlotName(state, targetSlotName);
    }
    if (targetSlotName) return targetSlotName;

    const currentPresetName = getCurrentPresetName();
    const settings = loadPluginSettings();
    targetSlotName = findSlotName(state, currentPresetName, {
        preferExactSlotName: settings.customSaveName !== true,
    });
    if (targetSlotName) return targetSlotName;

    return getDefaultSlotName(state);
}

function getSavedStateFromCurrentChat() {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);
    persistMigratedStateIfNeeded(chatMetadata, rawState, savedState, { deferred: true });
    return { chatMetadata, rawState, savedState };
}

async function waitForChatContext(chatId, timeoutMs = AUTO_RESTORE_CONTEXT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const ctx = getCtx();
        if (ctx.chatId === chatId && ctx.chatMetadata) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const stableCtx = getCtx();
            if (stableCtx.chatId === chatId && stableCtx.chatMetadata === ctx.chatMetadata) {
                return true;
            }
        }
        await new Promise(resolve => setTimeout(resolve, AUTO_RESTORE_CONTEXT_POLL_MS));
    }

    return false;
}

function persistMigratedStateIfNeeded(chatMetadata, rawState, migratedState, options = {}) {
    if (!chatMetadata || !rawState || !migratedState || migratedState.__futureVersion) return;
    if (rawState.version === METADATA_VERSION && rawState.slots) return;
    chatMetadata[METADATA_KEY] = migratedState;

    const persist = () => {
        migratedStatePersistTimer = null;
        migratedStatePersistIdleId = null;
        persistChatMetadata();
    };

    if (options.deferred === true) {
        if (migratedStatePersistTimer || migratedStatePersistIdleId) return;
        migratedStatePersistTimer = setTimeout(() => {
            migratedStatePersistTimer = null;
            migratedStatePersistIdleId = pkScheduleIdleTask(persist, 2000);
        }, 1800);
        return;
    }

    persist();
}

// ========== Prompt State Read/Write ==========

/**
 * 读取当前 prompt 状态和顺序，优先 API 层，回退 DOM。
 */
