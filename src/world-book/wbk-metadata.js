// ========== Prompt Keeper World Book Metadata ==========

function wbkMigrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version && raw.version > WBK_METADATA_VERSION) return Object.assign({}, raw, { __futureVersion: true });
    if (raw.version === WBK_METADATA_VERSION && raw.slots && typeof raw.slots === 'object') {
        return {
            version: WBK_METADATA_VERSION,
            defaultSlot: raw.defaultSlot || Object.keys(raw.slots)[0] || null,
            slots: Object.assign({}, raw.slots),
        };
    }
    return null;
}

function wbkGetSlotEntries(state) {
    if (!state || !state.slots || typeof state.slots !== 'object') return [];
    return Object.entries(state.slots)
        .filter(([, slot]) => slot && typeof slot === 'object' && slot.worldBookState)
        .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
}

function wbkGetSaveSlotName(existingSlots) {
    const settings = wbkLoadSettings();
    const selectedBooks = wbkGetSelectedWorldBooks();
    const defaultName = selectedBooks.length > 0 ? selectedBooks.join(' + ') : '世界书配置';
    if (settings.customSaveName !== true) return wbkNormalizeSlotName(defaultName);

    const input = window.prompt('请输入世界书保存槽位名称：', defaultName);
    if (input === null) return null;
    const slotName = wbkNormalizeSlotName(input);
    if (!slotName || !wbkIsSafeSlotName(slotName)) {
        toastr.warning('槽位名称不可用', '世界书保护');
        return null;
    }
    if (existingSlots && existingSlots[slotName] && !window.confirm(`槽位“${slotName}”已存在，是否覆盖？`)) return null;
    return slotName;
}

function wbkGetSavedStateFromCurrentChat() {
    const ctx = wbkGetCtx();
    const chatMetadata = ctx.chatMetadata;
    const savedState = wbkMigrateState(chatMetadata && chatMetadata[WBK_METADATA_KEY]);
    return { chatMetadata, savedState };
}

async function wbkSaveStatesToMetadata() {
    if (!wbkIsEnabled()) return false;
    if (wbkSaveInProgress) return false;
    wbkSaveInProgress = true;

    try {
        const ctx = wbkGetCtx();
        if (!ctx.chatId) {
            toastr.warning('无活跃聊天', '世界书保护');
            return false;
        }
        if (!ctx.chatMetadata) {
            toastr.warning('元数据不可用', '世界书保护');
            return false;
        }

        const existing = wbkMigrateState(ctx.chatMetadata[WBK_METADATA_KEY]) || { version: WBK_METADATA_VERSION, defaultSlot: null, slots: {} };
        if (existing.__futureVersion) {
            toastr.error('请更新插件后再覆盖世界书配置', '版本不兼容');
            return false;
        }

        const slotName = wbkGetSaveSlotName(existing.slots);
        if (!slotName) return false;
        if (!existing.slots[slotName] && wbkGetSlotEntries(existing).length >= WBK_MAX_SLOTS_PER_CHAT) {
            toastr.warning(`最多保存 ${WBK_MAX_SLOTS_PER_CHAT} 个世界书槽位`, '世界书保护');
            return false;
        }

        const now = Date.now();
        existing.version = WBK_METADATA_VERSION;
        existing.defaultSlot = slotName;
        existing.slots[slotName] = { savedAt: now, worldBookState: wbkReadWorldBookState() };
        ctx.chatMetadata[WBK_METADATA_KEY] = existing;
        wbkPersistChatMetadata();
        wbkJustSavedChatId = ctx.chatId;
        wbkUpdateStatusDisplay(true, now);
        toastr.success(`已保存世界书：${slotName}`, '世界书保护');
        console.log(WBK_LOG_PREFIX, `Saved world book state for chat ${ctx.chatId}, slot ${slotName}`);
        return true;
    } finally {
        setTimeout(() => { wbkSaveInProgress = false; }, WBK_BUTTON_DEBOUNCE_MS);
    }
}

async function wbkRestoreStatesFromMetadata(silent = false, slotName = null, options = {}) {
    if (!wbkIsEnabled()) return false;
    const ctx = wbkGetCtx();
    const chatId = ctx.chatId;
    if (!chatId) {
        if (!silent) toastr.warning('无活跃聊天', '世界书保护');
        return false;
    }

    const { savedState } = wbkGetSavedStateFromCurrentChat();
    const entries = wbkGetSlotEntries(savedState);
    if (!savedState || entries.length === 0) {
        if (!silent) toastr.info('暂无世界书保存配置', '世界书保护');
        return false;
    }

    const targetSlotName = slotName && savedState.slots[slotName] ? slotName : (savedState.defaultSlot || entries[0][0]);
    const slot = savedState.slots[targetSlotName];
    if (!slot || !slot.worldBookState) {
        if (!silent) toastr.warning('世界书槽位不可用', '世界书保护');
        return false;
    }

    if (options.autoRestore === true) await new Promise(resolve => setTimeout(resolve, 350));
    if (wbkGetCtx().chatId !== chatId) return false;

    const result = wbkApplyWorldBookState(slot.worldBookState);
    wbkUpdateStatusDisplay(true, slot.savedAt);
    if (!silent) {
        const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个缺失条目` : '';
        const modeLabels = { merge: '启用列表已合并', replace: '启用列表已替换', skip: '未修改启用列表', disabled: '未管理启用列表', none: '无启用列表记录' };
        const selectedInfo = modeLabels[result.selectedMode] ? `，${modeLabels[result.selectedMode]}` : '';
        toastr.success(`已恢复世界书${selectedInfo}${skipped}`, '世界书保护');
    }
    console.log(WBK_LOG_PREFIX, `Restored world book state for chat ${chatId}:`, result);
    return true;
}

function wbkDeleteSlotFromMetadata(slotName) {
    const ctx = wbkGetCtx();
    if (!ctx.chatId || !ctx.chatMetadata) {
        toastr.warning('无活跃聊天或元数据不可用', '世界书保护');
        return false;
    }

    const savedState = wbkMigrateState(ctx.chatMetadata[WBK_METADATA_KEY]);
    if (!savedState || !savedState.slots || !savedState.slots[slotName]) {
        toastr.info('无可删世界书槽位', '世界书保护');
        return false;
    }

    delete savedState.slots[slotName];
    const remaining = wbkGetSlotEntries(savedState);
    if (savedState.defaultSlot === slotName) savedState.defaultSlot = remaining[0] ? remaining[0][0] : null;
    if (remaining.length === 0) delete ctx.chatMetadata[WBK_METADATA_KEY];
    else ctx.chatMetadata[WBK_METADATA_KEY] = savedState;
    wbkPersistChatMetadata();
    wbkUpdateStatusDisplay(remaining.length > 0, wbkGetSavedAt());
    toastr.success('已删除世界书槽位', '世界书保护');
    return true;
}

function wbkHasSavedState() {
    const { savedState } = wbkGetSavedStateFromCurrentChat();
    return wbkGetSlotEntries(savedState).length > 0;
}

function wbkGetSavedAt() {
    const { savedState } = wbkGetSavedStateFromCurrentChat();
    const entries = wbkGetSlotEntries(savedState);
    if (!savedState || entries.length === 0) return null;
    const slot = savedState.defaultSlot && savedState.slots[savedState.defaultSlot] ? savedState.slots[savedState.defaultSlot] : entries[0][1];
    return slot ? slot.savedAt : null;
}
