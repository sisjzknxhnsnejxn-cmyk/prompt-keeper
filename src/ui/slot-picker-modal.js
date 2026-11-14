/**
 * Prompt Keeper - 预设槽位选择与管理模态弹窗
 */

import { MAX_SLOTS_PER_CHAT } from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { loadPluginSettings, savePluginSettings } from '../core/settings.js';
import {
    findSlotName,
    getDefaultSlotName,
    getSavedStateFromCurrentChat,
    getSlotEntries,
} from '../core/state-migration.js';
import { getCurrentPresetName } from '../services/preset-service.js';
import {
    deleteSavedStates,
    restoreStatesFromMetadata,
    setDefaultSlot,
} from '../services/slot-service.js';
import {
    isTouchScrollGesture,
    markTouchHandledForSyntheticClick,
    pkGetButtonEventTypes,
    resolveEventElement,
    shouldHandleInteraction,
    shouldSuppressSyntheticClick,
} from '../utils/dom-events.js';
import { hasOwnSlot } from '../utils/format.js';
import {
    bindIOSModalViewportAndScrollLock,
    bindModalBackdropIsolationAndDismiss,
} from './input-modal.js';

const MODAL_OPEN_GUARD_MS = 380;
const INLINE_CONFIRM_TIMEOUT_MS = 3000;

function renderThemeToggleContent(isLight) {
    return isLight
        ? '<i class="fa-solid fa-sun"></i>'
        : '<i class="fa-solid fa-moon"></i>';
}

export function closeSlotPickerModal() {
    if (typeof runtimeState.modalEscapeCleanup === 'function') {
        runtimeState.modalEscapeCleanup();
        runtimeState.modalEscapeCleanup = null;
    }
    if (typeof jQuery !== 'undefined') {
        jQuery('#prompt-keeper-slot-modal').remove();
    }
}

export function openSlotPickerModal(mode = 'restore') {
    if (typeof jQuery === 'undefined') return;
    closeSlotPickerModal();

    const modalOpenedAt = Date.now();
    let hasModalPointerDownAfterOpen = false;

    const { savedState } = getSavedStateFromCurrentChat();
    const entries = getSlotEntries(savedState);
    if (!savedState || entries.length === 0) {
        if (typeof toastr !== 'undefined') {
            toastr.info('当前聊天没有已保存的预设槽位。', 'Prompt Keeper');
        }
        return;
    }

    const currentPreset = getCurrentPresetName();
    const matchedSlotName = currentPreset ? findSlotName(savedState, currentPreset) : null;
    const defaultSlotName = getDefaultSlotName(savedState);
    const settings = loadPluginSettings();
    let isLightTheme = settings.slotPickerTheme !== 'dark';
    const themeClass = isLightTheme ? 'pk-slot-theme-light' : 'pk-slot-theme-dark';

    const $backdrop = jQuery(
        `<div id="prompt-keeper-slot-modal" class="pk-slot-modal-backdrop pk-modal-overlay ${themeClass}" role="dialog" aria-modal="true"></div>`
    );
    const $dialog = jQuery('<div class="pk-slot-modal"></div>');
    const titleText = mode === 'delete' ? '管理预设槽位' : '预设槽位';

    const $header = jQuery('<div class="pk-slot-modal-header"></div>');
    const $headerTitleWrap = jQuery('<div class="pk-slot-modal-title-wrap"></div>');
    $headerTitleWrap.append(
        jQuery('<div class="pk-slot-modal-title"></div>').text(titleText),
        jQuery('<span class="pk-slot-count-pill"></span>').text(
            `${entries.length} / ${MAX_SLOTS_PER_CHAT}`
        )
    );

    const $headerTools = jQuery('<div class="pk-slot-modal-tools"></div>');
    const $themeBtn = jQuery(
        `<button type="button" class="pk-slot-theme-btn pk-icon-only-btn" title="切换日间 / 夜间模式">${renderThemeToggleContent(isLightTheme)}</button>`
    );
    const $closeBtn = jQuery(
        '<button type="button" class="pk-slot-close-btn" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>'
    );
    $headerTools.append($themeBtn, $closeBtn);
    $header.append($headerTitleWrap, $headerTools);

    const $list = jQuery('<div class="pk-slot-list"></div>');

    for (const [slotName] of entries) {
        const isCurrentPreset = matchedSlotName === slotName;
        const isDefaultSlot = defaultSlotName === slotName;

        const $item = jQuery(
            `<div class="pk-slot-item ${isCurrentPreset ? 'pk-slot-item-active' : ''}"></div>`
        );
        const $nameRow = jQuery('<div class="pk-slot-name-row"></div>');
        const $titleGroup = jQuery('<div class="pk-slot-title-group"></div>');
        $titleGroup.append(jQuery('<span class="pk-slot-name"></span>').text(slotName).attr('title', slotName));

        const $badges = jQuery('<div class="pk-slot-badges"></div>');
        if (isCurrentPreset) {
            $badges.append(
                jQuery('<span class="pk-slot-badge pk-slot-badge-current">当前</span>')
            );
        }
        if (isDefaultSlot) {
            $badges.append(
                jQuery('<span class="pk-slot-badge pk-slot-badge-default">默认</span>')
            );
        }
        if ($badges.children().length > 0) {
            $titleGroup.append($badges);
        }

        const $quickTools = jQuery('<div class="pk-slot-quick-tools"></div>');
        const $defaultBtn = jQuery(
            `<button type="button" class="pk-slot-icon-tool pk-slot-star-tool ${isDefaultSlot ? 'pk-is-active' : ''}" ${isDefaultSlot ? 'disabled' : ''} title="${isDefaultSlot ? '当前默认槽位' : '设为默认槽位'}"><i class="fa-solid fa-star"></i></button>`
        );
        if (!isDefaultSlot) {
            $defaultBtn
                .attr('data-pk-slot-action', 'set-default')
                .attr('data-pk-slot-name', slotName);
        }

        const $deleteSlotBtn = jQuery(
            '<button type="button" class="pk-slot-icon-tool pk-slot-delete-tool" title="删除槽位"><i class="fa-solid fa-trash-can"></i><span class="pk-delete-confirm-label">删除</span></button>'
        );
        $deleteSlotBtn.attr('data-pk-slot-action', 'delete').attr('data-pk-slot-name', slotName);

        $quickTools.append($defaultBtn, $deleteSlotBtn);
        $nameRow.append($titleGroup, $quickTools);

        const $actions = jQuery('<div class="pk-slot-actions"></div>');

        const $restoreSlotBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-primary" title="切换到该预设并恢复条目"><span>恢复</span></button>'
        );
        $restoreSlotBtn.attr('data-pk-slot-action', 'restore').attr('data-pk-slot-name', slotName);

        const $applyCurrentBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-secondary" title="保持当前预设，仅套用条目开关"><span>仅套用条目</span></button>'
        );
        $applyCurrentBtn
            .attr('data-pk-slot-action', 'apply-current')
            .attr('data-pk-slot-name', slotName);

        $actions.append($restoreSlotBtn, $applyCurrentBtn);
        $item.append($nameRow, $actions);
        $list.append($item);
    }

    const $footer = jQuery('<div class="pk-slot-modal-footer"></div>');
    const $clearAllBtn = jQuery(
        '<button type="button" class="pk-slot-clear-all-btn"><span class="pk-clear-all-text">清空全部</span></button>'
    );
    const $cancelBtn = jQuery(
        '<button type="button" class="pk-slot-cancel-btn"><span>关闭</span></button>'
    );

    const confirmTimers = new Set();
    const clearAllConfirmTimers = () => {
        for (const t of confirmTimers) {
            clearTimeout(t);
        }
        confirmTimers.clear();
    };

    const modalInteractionEvents = pkGetButtonEventTypes().join(' ');

    $dialog.on('pointerdown touchstart mousedown', () => {
        hasModalPointerDownAfterOpen = true;
    });

    const isGhostEventFromModalTrigger = (event) => {
        if (hasModalPointerDownAfterOpen) return false;
        const elapsedSinceOpen = Date.now() - modalOpenedAt;
        if (elapsedSinceOpen < MODAL_OPEN_GUARD_MS) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            return true;
        }
        return false;
    };

    $themeBtn.on(modalInteractionEvents, function (e) {
        if (isGhostEventFromModalTrigger(e)) return;
        if (isTouchScrollGesture(runtimeState, e)) return;
        if (shouldSuppressSyntheticClick(this, e.type)) return;
        markTouchHandledForSyntheticClick(this, e.type);
        if (!shouldHandleInteraction(this)) return;
        e.preventDefault();
        e.stopPropagation();

        isLightTheme = !isLightTheme;
        const s = loadPluginSettings();
        s.slotPickerTheme = isLightTheme ? 'light' : 'dark';
        savePluginSettings();

        $backdrop
            .removeClass('pk-slot-theme-light pk-slot-theme-dark')
            .addClass(isLightTheme ? 'pk-slot-theme-light' : 'pk-slot-theme-dark');
        $themeBtn.html(renderThemeToggleContent(isLightTheme));
    });

    $list.on(modalInteractionEvents, '[data-pk-slot-action]', async function (e) {
        if (isGhostEventFromModalTrigger(e)) return;
        if (isTouchScrollGesture(runtimeState, e)) return;
        const targetEl = resolveEventElement(e);
        const btnEl =
            targetEl && typeof targetEl.closest === 'function'
                ? targetEl.closest('[data-pk-slot-action]') || this
                : this;
        if (!btnEl || btnEl.disabled) return;
        if (shouldSuppressSyntheticClick(btnEl, e.type)) return;
        markTouchHandledForSyntheticClick(btnEl, e.type);
        if (!shouldHandleInteraction(btnEl)) return;
        e.preventDefault();
        e.stopPropagation();

        const action = btnEl.getAttribute('data-pk-slot-action');
        const slotName = btnEl.getAttribute('data-pk-slot-name');
        if (!action || !slotName) return;

        if (action === 'restore') {
            closeSlotPickerModal();
            await restoreStatesFromMetadata(true, null, slotName, { allowPresetSwitch: true });
            return;
        }
        if (action === 'apply-current') {
            closeSlotPickerModal();
            await restoreStatesFromMetadata(true, null, slotName, { allowPresetSwitch: false });
            return;
        }
        if (action === 'set-default') {
            await setDefaultSlot(slotName);
            openSlotPickerModal(mode);
            return;
        }
        if (action === 'delete') {
            const $btn = jQuery(btnEl);
            if (!$btn.hasClass('pk-confirming')) {
                $list.find('.pk-slot-delete-tool.pk-confirming').removeClass('pk-confirming');
                $btn.addClass('pk-confirming');
                const timerId = setTimeout(() => {
                    confirmTimers.delete(timerId);
                    $btn.removeClass('pk-confirming');
                }, INLINE_CONFIRM_TIMEOUT_MS);
                confirmTimers.add(timerId);
                return;
            }

            const deleted = await deleteSavedStates(slotName, true);
            if (deleted) {
                const { savedState: nextState } = getSavedStateFromCurrentChat();
                if (getSlotEntries(nextState).length > 0) {
                    openSlotPickerModal(mode);
                } else {
                    closeSlotPickerModal();
                }
            }
        }
    });

    $clearAllBtn.on(modalInteractionEvents, async function (e) {
        if (isGhostEventFromModalTrigger(e)) return;
        if (isTouchScrollGesture(runtimeState, e)) return;
        if (shouldSuppressSyntheticClick(this, e.type)) return;
        markTouchHandledForSyntheticClick(this, e.type);
        if (!shouldHandleInteraction(this)) return;
        e.preventDefault();
        e.stopPropagation();

        if (!$clearAllBtn.hasClass('pk-confirming')) {
            $clearAllBtn.addClass('pk-confirming');
            $clearAllBtn.find('.pk-clear-all-text').text('确认清空？');
            const timerId = setTimeout(() => {
                confirmTimers.delete(timerId);
                $clearAllBtn.removeClass('pk-confirming');
                $clearAllBtn.find('.pk-clear-all-text').text('清空全部');
            }, INLINE_CONFIRM_TIMEOUT_MS);
            confirmTimers.add(timerId);
            return;
        }

        const { chatMetadata } = getSavedStateFromCurrentChat();
        if (!chatMetadata) return;
        const cleared = await deleteSavedStates('__all__', true);
        if (cleared) closeSlotPickerModal();
    });

    const handleCloseModal = function (e) {
        if (isGhostEventFromModalTrigger(e)) return;
        if (isTouchScrollGesture(runtimeState, e)) return;
        if (shouldSuppressSyntheticClick(this, e.type)) return;
        markTouchHandledForSyntheticClick(this, e.type);
        if (!shouldHandleInteraction(this)) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        closeSlotPickerModal();
    };

    $closeBtn.on(modalInteractionEvents, handleCloseModal);
    $cancelBtn.on(modalInteractionEvents, handleCloseModal);

    $footer.append($clearAllBtn, $cancelBtn);
    $dialog.append($header, $list, $footer);
    $backdrop.append($dialog);
    jQuery('body').append($backdrop);

    const backdropDismissCleanup = bindModalBackdropIsolationAndDismiss(
        $backdrop,
        modalOpenedAt,
        () => closeSlotPickerModal()
    );
    const iosCleanup = bindIOSModalViewportAndScrollLock($backdrop, '.pk-slot-list');
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSlotPickerModal();
        }
    };
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', onKeyDown);
    }
    runtimeState.modalEscapeCleanup = () => {
        clearAllConfirmTimers();
        backdropDismissCleanup();
        iosCleanup();
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', onKeyDown);
        }
    };
}

export async function handleRestoreClick() {
    const { savedState } = getSavedStateFromCurrentChat();
    const entries = getSlotEntries(savedState);

    if (!savedState || entries.length === 0) {
        if (typeof toastr !== 'undefined') {
            toastr.info('当前聊天没有已保存的预设条目状态。', 'Prompt Keeper');
        }
        return;
    }

    if (entries.length === 1 && hasOwnSlot(savedState.slots, entries[0][0])) {
        await restoreStatesFromMetadata(true, null, entries[0][0]);
        return;
    }

    openSlotPickerModal('restore');
}

export async function handleDeleteClick() {
    const { savedState } = getSavedStateFromCurrentChat();
    const entries = getSlotEntries(savedState);

    if (!savedState || entries.length === 0) {
        if (typeof toastr !== 'undefined') {
            toastr.info('当前聊天没有已保存的预设条目状态。', 'Prompt Keeper');
        }
        return;
    }

    if (entries.length === 1 && hasOwnSlot(savedState.slots, entries[0][0])) {
        await deleteSavedStates(entries[0][0], false);
        return;
    }

    openSlotPickerModal('delete');
}
