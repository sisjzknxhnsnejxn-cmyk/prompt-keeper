/**
 * Prompt Keeper - 顶栏状态显示刷新模块
 */

import { MAX_SLOTS_PER_CHAT } from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import {
    findSlotName,
    getDefaultSlotName,
    getDefaultSlotState,
    getSavedStateFromCurrentChat,
    getSlotEntries,
} from '../core/state-migration.js';
import { getCurrentPresetName } from '../services/preset-service.js';
import { formatTime } from '../utils/format.js';

export function flushStatusDisplayUpdate() {
    runtimeState.statusDisplayRafId = null;

    if (typeof jQuery === 'undefined') return;
    const $status = jQuery('#prompt-keeper-status');
    const $deleteBtn = jQuery('#prompt-keeper-delete');
    const $restoreBtn = jQuery('#prompt-keeper-restore');
    if ($status.length === 0) return;

    const payload = runtimeState.pendingStatusDisplay;
    runtimeState.pendingStatusDisplay = null;
    if (!payload) return;

    if (payload.signature === runtimeState.lastStatusDisplaySignature) {
        return;
    }
    runtimeState.lastStatusDisplaySignature = payload.signature;

    if (!payload.hasSlots) {
        $status
            .text('未保存')
            .removeClass('saved pk-saved')
            .addClass('not-saved pk-not-saved')
            .attr('title', '当前聊天尚未保存任何预设槽位');
        $deleteBtn.hide();
        $restoreBtn
            .prop('disabled', true)
            .addClass('disabled')
            .attr('title', '当前聊天没有已保存的预设槽位');
        return;
    }

    $status
        .text(payload.statusText)
        .removeClass('not-saved pk-not-saved')
        .addClass('saved pk-saved')
        .attr('title', payload.statusTitle);
    $deleteBtn
        .show()
        .attr('title', payload.deleteTitle);
    $restoreBtn
        .prop('disabled', false)
        .removeClass('disabled')
        .attr('title', payload.restoreTitle);
}

export function scheduleStatusDisplayRender(payload) {
    runtimeState.pendingStatusDisplay = payload;
    if (typeof requestAnimationFrame !== 'function') {
        flushStatusDisplayUpdate();
        return;
    }
    if (runtimeState.statusDisplayRafId) return;
    runtimeState.statusDisplayRafId = requestAnimationFrame(flushStatusDisplayUpdate);
}

export function updateStatusDisplay() {
    if (typeof jQuery === 'undefined') return;
    const $status = jQuery('#prompt-keeper-status');
    if ($status.length === 0) return;

    try {
        const { savedState } = getSavedStateFromCurrentChat();
        const entries = getSlotEntries(savedState);

        if (savedState && entries.length > 0) {
            const currentPreset = getCurrentPresetName();
            const matchedSlotName = currentPreset ? findSlotName(savedState, currentPreset) : null;
            const defaultSlotName = getDefaultSlotName(savedState);
            const activeSlotName = matchedSlotName || defaultSlotName || entries[0][0];
            const activeSlot = savedState.slots[activeSlotName] || getDefaultSlotState(savedState);

            const count =
                activeSlot && activeSlot.prompts ? Object.keys(activeSlot.prompts).length : 0;
            const hasOrder = Boolean(activeSlot && activeSlot.promptOrder);
            const timeStr = formatTime(activeSlot && activeSlot.savedAt);
            const orderTag = hasOrder ? '+序' : '';
            const slotBadge = `${entries.length}/${MAX_SLOTS_PER_CHAT}槽`;
            const displayPreset =
                activeSlotName.length > 10 ? `${activeSlotName.slice(0, 10)}…` : activeSlotName;
            const slotMatchHint = matchedSlotName
                ? `当前匹配槽位: ${matchedSlotName}`
                : `默认恢复槽位: ${activeSlotName}`;
            const statusText = `已存 (${slotBadge} · ${displayPreset} · ${count}项${orderTag}${timeStr ? ' · ' + timeStr : ''})`;
            const statusTitle = `${slotMatchHint} | 共 ${entries.length}/${MAX_SLOTS_PER_CHAT} 个槽位`;
            const deleteTitle =
                entries.length > 1
                    ? '删除某个已保存槽位或清空全部槽位'
                    : `删除槽位「${activeSlotName}」`;
            const restoreTitle =
                entries.length > 1
                    ? `点击选择要恢复的预设槽位（当前共 ${entries.length} 个）`
                    : `恢复槽位「${activeSlotName}」的预设条目状态和顺序`;

            scheduleStatusDisplayRender({
                hasSlots: true,
                statusText,
                statusTitle,
                deleteTitle,
                restoreTitle,
                signature: `saved|${statusText}|${statusTitle}|${deleteTitle}|${restoreTitle}`,
            });
            return;
        }
    } catch (_) {}

    scheduleStatusDisplayRender({
        hasSlots: false,
        signature: 'empty',
    });
}
