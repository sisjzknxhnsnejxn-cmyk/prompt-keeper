/**
 * Prompt Keeper - 极简 iOS 适配输入弹窗与视口滚动锁定辅助
 */

import { runtimeState } from '../config/runtime-state.js';
import { loadPluginSettings, savePluginSettings } from '../core/settings.js';
import {
    isTouchScrollGesture,
    markTouchHandledForSyntheticClick,
    pkGetButtonEventTypes,
    resolveEventElement,
    shouldHandleInteraction,
    shouldSuppressSyntheticClick,
} from '../utils/dom-events.js';

const INPUT_MODAL_ID = 'prompt-keeper-input-modal';
const MODAL_OPEN_GUARD_MS = 320;

let activeInputModalCleanup = null;

function renderThemeIcon(isLight) {
    return isLight
        ? '<i class="fa-solid fa-sun"></i>'
        : '<i class="fa-solid fa-moon"></i>';
}

export function closeInputModal() {
    if (typeof activeInputModalCleanup === 'function') {
        const fn = activeInputModalCleanup;
        activeInputModalCleanup = null;
        fn();
    }
    if (typeof jQuery !== 'undefined') {
        jQuery(`#${INPUT_MODAL_ID}`).remove();
    }
}

/**
 * 绑定 iOS visualViewport 软键盘高度与偏移适配 + 背景防滚动穿透
 */
export function bindIOSModalViewportAndScrollLock($backdrop, scrollableSelector = null) {
    const cleanups = [];
    const backdropEl = $backdrop && $backdrop[0] ? $backdrop[0] : null;
    if (!backdropEl) return () => {};

    const onTouchMove = (e) => {
        if (!scrollableSelector) {
            if (e.cancelable) e.preventDefault();
            return;
        }
        const target = resolveEventElement(e);
        const scrollEl =
            target && typeof target.closest === 'function'
                ? target.closest(scrollableSelector)
                : null;
        if (!scrollEl) {
            if (e.cancelable) e.preventDefault();
            return;
        }
        if (scrollEl.scrollHeight <= scrollEl.clientHeight + 1) {
            if (e.cancelable) e.preventDefault();
        }
    };

    backdropEl.addEventListener('touchmove', onTouchMove, { passive: false });
    cleanups.push(() => backdropEl.removeEventListener('touchmove', onTouchMove));

    if (typeof window !== 'undefined' && window.visualViewport) {
        const vv = window.visualViewport;
        const syncViewport = () => {
            try {
                backdropEl.style.height = `${Math.round(vv.height)}px`;
                backdropEl.style.top = `${Math.round(vv.offsetTop)}px`;
            } catch (_) {}
        };
        syncViewport();
        vv.addEventListener('resize', syncViewport);
        vv.addEventListener('scroll', syncViewport);
        cleanups.push(() => {
            vv.removeEventListener('resize', syncViewport);
            vv.removeEventListener('scroll', syncViewport);
        });
    }

    return () => {
        for (const fn of cleanups) {
            try {
                fn();
            } catch (_) {}
        }
    };
}

/**
 * 打开极简槽位名称输入弹窗
 * @param {string} title 标题
 * @param {string} defaultValue 默认名称
 * @returns {Promise<string|null>}
 */
export function openSaveNameInputModal(title = '保存预设槽位', defaultValue = '') {
    if (typeof jQuery === 'undefined') {
        return Promise.resolve(
            typeof window !== 'undefined' && typeof window.prompt === 'function'
                ? window.prompt(title, defaultValue)
                : defaultValue
        );
    }

    closeInputModal();

    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            closeInputModal();
            resolve(val);
        };

        const modalOpenedAt = Date.now();
        let hasPointerDown = false;
        const settings = loadPluginSettings();
        let isLightTheme = settings.slotPickerTheme !== 'dark';
        const themeClass = isLightTheme ? 'pk-slot-theme-light' : 'pk-slot-theme-dark';

        const $backdrop = jQuery(
            `<div id="${INPUT_MODAL_ID}" class="pk-slot-modal-backdrop pk-input-modal-backdrop ${themeClass}" role="dialog" aria-modal="true"></div>`
        );
        const $dialog = jQuery('<div class="pk-slot-modal pk-input-modal-card"></div>');
        const $grabber = jQuery('<div class="pk-sheet-grabber" aria-hidden="true"></div>');

        const $header = jQuery('<div class="pk-slot-modal-header"></div>');
        const $titleWrap = jQuery('<div class="pk-slot-modal-title-wrap"></div>');
        $titleWrap.append(
            jQuery('<span class="pk-modal-title-icon"><i class="fa-solid fa-bookmark"></i></span>'),
            jQuery('<div class="pk-slot-modal-title"></div>').text(title)
        );

        const $tools = jQuery('<div class="pk-slot-modal-tools"></div>');
        const $themeBtn = jQuery(
            `<button type="button" class="pk-slot-theme-btn pk-icon-only-btn" title="切换日间 / 夜间模式">${renderThemeIcon(isLightTheme)}</button>`
        );
        const $closeBtn = jQuery(
            '<button type="button" class="pk-slot-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>'
        );
        $tools.append($themeBtn, $closeBtn);
        $header.append($titleWrap, $tools);

        const $body = jQuery('<div class="pk-input-modal-body"></div>');
        const $inputWrap = jQuery('<div class="pk-input-field-wrap"></div>');
        const $input = jQuery(
            '<input type="text" class="pk-input-field" maxlength="60" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入槽位名称" />'
        ).val(defaultValue || '');
        const $clearInputBtn = jQuery(
            '<button type="button" class="pk-input-clear-btn" title="清空"><i class="fa-solid fa-circle-xmark"></i></button>'
        );
        $inputWrap.append($input, $clearInputBtn);
        $body.append($inputWrap);

        const $footer = jQuery('<div class="pk-input-modal-footer"></div>');
        const $cancelBtn = jQuery(
            '<button type="button" class="pk-slot-cancel-btn"><span>取消</span></button>'
        );
        const $confirmBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-primary pk-input-submit-btn"><i class="fa-solid fa-check"></i><span>保存</span></button>'
        );
        $footer.append($cancelBtn, $confirmBtn);

        $dialog.append($grabber, $header, $body, $footer);
        $backdrop.append($dialog);
        jQuery('body').append($backdrop);
        const syncClearBtnVisibility = () => {
            const hasVal = String($input.val() || '').length > 0;
            $clearInputBtn.toggleClass('pk-visible', hasVal);
        };
        syncClearBtnVisibility();
        $input.on('input', syncClearBtnVisibility);

        const modalEvents = pkGetButtonEventTypes().join(' ');
        $backdrop.on('pointerdown touchstart mousedown', () => {
            hasPointerDown = true;
        });

        const isGhost = (e) => {
            if (hasPointerDown) return false;
            if (Date.now() - modalOpenedAt < MODAL_OPEN_GUARD_MS) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                return true;
            }
            return false;
        };

        $themeBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
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
            $themeBtn.html(renderThemeIcon(isLightTheme));
        });

        $clearInputBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            e.preventDefault();
            e.stopPropagation();
            $input.val('');
            syncClearBtnVisibility();
            $input.trigger('focus');
        });

        const submitValue = () => {
            const val = String($input.val() || '').trim();
            finish(val || defaultValue || '');
        };

        $confirmBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            e.preventDefault();
            e.stopPropagation();
            submitValue();
        });

        const cancelModal = function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            e.preventDefault();
            e.stopPropagation();
            finish(null);
        };

        $cancelBtn.on(modalEvents, cancelModal);
        $closeBtn.on(modalEvents, cancelModal);
        $backdrop.on(modalEvents, function (e) {
            const resolved = resolveEventElement(e) || e.target;
            if (resolved === $backdrop[0] || e.target === $backdrop[0]) {
                cancelModal.call(this, e);
            }
        });

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(null);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                submitValue();
            }
        };

        const iosCleanup = bindIOSModalViewportAndScrollLock($backdrop, null);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', onKeyDown);
        }

        activeInputModalCleanup = () => {
            iosCleanup();
            if (typeof document !== 'undefined') {
                document.removeEventListener('keydown', onKeyDown);
            }
            if (!settled) {
                settled = true;
                resolve(null);
            }
        };

        setTimeout(() => {
            try {
                const inputEl = $input[0];
                if (inputEl) {
                    inputEl.focus();
                    inputEl.select();
                }
            } catch (_) {}
        }, 40);
    });
}

/**
 * 打开极简二次确认弹窗（用于单槽位快捷删除确认）
 * @param {string} message 确认提示语
 * @returns {Promise<boolean>}
 */
export function openConfirmModal(message = '确认删除？') {
    if (typeof jQuery === 'undefined') {
        return Promise.resolve(
            typeof window !== 'undefined' && typeof window.confirm === 'function'
                ? window.confirm(message)
                : true
        );
    }

    closeInputModal();

    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            closeInputModal();
            resolve(Boolean(val));
        };

        const modalOpenedAt = Date.now();
        let hasPointerDown = false;
        const settings = loadPluginSettings();
        let isLightTheme = settings.slotPickerTheme !== 'dark';
        const themeClass = isLightTheme ? 'pk-slot-theme-light' : 'pk-slot-theme-dark';

        const $backdrop = jQuery(
            `<div id="${INPUT_MODAL_ID}" class="pk-slot-modal-backdrop pk-input-modal-backdrop ${themeClass}" role="dialog" aria-modal="true"></div>`
        );
        const $dialog = jQuery('<div class="pk-slot-modal pk-input-modal-card pk-confirm-modal-card"></div>');
        const $grabber = jQuery('<div class="pk-sheet-grabber" aria-hidden="true"></div>');

        const $header = jQuery('<div class="pk-slot-modal-header"></div>');
        const $titleWrap = jQuery('<div class="pk-slot-modal-title-wrap"></div>');
        $titleWrap.append(
            jQuery('<span class="pk-modal-title-icon pk-modal-title-icon-danger"><i class="fa-solid fa-trash-can"></i></span>'),
            jQuery('<div class="pk-slot-modal-title"></div>').text('确认操作')
        );

        const $tools = jQuery('<div class="pk-slot-modal-tools"></div>');
        const $closeBtn = jQuery(
            '<button type="button" class="pk-slot-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>'
        );
        $tools.append($closeBtn);
        $header.append($titleWrap, $tools);

        const $body = jQuery('<div class="pk-confirm-modal-body"></div>').text(message);

        const $footer = jQuery('<div class="pk-input-modal-footer"></div>');
        const $cancelBtn = jQuery(
            '<button type="button" class="pk-slot-cancel-btn"><span>取消</span></button>'
        );
        const $confirmBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-danger pk-confirm-submit-btn"><i class="fa-solid fa-trash-can"></i><span>删除</span></button>'
        );
        $footer.append($cancelBtn, $confirmBtn);

        $dialog.append($grabber, $header, $body, $footer);
        $backdrop.append($dialog);
        jQuery('body').append($backdrop);

        const modalEvents = pkGetButtonEventTypes().join(' ');
        $backdrop.on('pointerdown touchstart mousedown', () => {
            hasPointerDown = true;
        });

        const isGhost = (e) => {
            if (hasPointerDown) return false;
            if (Date.now() - modalOpenedAt < MODAL_OPEN_GUARD_MS) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                return true;
            }
            return false;
        };

        $confirmBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            e.preventDefault();
            e.stopPropagation();
            finish(true);
        });

        const cancelModal = function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            e.preventDefault();
            e.stopPropagation();
            finish(false);
        };

        $cancelBtn.on(modalEvents, cancelModal);
        $closeBtn.on(modalEvents, cancelModal);
        $backdrop.on(modalEvents, function (e) {
            const resolved = resolveEventElement(e) || e.target;
            if (resolved === $backdrop[0] || e.target === $backdrop[0]) {
                cancelModal.call(this, e);
            }
        });

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            }
        };

        const iosCleanup = bindIOSModalViewportAndScrollLock($backdrop, null);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', onKeyDown);
        }

        activeInputModalCleanup = () => {
            iosCleanup();
            if (typeof document !== 'undefined') {
                document.removeEventListener('keydown', onKeyDown);
            }
            if (!settled) {
                settled = true;
                resolve(false);
            }
        };
    });
}

