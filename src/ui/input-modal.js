/**
 * Prompt Keeper - 极简 iOS 适配输入弹窗与视口滚动锁定辅助
 */

import { runtimeState } from '../config/runtime-state.js';
import { loadPluginSettings, savePluginSettings } from '../core/settings.js';
import {
    isTouchScrollGesture,
    markTouchHandledForSyntheticClick,
    pkGetButtonEventTypes,
    pkIsCoarsePointerDevice,
    resolveEventElement,
    shouldHandleInteraction,
    shouldSuppressSyntheticClick,
} from '../utils/dom-events.js';

const INPUT_MODAL_ID = 'prompt-keeper-input-modal';
const MODAL_OPEN_GUARD_MS = 380;

let activeInputModalCleanup = null;

function renderThemeIcon(isLight) {
    return isLight
        ? '<i class="fa-solid fa-sun"></i><span>日间</span>'
        : '<i class="fa-solid fa-moon"></i><span>夜间</span>';
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
 * 隔离弹窗事件向 document / body 的冒泡（防止触发 SillyTavern 顶栏抽屉的“点击外部自动收起”逻辑），
 * 并严格校验遮罩层点击关闭（必须按下起点与抬起终点均在遮罩自身，杜绝 iOS 软键盘位移导致误关弹窗）。
 */
export function bindModalBackdropIsolationAndDismiss($backdrop, modalOpenedAt, onDismiss) {
    const backdropEl = $backdrop && $backdrop[0] ? $backdrop[0] : null;
    if (!backdropEl) return () => {};

    let pointerDownOnBackdrop = false;
    let pointerDownCoords = null;

    const getPoint = (e) => {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        if (e.changedTouches && e.changedTouches.length > 0) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        }
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
            return { x: e.clientX, y: e.clientY };
        }
        return null;
    };

    const onPointerStart = (e) => {
        e.stopPropagation();
        const target = resolveEventElement(e) || e.target;
        if (
            (target === backdropEl || e.target === backdropEl) &&
            Date.now() - modalOpenedAt >= MODAL_OPEN_GUARD_MS
        ) {
            pointerDownOnBackdrop = true;
            pointerDownCoords = getPoint(e);
        } else {
            pointerDownOnBackdrop = false;
            pointerDownCoords = null;
        }
    };

    const onPointerEnd = (e) => {
        e.stopPropagation();
        const target = resolveEventElement(e) || e.target;
        const isBackdropTarget = target === backdropEl || e.target === backdropEl;

        if (!pointerDownOnBackdrop || !isBackdropTarget) {
            if (e.type === 'click' || !isBackdropTarget) {
                pointerDownOnBackdrop = false;
                pointerDownCoords = null;
            }
            return;
        }

        if (Date.now() - modalOpenedAt < MODAL_OPEN_GUARD_MS) {
            pointerDownOnBackdrop = false;
            pointerDownCoords = null;
            return;
        }

        const pt = getPoint(e);
        if (pt && pointerDownCoords) {
            const dx = Math.abs(pt.x - pointerDownCoords.x);
            const dy = Math.abs(pt.y - pointerDownCoords.y);
            if (dx > 14 || dy > 14) {
                pointerDownOnBackdrop = false;
                pointerDownCoords = null;
                return;
            }
        }

        pointerDownOnBackdrop = false;
        pointerDownCoords = null;
        if (e.cancelable) e.preventDefault();
        if (typeof onDismiss === 'function') {
            onDismiss();
        }
    };

    const stopBubbleOnly = (e) => {
        e.stopPropagation();
    };

    const startEvents = ['pointerdown', 'touchstart', 'mousedown'];
    const endEvents = ['pointerup', 'touchend', 'mouseup', 'click'];

    for (const evt of startEvents) {
        backdropEl.addEventListener(evt, onPointerStart, false);
    }
    for (const evt of endEvents) {
        backdropEl.addEventListener(evt, onPointerEnd, false);
    }
    backdropEl.addEventListener('contextmenu', stopBubbleOnly, false);

    return () => {
        for (const evt of startEvents) {
            backdropEl.removeEventListener(evt, onPointerStart, false);
        }
        for (const evt of endEvents) {
            backdropEl.removeEventListener(evt, onPointerEnd, false);
        }
        backdropEl.removeEventListener('contextmenu', stopBubbleOnly, false);
    };
}

/**
 * 绑定 iOS visualViewport 软键盘高度与偏移适配 + 背景防滚动穿透
 */
export function bindIOSModalViewportAndScrollLock($backdrop, scrollableSelector = null) {
    const cleanups = [];
    const backdropEl = $backdrop && $backdrop[0] ? $backdrop[0] : null;
    if (!backdropEl) return () => {};

    const onTouchMove = (e) => {
        const target = resolveEventElement(e);
        if (
            target &&
            typeof target.closest === 'function' &&
            target.closest('input, textarea, select')
        ) {
            return;
        }

        if (!scrollableSelector) {
            if (e.cancelable) e.preventDefault();
            return;
        }
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
        let rafId = null;
        let lastHeight = 0;
        let lastTop = -9999;

        const applyViewport = () => {
            rafId = null;
            try {
                const nextHeight = Math.round(vv.height);
                const nextTop = Math.round(vv.offsetTop);
                if (Math.abs(nextHeight - lastHeight) >= 1) {
                    lastHeight = nextHeight;
                    backdropEl.style.height = `${nextHeight}px`;
                }
                if (Math.abs(nextTop - lastTop) >= 1) {
                    lastTop = nextTop;
                    backdropEl.style.top = `${nextTop}px`;
                }
            } catch (_) {}
        };

        const scheduleSync = () => {
            if (rafId !== null) return;
            if (typeof requestAnimationFrame === 'function') {
                rafId = requestAnimationFrame(applyViewport);
            } else {
                applyViewport();
            }
        };

        applyViewport();
        vv.addEventListener('resize', scheduleSync);
        vv.addEventListener('scroll', scheduleSync);
        cleanups.push(() => {
            if (rafId !== null && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            vv.removeEventListener('resize', scheduleSync);
            vv.removeEventListener('scroll', scheduleSync);
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
export function openSaveNameInputModal(title = '命名预设槽位', defaultValue = '') {
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
            const inputEl = $input && $input[0] ? $input[0] : null;
            if (inputEl && typeof inputEl.blur === 'function') {
                try {
                    inputEl.blur();
                } catch (_) {}
            }
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

        const $header = jQuery('<div class="pk-slot-modal-header"></div>');
        const $titleWrap = jQuery('<div class="pk-slot-modal-title-wrap"></div>');
        $titleWrap.append(
            jQuery('<div class="pk-slot-modal-title"></div>').text(title)
        );

        const $tools = jQuery('<div class="pk-slot-modal-tools"></div>');
        const $themeBtn = jQuery(
            `<button type="button" class="pk-slot-theme-btn" title="切换日间 / 夜间模式">${renderThemeIcon(isLightTheme)}</button>`
        );
        const $closeBtn = jQuery(
            '<button type="button" class="pk-slot-close-btn" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>'
        );
        $tools.append($themeBtn, $closeBtn);
        $header.append($titleWrap, $tools);

        const $body = jQuery('<div class="pk-input-modal-body"></div>');
        const $inputWrap = jQuery('<div class="pk-input-field-wrap"></div>');
        const $input = jQuery(
            '<input type="text" class="pk-input-field" maxlength="60" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="输入槽位名称" />'
        ).val(defaultValue || '');
        const $clearInputBtn = jQuery(
            '<button type="button" class="pk-input-clear-btn" title="清空" tabindex="-1"><i class="fa-solid fa-circle-xmark"></i></button>'
        );
        $inputWrap.append($input, $clearInputBtn);
        $body.append($inputWrap);

        const $footer = jQuery('<div class="pk-input-modal-footer"></div>');
        const $cancelBtn = jQuery(
            '<button type="button" class="pk-slot-cancel-btn"><span>取消</span></button>'
        );
        const $confirmBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-primary pk-input-submit-btn"><span>保存</span></button>'
        );
        $footer.append($cancelBtn, $confirmBtn);

        $dialog.append($header, $body, $footer);
        $backdrop.append($dialog);
        jQuery('body').append($backdrop);
        const syncClearBtnVisibility = () => {
            const hasVal = String($input.val() || '').length > 0;
            $clearInputBtn.toggleClass('pk-visible', hasVal);
        };
        syncClearBtnVisibility();
        $input.on('input', syncClearBtnVisibility);

        const modalEvents = pkGetButtonEventTypes().join(' ');
        $dialog.on('pointerdown touchstart mousedown', () => {
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

        // 清空按钮在按下阶段阻止输入框失焦，防止 iOS 软键盘闪烁收起
        $clearInputBtn.on('pointerdown touchstart mousedown', function (e) {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
        });

        $clearInputBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            $input.val('');
            syncClearBtnVisibility();
            if ($input[0] && typeof $input[0].focus === 'function') {
                try {
                    $input[0].focus({ preventScroll: true });
                } catch (_) {
                    $input.trigger('focus');
                }
            }
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
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            submitValue();
        });

        const cancelModal = function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            finish(null);
        };

        $cancelBtn.on(modalEvents, cancelModal);
        $closeBtn.on(modalEvents, cancelModal);

        $input.on('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(null);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                submitValue();
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

        const backdropDismissCleanup = bindModalBackdropIsolationAndDismiss(
            $backdrop,
            modalOpenedAt,
            () => finish(null)
        );
        const iosCleanup = bindIOSModalViewportAndScrollLock($backdrop, null);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', onKeyDown);
        }

        activeInputModalCleanup = () => {
            backdropDismissCleanup();
            iosCleanup();
            if (typeof document !== 'undefined') {
                document.removeEventListener('keydown', onKeyDown);
            }
            if (!settled) {
                settled = true;
                resolve(null);
            }
        };

        // 仅在桌面端自动聚焦全选；iOS / 触屏端避免异步假聚焦引发选区与视口抖动
        if (!pkIsCoarsePointerDevice()) {
            setTimeout(() => {
                try {
                    const inputEl = $input[0];
                    if (inputEl && !settled) {
                        inputEl.focus({ preventScroll: true });
                        inputEl.select();
                    }
                } catch (_) {}
            }, 30);
        }
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

        const $header = jQuery('<div class="pk-slot-modal-header"></div>');
        const $titleWrap = jQuery('<div class="pk-slot-modal-title-wrap"></div>');
        $titleWrap.append(
            jQuery('<div class="pk-slot-modal-title"></div>').text('确认删除')
        );

        const $tools = jQuery('<div class="pk-slot-modal-tools"></div>');
        const $themeBtn = jQuery(
            `<button type="button" class="pk-slot-theme-btn" title="切换日间 / 夜间模式">${renderThemeIcon(isLightTheme)}</button>`
        );
        const $closeBtn = jQuery(
            '<button type="button" class="pk-slot-close-btn" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>'
        );
        $tools.append($themeBtn, $closeBtn);
        $header.append($titleWrap, $tools);

        const $body = jQuery('<div class="pk-confirm-modal-body"></div>').text(message);

        const $footer = jQuery('<div class="pk-input-modal-footer"></div>');
        const $cancelBtn = jQuery(
            '<button type="button" class="pk-slot-cancel-btn"><span>取消</span></button>'
        );
        const $confirmBtn = jQuery(
            '<button type="button" class="pk-slot-action-btn pk-slot-action-danger pk-confirm-submit-btn"><span>删除</span></button>'
        );
        $footer.append($cancelBtn, $confirmBtn);

        $dialog.append($header, $body, $footer);
        $backdrop.append($dialog);
        jQuery('body').append($backdrop);

        const modalEvents = pkGetButtonEventTypes().join(' ');
        $dialog.on('pointerdown touchstart mousedown', () => {
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
            if (e.cancelable) e.preventDefault();
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

        $confirmBtn.on(modalEvents, function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            finish(true);
        });

        const cancelModal = function (e) {
            if (isGhost(e)) return;
            if (isTouchScrollGesture(runtimeState, e)) return;
            if (shouldSuppressSyntheticClick(this, e.type)) return;
            markTouchHandledForSyntheticClick(this, e.type);
            if (!shouldHandleInteraction(this)) return;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            finish(false);
        };

        $cancelBtn.on(modalEvents, cancelModal);
        $closeBtn.on(modalEvents, cancelModal);

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            }
        };

        const backdropDismissCleanup = bindModalBackdropIsolationAndDismiss(
            $backdrop,
            modalOpenedAt,
            () => finish(false)
        );
        const iosCleanup = bindIOSModalViewportAndScrollLock($backdrop, null);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', onKeyDown);
        }

        activeInputModalCleanup = () => {
            backdropDismissCleanup();
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

