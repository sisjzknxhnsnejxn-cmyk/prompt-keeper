/**
 * Prompt Keeper - 顶栏状态显示刷新模块
 */

import { MAX_SLOTS_PER_CHAT } from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import {
    getSavedStateFromCurrentChat,
    getSlotEntries,
} from '../core/state-migration.js';

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

    const domSig = $status.attr('data-pk-sig') || '';
    if (
        payload.signature === runtimeState.lastStatusDisplaySignature &&
        domSig === payload.signature
    ) {
        return;
    }
    runtimeState.lastStatusDisplaySignature = payload.signature;
    $status.attr('data-pk-sig', payload.signature);

    if (!payload.hasSlots) {
        $status
            .text('未保存')
            .removeClass('saved pk-saved')
            .addClass('not-saved pk-not-saved')
            .removeAttr('title');
        $deleteBtn.hide();
        $restoreBtn
            .prop('disabled', true)
            .addClass('disabled')
            .attr('title', '恢复');
        return;
    }

    $status
        .text(payload.statusText)
        .removeClass('not-saved pk-not-saved')
        .addClass('saved pk-saved')
        .removeAttr('title');
    $deleteBtn
        .show()
        .attr('title', '删除');
    $restoreBtn
        .prop('disabled', false)
        .removeClass('disabled')
        .attr('title', '恢复');
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
            const statusText =
                entries.length > 1
                    ? `已保存 ${entries.length}/${MAX_SLOTS_PER_CHAT}`
                    : '已保存';

            scheduleStatusDisplayRender({
                hasSlots: true,
                statusText,
                signature: `saved|${statusText}`,
            });
            return;
        }
    } catch (_) {}

    scheduleStatusDisplayRender({
        hasSlots: false,
        signature: 'empty',
    });
}
