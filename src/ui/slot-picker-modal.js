/**
 * Prompt Keeper - 预设槽位选择与管理模态弹窗
 */

import { MAX_SLOTS_PER_CHAT } from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { loadPluginSettings } from '../core/settings.js';
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
import { getSlotMetaLabel, hasOwnSlot } from '../utils/format.js';

const MODAL_OPEN_GUARD_MS = 350;

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
    const themeClass =
        settings.slotPickerTheme === 'light' ? 'pk-slot-theme-light' : 'pk-slot-theme-dark';

    const $backdrop = jQuery(
        `<div id="prompt-keeper-slot-modal" class="pk-slot-modal-backdrop pk-modal-overlay ${themeClass}" role="dialog" aria-modal="true"></div>`
    );
    const $dialog = jQuery('<div class="pk-slot-modal pk-modal-card"></div>');
    const titleText = mode === 'delete' ? '选择要删除的预设槽位' : '管理 / 恢复已保存预设槽位';
    const subtitleText = `当前聊天已保存 ${entries.length}/${MAX_SLOTS_PER_CHAT} 个槽位${currentPreset ? ` · 当前预设：${currentPreset}` : ''}`;

    const $header = jQuery('<div class="pk-slot-modal-header"></div>');
    const $headerText = jQuery('<div></div>');
    $headerText.append(jQuery('<div class="pk-slot-modal-title"></div>').text(titleText));
    $headerText.append(jQuery('<div class="pk-slot-modal-subtitle"></div>').text(subtitleText));
    const $closeBtn = jQuery(
        '<button type="button" class="menu_button pk-slot-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>'
    );
    $header.append($headerText, $closeBtn);

    const $list = jQuery('<div class="pk-slot-list"></div>');

    for (const [slotName, slot] of entries) {
        const count = slot && slot.prompts ? Object.keys(slot.prompts).length : 0;
        const hasOrder = Boolean(slot && slot.promptOrder);
        const metaLabel = getSlotMetaLabel(slotName, slot);
        const isCurrentPreset = matchedSlotName === slotName;
        const isDefaultSlot = defaultSlotName === slotName;

        const $item = jQuery('<div class="pk-slot-item"></div>');
        const $info = jQuery('<div class="pk-slot-info"></div>');
        const $nameRow = jQuery('<div class="pk-slot-name-row"></div>');
        $nameRow.append(jQuery('<span class="pk-slot-name"></span>').text(slotName));

        if (isCurrentPreset) {
            $nameRow.append(
                jQuery('<span class="pk-slot-badge pk-slot-badge-current">当前预设</span>')
            );
        }
        if (isDefaultSlot) {
            $nameRow.append(
                jQuery('<span class="pk-slot-badge pk-slot-badge-default">自动恢复默认</span>')
            );
        }

        const $meta = jQuery('<div class="pk-slot-meta"></div>').text(
            `${count} 个条目开关${hasOrder ? ' + 排列顺序' : ''} · ${metaLabel}`
        );
        $info.append($nameRow, $meta);

        const $actions = jQuery('<div class="pk-slot-item-actions"></div>');

        const $restoreSlotBtn = jQuery(
            '<button type="button" class="menu_button prompt-keeper-btn pk-slot-action-btn" title="切换到该槽位所属预设并完整恢复条目状态"><i class="fa-solid fa-rotate-left"></i><span>恢复</span></button>'
        );
        $restoreSlotBtn.attr('data-pk-slot-action', 'restore').attr('data-pk-slot-name', slotName);

        const $applyCurrentBtn = jQuery(
            '<button type="button" class="menu_button prompt-keeper-btn pk-slot-action-btn" title="不切换当前预设，仅将该槽位的同名条目开关与顺序套用到当前预设"><i class="fa-solid fa-wand-magic-sparkles"></i><span>仅套用条目</span></button>'
        );
        $applyCurrentBtn
            .attr('data-pk-slot-action', 'apply-current')
            .attr('data-pk-slot-name', slotName);

        const $defaultBtn = jQuery(
            `<button type="button" class="menu_button prompt-keeper-btn pk-slot-action-btn" ${isDefaultSlot ? 'disabled' : ''} title="设为打开此聊天时自动恢复的默认槽位"><i class="fa-solid fa-star"></i><span>${isDefaultSlot ? '默认' : '设默认'}</span></button>`
        );
        if (!isDefaultSlot) {
            $defaultBtn
                .attr('data-pk-slot-action', 'set-default')
                .attr('data-pk-slot-name', slotName);
        }

        const $deleteSlotBtn = jQuery(
            '<button type="button" class="menu_button prompt-keeper-btn prompt-keeper-btn-danger pk-slot-action-btn" title="删除此槽位"><i class="fa-solid fa-trash-can"></i></button>'
        );
        $deleteSlotBtn.attr('data-pk-slot-action', 'delete').attr('data-pk-slot-name', slotName);

        $actions.append($restoreSlotBtn, $applyCurrentBtn, $defaultBtn, $deleteSlotBtn);
        $item.append($info, $actions);
        $list.append($item);
    }


    const $footer = jQuery('<div class="pk-slot-modal-footer"></div>');
    const $clearAllBtn = jQuery(
        '<button type="button" class="menu_button prompt-keeper-btn prompt-keeper-btn-danger"><i class="fa-solid fa-broom"></i><span>清空全部槽位</span></button>'
    );
    const $cancelBtn = jQuery(
        '<button type="button" class="menu_button prompt-keeper-btn"><span>关闭</span></button>'
    );

    const modalInteractionEvents = pkGetButtonEventTypes().join(' ');

    $backdrop.on('pointerdown touchstart mousedown', () => {
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
            const deleted = await deleteSavedStates(slotName, false);
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

        const { chatMetadata } = getSavedStateFromCurrentChat();
        if (!chatMetadata) return;
        const cleared = await deleteSavedStates('__all__', false);
        if (cleared) closeSlotPickerModal();
    });

    const handleCloseModal = function (e) {
        if (isGhostEventFromModalTrigger(e)) return;
        if (isTouchScrollGesture(runtimeState, e)) return;
        if (shouldSuppressSyntheticClick(this, e.type)) return;
        markTouchHandledForSyntheticClick(this, e.type);
        if (!shouldHandleInteraction(this)) return;
        e.preventDefault();
        e.stopPropagation();
        closeSlotPickerModal();
    };

    $closeBtn.on(modalInteractionEvents, handleCloseModal);
    $cancelBtn.on(modalInteractionEvents, handleCloseModal);
    $backdrop.on(modalInteractionEvents, function (e) {
        const resolvedTarget = resolveEventElement(e) || e.target;
        if (resolvedTarget === $backdrop[0] || e.target === $backdrop[0]) {
            if (isGhostEventFromModalTrigger(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            e.preventDefault();
            closeSlotPickerModal();
        }
    });

    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSlotPickerModal();
        }
    };
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', onKeyDown);
        runtimeState.modalEscapeCleanup = () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }

    $footer.append($clearAllBtn, $cancelBtn);
    $dialog.append($header, $list, $footer);
    $backdrop.append($dialog);
    jQuery('body').append($backdrop);
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
