// ========== Prompt Keeper World Book UI ==========

function wbkFormatTime(timestamp) {
    if (!timestamp) return '';
    try {
        const d = new Date(timestamp);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (_) {
        return '';
    }
}

function wbkFormatSlotTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
        return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return '未知时间';
    }
}

function wbkUpdateStatusDisplay(hasSave, savedAt) {
    const $status = jQuery('#prompt-keeper-world-book-status');
    if ($status.length === 0) return;
    if (!wbkIsEnabled()) {
        $status.text('已关闭').removeClass('wbk-saved wbk-not-saved').addClass('wbk-disabled');
        return;
    }
    if (hasSave) {
        const time = wbkFormatTime(savedAt || wbkGetSavedAt());
        $status.text(time ? `✓ 已保存 ${time}` : '✓ 已保存').removeClass('wbk-not-saved wbk-disabled').addClass('wbk-saved');
    } else {
        $status.text('⚠ 无保存').removeClass('wbk-saved wbk-disabled').addClass('wbk-not-saved');
    }
}

function wbkCloseSlotPicker() {
    jQuery('#prompt-keeper-world-book-modal').remove();
    jQuery(document.body).removeClass('wbk-modal-open');
    jQuery(window).off('.wbkModalViewport');
    if (window.visualViewport && typeof window.visualViewport.removeEventListener === 'function') {
        window.visualViewport.removeEventListener('resize', wbkSetModalViewportHeight);
        window.visualViewport.removeEventListener('scroll', wbkSetModalViewportHeight);
    }
}

function wbkRemoveUI() {
    jQuery('#prompt-keeper-world-book-bar').remove();
    wbkCloseSlotPicker();
}

function wbkIsElementVisible($element) {
    if (!$element || $element.length === 0) return false;
    const element = $element[0];
    return Boolean(element.offsetParent || element.getClientRects().length > 0 || $element.is(':visible'));
}

function wbkIsExtensionSettingsElement($element) {
    if (!$element || $element.length === 0) return false;
    return $element.closest('#extensions_settings, #extensions_settings2, #extensions_settings_popup, .extensions_settings').length > 0;
}

function wbkGetWorldBookNativeContainer($element) {
    if (!$element || $element.length === 0) return jQuery();
    return $element.closest('#WorldInfo, #world_info, #world_popup_entries_list, #world_info_entries, .world_entry_form').first();
}

function wbkIsInWorldBookNativeUI(element) {
    if (!element || !element.closest) return false;
    if (element.closest('#extensions_settings, #extensions_settings2, #extensions_settings_popup, .extensions_settings')) return false;
    return Boolean(element.closest('#WorldInfo, #world_info, #world_editor_select, #world_info_entries, #world_popup_entries_list, .world_entry_form'));
}

function wbkFindWorldBookNativeAnchor() {
    const directCandidates = [
        '#world_editor_select',
        '#world_info_entries',
        '#world_popup_entries_list',
        '#WorldInfo',
        '#world_info',
    ];

    for (const selector of directCandidates) {
        const $target = jQuery(selector).filter(function () { return wbkIsElementVisible(jQuery(this)); }).first();
        if ($target.length === 0) continue;
        if (wbkIsExtensionSettingsElement($target)) continue;

        const $container = wbkGetWorldBookNativeContainer($target);
        if ($container.length > 0) {
            return { $target: $container, method: selector === '#world_editor_select' ? 'after' : 'prepend' };
        }

        return { $target, method: selector === '#world_editor_select' ? 'after' : 'before' };
    }

    return null;
}

function wbkSetModalViewportHeight() {
    const height = window.visualViewport && window.visualViewport.height ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--wbk-vh', `${height * 0.01}px`);
}

function wbkPrepareSlotPickerViewport() {
    wbkSetModalViewportHeight();
    jQuery(window).off('.wbkModalViewport').on('resize.wbkModalViewport orientationchange.wbkModalViewport', wbkSetModalViewportHeight);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
        window.visualViewport.addEventListener('resize', wbkSetModalViewportHeight);
        window.visualViewport.addEventListener('scroll', wbkSetModalViewportHeight);
    }
    jQuery(document.body).addClass('wbk-modal-open');
}

function wbkGetSlotPickerThemeLabel(theme) {
    return theme === 'light' ? '☀ 日间' : '🌙 夜间';
}

function wbkApplySlotPickerTheme($modal, theme) {
    $modal.toggleClass('wbk-modal-light', theme === 'light').toggleClass('wbk-modal-dark', theme === 'dark');
    $modal.find('.wbk-modal-theme').text(wbkGetSlotPickerThemeLabel(theme));
}

function wbkToggleSlotPickerTheme() {
    const $modal = jQuery('#prompt-keeper-world-book-modal');
    if ($modal.length === 0) return;
    const nextTheme = $modal.hasClass('wbk-modal-light') ? 'dark' : 'light';
    wbkApplySlotPickerTheme($modal, nextTheme);
    const settings = wbkLoadSettings();
    settings.slotPickerTheme = nextTheme;
    wbkSaveSettings();
}

function wbkAnimatePressedButton($btn) {
    if (!$btn || !$btn.length) return;
    $btn.addClass('wbk-btn-active');
    setTimeout(() => $btn.removeClass('wbk-btn-active'), 220);
}

function wbkExecuteButtonAction(action, $btn, buttonId = 'unknown') {
    const now = Date.now();
    const lastHandled = Number(wbkLastButtonActionById[buttonId] || 0);
    if (now - lastHandled < WBK_BUTTON_DEBOUNCE_MS) return;
    wbkLastButtonActionById[buttonId] = now;
    wbkAnimatePressedButton($btn);
    Promise.resolve(action()).catch((error) => {
        console.error(WBK_LOG_PREFIX, `Button action failed for ${buttonId}:`, error);
        toastr.error('操作失败，请查看控制台', '世界书保护');
    });
}

function wbkHandleButtonAction(selector, $btn) {
    const actions = {
        '#prompt-keeper-world-book-save': () => wbkSaveStatesToMetadata(),
        '#prompt-keeper-world-book-restore': () => wbkShowSlotPicker('restore'),
        '#prompt-keeper-world-book-delete': () => wbkShowSlotPicker('delete'),
    };
    if (actions[selector]) wbkExecuteButtonAction(actions[selector], $btn, selector);
}

function wbkShouldHandlePress(e, key) {
    const now = Date.now();
    const eventType = e && e.type ? e.type : 'unknown';
    const last = wbkLastInteractionByKey[key] || { type: '', time: 0 };

    if ((eventType === 'click' || eventType === 'touchend') && now - last.time < WBK_INTERACTION_DEBOUNCE_MS) {
        return false;
    }

    wbkLastInteractionByKey[key] = { type: eventType, time: now };
    return true;
}

function wbkGetButtonEventTypes() {
    if (typeof pkGetButtonEventTypes === 'function') return pkGetButtonEventTypes();
    return WBK_ALL_BUTTON_EVENT_TYPES;
}

function wbkBindPress($element, namespace, key, handler) {
    const events = wbkGetButtonEventTypes().map(type => `${type}.${namespace}`).join(' ');
    $element
        .off(`.${namespace}`)
        .on(events, function (e) {
            if (this.disabled || this.getAttribute('aria-disabled') === 'true') return;
            e.preventDefault();
            e.stopPropagation();
            if (!wbkShouldHandlePress(e, key)) return;
            handler.call(this, e);
        })
        .on(`keydown.${namespace}`, function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            handler.call(this, e);
        });
}

function wbkShowSlotPicker(mode) {
    const { savedState } = wbkGetSavedStateFromCurrentChat();
    const slotEntries = wbkGetSlotEntries(savedState);
    if (slotEntries.length === 0) {
        toastr.info('暂无世界书保存槽位', '世界书保护');
        return;
    }

    wbkCloseSlotPicker();
    wbkPrepareSlotPickerViewport();
    const isDelete = mode === 'delete';
    const title = isDelete ? '删除世界书槽位' : '恢复世界书槽位';
    const subtitle = isDelete ? '选择槽位后需再次点击确认删除，避免误触。' : '选择一个保存槽位来恢复世界书启用列表与条目状态。';
    const settings = wbkLoadSettings();
    const theme = settings.slotPickerTheme === 'dark' ? 'dark' : 'light';
    const $modal = jQuery(`
        <div id="prompt-keeper-world-book-modal" class="wbk-modal-overlay wbk-modal-${theme}">
            <div class="wbk-modal-card" role="dialog" aria-modal="true" aria-label="${title}">
                <div class="wbk-modal-header">
                    <div class="wbk-modal-title-group">
                        <strong>${title}</strong>
                        <small>${subtitle}</small>
                    </div>
                    <button type="button" class="wbk-modal-theme">${wbkGetSlotPickerThemeLabel(theme)}</button>
                </div>
                <div class="wbk-modal-list"></div>
                <button type="button" class="wbk-modal-cancel">取消</button>
            </div>
        </div>`);

    const $list = $modal.find('.wbk-modal-list');
    let pendingDeleteSlotName = null;
    let pendingDeleteUntil = 0;
    const resetDeleteConfirmState = () => {
        pendingDeleteSlotName = null;
        pendingDeleteUntil = 0;
        $list.find('.wbk-slot-item').each(function () {
            const $slot = jQuery(this);
            const originalText = $slot.data('slotTimeText');
            $slot.removeClass('wbk-slot-confirming');
            if (originalText) $slot.find('.wbk-slot-time').text(originalText);
        });
    };
    for (const [name, slot] of slotEntries) {
        const isDefault = savedState.defaultSlot === name;
        const selectedBooks = ((slot.worldBookState && slot.worldBookState.selectedBooks) || []).join(' + ') || '无启用世界书';
        const slotTimeText = `${selectedBooks} · 保存于 ${wbkFormatSlotTime(slot.savedAt)}`;
        const $item = jQuery(`
            <button type="button" class="wbk-slot-item ${isDelete ? 'wbk-slot-delete' : ''}">
                <span class="wbk-slot-main">
                    <span class="wbk-slot-name"></span>
                    ${isDefault ? '<span class="wbk-slot-default">默认</span>' : ''}
                </span>
                <span class="wbk-slot-time"></span>
            </button>`);
        $item.find('.wbk-slot-name').text(name);
        $item.find('.wbk-slot-time').text(slotTimeText);
        $item.data('slotTimeText', slotTimeText);
        wbkBindPress($item, 'wbkSlotPress', `slot:${mode}:${name}`, async () => {
            wbkAnimatePressedButton($item);
            if (isDelete) {
                const now = Date.now();
                const confirmed = pendingDeleteSlotName === name && now < pendingDeleteUntil;
                if (!confirmed) {
                    resetDeleteConfirmState();
                    pendingDeleteSlotName = name;
                    pendingDeleteUntil = now + 5000;
                    $item.addClass('wbk-slot-confirming');
                    $item.find('.wbk-slot-time').text('再次点击确认删除 · 5 秒内有效');
                    return;
                }
            }
            $item.addClass('wbk-slot-working').prop('disabled', true);
            $list.find('.wbk-slot-item').not($item).prop('disabled', true).addClass('wbk-slot-disabled');
            if (isDelete) {
                $item.find('.wbk-slot-time').text('删除中…');
                wbkDeleteSlotFromMetadata(name);
            } else {
                $item.find('.wbk-slot-time').text('恢复中…');
                await wbkRestoreStatesFromMetadata(false, name);
            }
            wbkCloseSlotPicker();
        });
        $list.append($item);
    }

    wbkBindPress($modal.find('.wbk-modal-theme'), 'wbkThemePress', 'modal:theme', () => wbkToggleSlotPickerTheme());
    wbkBindPress($modal.find('.wbk-modal-cancel'), 'wbkCancelPress', 'modal:cancel', () => wbkCloseSlotPicker());
    const overlayEvents = wbkGetButtonEventTypes().map(type => `${type}.wbkOverlay`).join(' ');
    $modal.on(overlayEvents, function (e) {
        if (e.target === this && wbkShouldHandlePress(e, 'modal:overlay')) wbkCloseSlotPicker();
    });
    jQuery(document.body).append($modal);
}

function wbkBindButtonEvents() {
    const delegatedEvents = wbkGetButtonEventTypes().map(type => `${type}.promptKeeperWorldBookButtons`).join(' ');
    jQuery(document)
        .off('.promptKeeperWorldBookButtons')
        .on(delegatedEvents, '#prompt-keeper-world-book-save, #prompt-keeper-world-book-restore, #prompt-keeper-world-book-delete', function (e) {
            if (this.disabled || this.getAttribute('aria-disabled') === 'true') return;
            e.preventDefault();
            e.stopPropagation();
            if (!wbkShouldHandlePress(e, `button:${this.id}`)) return;
            wbkHandleButtonAction(`#${this.id}`, jQuery(this));
        })
        .on('keydown.promptKeeperWorldBookButtons', '#prompt-keeper-world-book-save, #prompt-keeper-world-book-restore, #prompt-keeper-world-book-delete', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            wbkHandleButtonAction(`#${this.id}`, jQuery(this));
        });
}

function wbkClearUIEnsureTimers() {
    for (const timer of wbkUiEnsureTimers) clearTimeout(timer);
    wbkUiEnsureTimers = [];
}

function wbkScheduleUIEnsure(source = 'manual') {
    wbkClearUIEnsureTimers();
    for (const delay of WBK_UI_ENSURE_DELAYS_MS) {
        const timer = setTimeout(() => wbkEnsureUI(`${source}_${delay}`), delay);
        wbkUiEnsureTimers.push(timer);
    }
}

function wbkInjectUI() {
    if (!wbkIsEnabled()) {
        wbkRemoveUI();
        return;
    }

    const existingBar = document.getElementById('prompt-keeper-world-book-bar');
    if (existingBar && !wbkIsInWorldBookNativeUI(existingBar)) {
        existingBar.remove();
    }

    if (jQuery('#prompt-keeper-world-book-bar').length > 0) {
        wbkBindButtonEvents();
        wbkUpdateStatusDisplay(wbkHasSavedState(), wbkGetSavedAt());
        return;
    }

    const buttonBarHtml = `
    <div id="prompt-keeper-world-book-bar" class="prompt-keeper-world-book-bar wbk-world-info-toolbar" data-wbk-root="true" role="toolbar" aria-label="世界书保护操作">
        <div class="prompt-keeper-world-book-header">
            <i class="fa-solid fa-book-atlas"></i>
            <span>世界书保护</span>
            <span id="prompt-keeper-world-book-status" class="wbk-not-saved">⚠ 无保存</span>
        </div>
        <div class="prompt-keeper-world-book-btn-group">
            <button type="button" id="prompt-keeper-world-book-save" class="menu_button" title="保存当前世界书和条目开关" aria-label="保存当前世界书和条目开关"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
            <button type="button" id="prompt-keeper-world-book-restore" class="menu_button" title="恢复保存的世界书和条目开关" aria-label="恢复保存的世界书和条目开关"><i class="fa-solid fa-rotate-left"></i><span>恢复</span></button>
            <button type="button" id="prompt-keeper-world-book-delete" class="menu_button" title="删除当前聊天的世界书保存槽位" aria-label="删除当前聊天的世界书保存槽位"><i class="fa-solid fa-trash-can"></i><span>删除</span></button>
        </div>
    </div>`;

    const anchor = wbkFindWorldBookNativeAnchor();
    if (!anchor || !anchor.$target || anchor.$target.length === 0) {
        console.debug(WBK_LOG_PREFIX, 'Could not find UI injection point.');
        return;
    }

    if (anchor.method === 'prepend') anchor.$target.prepend(buttonBarHtml);
    else if (anchor.method === 'after') anchor.$target.after(buttonBarHtml);
    else anchor.$target.before(buttonBarHtml);

    wbkBindButtonEvents();
    wbkUpdateStatusDisplay(wbkHasSavedState(), wbkGetSavedAt());
    console.log(WBK_LOG_PREFIX, 'World book UI injected.');
}

function wbkLoadSettingsPanel() {
    if (jQuery('#prompt-keeper-world-book-settings').length > 0) return;
    const $settingsRoot = jQuery('#extensions_settings2');
    if ($settingsRoot.length === 0) return;
    $settingsRoot.append(WBK_SETTINGS_HTML);
    const settings = wbkLoadSettings();
    jQuery('#wbk-enabled-toggle').prop('checked', settings.enabled !== false);
    jQuery('#wbk-auto-restore-toggle').prop('checked', settings.autoRestore === true);
    jQuery('#wbk-manage-selected-books-toggle').prop('checked', settings.manageSelectedBooks !== false);
    jQuery('#wbk-capture-all-known-books-toggle').prop('checked', settings.captureAllKnownBooks === true);
    jQuery('#wbk-selected-books-restore-mode').val(settings.selectedBooksRestoreMode || WBK_DEFAULT_SETTINGS.selectedBooksRestoreMode);
    jQuery('#wbk-custom-save-name-toggle').prop('checked', settings.customSaveName === true);

    const bindToggle = (selector, key, message) => {
        jQuery(selector).on('change.promptKeeperWorldBookSettings', function () {
            const s = wbkLoadSettings();
            s[key] = jQuery(this).prop('checked');
            wbkSaveSettings();
            if (key === 'enabled' && s[key] === false && wbkAutoRestoreTimer) {
                clearTimeout(wbkAutoRestoreTimer);
                wbkAutoRestoreTimer = null;
            }
            if (key === 'enabled') {
                if (s[key] === false) wbkRemoveUI();
                else wbkScheduleUIEnsure('settings_enabled');
            } else {
                wbkUpdateStatusDisplay(wbkHasSavedState(), wbkGetSavedAt());
            }
            toastr.info(typeof message === 'function' ? message(s[key]) : message, '世界书保护');
        });
    };

    bindToggle('#wbk-enabled-toggle', 'enabled', value => value ? '世界书保护已启用' : '世界书保护已关闭');
    bindToggle('#wbk-auto-restore-toggle', 'autoRestore', value => value ? '自动恢复已开' : '自动恢复已关');
    bindToggle('#wbk-manage-selected-books-toggle', 'manageSelectedBooks', '已更新世界书列表保护范围');
    bindToggle('#wbk-capture-all-known-books-toggle', 'captureAllKnownBooks', '已更新世界书捕获范围');
    bindToggle('#wbk-custom-save-name-toggle', 'customSaveName', value => value ? '保存时会询问槽位名称' : '保存时使用启用的世界书名称');

    jQuery('#wbk-selected-books-restore-mode').on('change.promptKeeperWorldBookSettings', function () {
        const s = wbkLoadSettings();
        const value = String(jQuery(this).val() || WBK_DEFAULT_SETTINGS.selectedBooksRestoreMode);
        s.selectedBooksRestoreMode = WBK_SELECTED_BOOKS_RESTORE_MODES.includes(value) ? value : WBK_DEFAULT_SETTINGS.selectedBooksRestoreMode;
        wbkSaveSettings();
        const labels = { merge: '恢复时会合并当前与保存的启用世界书', replace: '恢复时会严格替换为保存的启用世界书', skip: '恢复时不会修改启用世界书列表' };
        toastr.info(labels[s.selectedBooksRestoreMode], '世界书保护');
    });
}

function wbkEnsureUI(source = 'manual') {
    try { wbkLoadSettingsPanel(); } catch (error) { console.debug(WBK_LOG_PREFIX, `Settings panel skipped (${source}):`, error); }
    if (!wbkIsEnabled()) {
        wbkRemoveUI();
        return;
    }
    try { wbkInjectUI(); } catch (error) { console.debug(WBK_LOG_PREFIX, `UI injection skipped (${source}):`, error); }
}
