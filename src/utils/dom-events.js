/**
 * Prompt Keeper - 性能、设备检测与 iOS/触屏零漏点交互辅助函数
 */

import { INTERACTION_DEBOUNCE_MS, TOUCH_MOVE_THRESHOLD_PX } from '../config/constants.js';

/**
 * 检测当前设备是否为 iOS / iPadOS 设备（兼容 iPadOS 13+ 桌面级 Macintosh UA）
 */
export function isIOSDevice() {
    try {
        if (typeof navigator === 'undefined') return false;
        const ua = String(navigator.userAgent || '');
        const platform = String(navigator.platform || '');
        if (/iPad|iPhone|iPod/i.test(ua) || /iPad|iPhone|iPod/i.test(platform)) {
            return true;
        }
        return /Macintosh|MacIntel/i.test(ua + ' ' + platform) && Number(navigator.maxTouchPoints || 0) > 1;
    } catch (_) {
        return false;
    }
}

/**
 * 检测当前设备是否为粗指针（触屏/iOS/移动端）设备
 */
export function pkIsCoarsePointerDevice() {
    try {
        if (typeof window === 'undefined') return false;
        return Boolean(
            isIOSDevice() ||
            (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
            (typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0)) ||
            'ontouchstart' in window
        );
    } catch (_) {
        return false;
    }
}

/**
 * 获取当前设备下应绑定的按钮事件列表
 * PC 端仅需 click，避免多套捕获/冒泡监听器在高频 hover 下放大开销；
 * 触屏设备同时绑定 pointerup / touchend / click 并配合滚动手势过滤与合成 click 抑制。
 */
export function pkGetButtonEventTypes() {
    if (!pkIsCoarsePointerDevice()) return ['click'];

    return [
        ...(typeof window !== 'undefined' && window.PointerEvent ? ['pointerup'] : []),
        'touchend',
        'click',
    ];
}

/**
 * 从 DOM 事件中安全提取 Element 目标（修复 iOS Safari 中 event.target 为 Text 文本节点导致 closest 失败的问题）
 */
export function resolveEventElement(event) {
    if (!event || !event.target) return null;
    const rawTarget = event.target;
    if (typeof Element !== 'undefined' && rawTarget instanceof Element) {
        return rawTarget;
    }
    if (rawTarget.nodeType === 1) {
        return rawTarget;
    }
    if (rawTarget.nodeType === 3 && rawTarget.parentElement) {
        return rawTarget.parentElement;
    }
    return null;
}

/**
 * 提取事件中的屏幕坐标点
 */
export function getEventPoint(event) {
    if (!event) return null;
    const orig = event.originalEvent || event;
    if (orig.changedTouches && orig.changedTouches.length > 0) {
        return { x: orig.changedTouches[0].clientX, y: orig.changedTouches[0].clientY };
    }
    if (orig.touches && orig.touches.length > 0) {
        return { x: orig.touches[0].clientX, y: orig.touches[0].clientY };
    }
    if (typeof orig.clientX === 'number' && typeof orig.clientY === 'number') {
        return { x: orig.clientX, y: orig.clientY };
    }
    return null;
}

const TOUCH_GESTURE_MAX_AGE_MS = 1500;

/**
 * 判断事件是否来自触屏或触控笔（排除 PC 鼠标移动与键盘触发的合成 click）
 */
export function isTouchLikeEvent(event) {
    if (!event) return false;
    const orig = event.originalEvent || event;
    const type = String(orig.type || event.type || '');
    if (type.startsWith('touch')) {
        return true;
    }
    if (type.startsWith('pointer')) {
        const pointerType = String(orig.pointerType || event.pointerType || '').toLowerCase();
        return pointerType === 'touch' || pointerType === 'pen';
    }
    return false;
}

/**
 * 记录触屏按下起点，并在手指滑动超过阈值时标记为滚动手势（防止 iOS 上滑动预设列表时误触按钮或锁死防抖）
 * 仅对触屏/触控笔事件生效，避免 PC 端鼠标移动污染 touchStartCoords.moved 状态。
 */
export function recordTouchStart(stateHolder, event) {
    if (!stateHolder) return;
    if (!isTouchLikeEvent(event)) {
        stateHolder.touchStartCoords = null;
        return;
    }
    const pt = getEventPoint(event);
    if (!pt) return;
    stateHolder.touchStartCoords = { x: pt.x, y: pt.y, moved: false, time: Date.now() };
}

export function updateTouchMove(stateHolder, event) {
    if (!stateHolder || !stateHolder.touchStartCoords || stateHolder.touchStartCoords.moved) return;
    if (!isTouchLikeEvent(event)) return;
    const pt = getEventPoint(event);
    if (!pt) return;
    const dx = Math.abs(pt.x - stateHolder.touchStartCoords.x);
    const dy = Math.abs(pt.y - stateHolder.touchStartCoords.y);
    if (dx > TOUCH_MOVE_THRESHOLD_PX || dy > TOUCH_MOVE_THRESHOLD_PX) {
        stateHolder.touchStartCoords.moved = true;
    }
}

export function clearTouchTracking(stateHolder) {
    if (!stateHolder) return;
    stateHolder.touchStartCoords = null;
}

/**
 * 判断当前抬起事件是否属于滑动/滚动手势（而非点击 Tap）
 */
export function isTouchScrollGesture(stateHolder, event) {
    if (!stateHolder || !stateHolder.touchStartCoords) return false;
    const coords = stateHolder.touchStartCoords;
    if (Date.now() - Number(coords.time || 0) > TOUCH_GESTURE_MAX_AGE_MS) {
        stateHolder.touchStartCoords = null;
        return false;
    }

    const orig = (event && event.originalEvent) || event;
    const eventType = event && event.type ? event.type : '';
    if (eventType !== 'pointerup' && eventType !== 'touchend' && eventType !== 'click') {
        return false;
    }

    // PC 鼠标的 pointerup 或键盘回车/空格触发的 click (detail === 0) 绝不应被当作触屏滑动拦截
    if (eventType === 'pointerup' && !isTouchLikeEvent(event)) {
        return false;
    }
    if (eventType === 'click' && orig && orig.detail === 0) {
        return false;
    }

    if (coords.moved) {
        return true;
    }
    const pt = getEventPoint(event);
    if (pt && (eventType === 'pointerup' || eventType === 'touchend') && isTouchLikeEvent(event)) {
        const dx = Math.abs(pt.x - coords.x);
        const dy = Math.abs(pt.y - coords.y);
        if (dx > TOUCH_MOVE_THRESHOLD_PX || dy > TOUCH_MOVE_THRESHOLD_PX) {
            coords.moved = true;
            return true;
        }
    }
    return false;
}

/**
 * 调度浏览器空闲任务（带超时兜底）
 */
export function pkScheduleIdleTask(callback, timeout = 1200) {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(callback, { timeout });
    }
    return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0);
}

/**
 * 取消浏览器空闲任务
 */
export function pkCancelIdleTask(taskId) {
    if (taskId == null) return;
    if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(taskId);
        return;
    }
    clearTimeout(taskId);
}

/**
 * 判断元素交互是否应在防抖窗口内被处理
 */
export function shouldHandleInteraction(element) {
    if (!element || !element.dataset) return false;
    const now = Date.now();
    const lastHandled = Number(element.dataset.pkLastHandled || 0);
    if (now - lastHandled < INTERACTION_DEBOUNCE_MS) return false;
    element.dataset.pkLastHandled = String(now);
    return true;
}

/**
 * 在触控事件（pointerup / touchend）处理后标记抑制紧随其后的合成事件（touchend / click）
 */
export function suppressSyntheticClickAfterTouch(element) {
    if (!element || !element.dataset) return;
    element.dataset.pkSuppressClickUntil = String(Date.now() + INTERACTION_DEBOUNCE_MS + 150);
}

/**
 * 判断当前事件是否为触控后需要抑制的伴随/合成事件
 * 在 iOS 13+ 上，一次触摸会依次触发 pointerup -> touchend -> click，
 * 当 pointerup 已处理后，后续的 touchend 和 click 均应被抑制。
 */
export function shouldSuppressSyntheticClick(element, eventType) {
    if (!element || !element.dataset) return false;
    if (eventType !== 'click' && eventType !== 'touchend') return false;
    const suppressUntil = Number(element.dataset.pkSuppressClickUntil || 0);
    return suppressUntil > Date.now();
}

/**
 * 若当前事件为 touchend / pointerup，则标记抑制后续伴随的 touchend / 合成 click
 */
export function markTouchHandledForSyntheticClick(element, eventType) {
    if (!element) return;
    if (eventType === 'touchend' || eventType === 'pointerup') {
        suppressSyntheticClickAfterTouch(element);
    }
}

/**
 * 为按钮提供轻量按压反馈动画（避免 offsetWidth 强制同步布局）
 */
export function animatePressedButton($btn) {
    if (!$btn || !$btn.length) return;
    $btn.addClass('pk-btn-active');
    setTimeout(() => $btn.removeClass('pk-btn-active'), 220);
}
