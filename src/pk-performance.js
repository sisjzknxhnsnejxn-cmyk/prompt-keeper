// ========== Prompt Keeper Performance Helpers ==========

function pkIsCoarsePointerDevice() {
    try {
        return Boolean(
            (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
            navigator.maxTouchPoints > 0 ||
            navigator.msMaxTouchPoints > 0
        );
    } catch (_) {
        return false;
    }
}

function pkGetButtonEventTypes() {
    // PC 端只需要 click。触控端优先使用 Pointer Events；iOS Safari 12 以下再降级 touchend。
    // 避免 pointerup + touchend + click 同时绑定导致同一次点击触发多条路径。
    if (!pkIsCoarsePointerDevice()) return ['click'];
    if (window.PointerEvent) return ['pointerup', 'click'];
    return ['touchend', 'click'];
}

function pkScheduleIdleTask(callback, timeout = 1200) {
    if (typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(callback, { timeout });
    }
    return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0);
}

function pkCancelIdleTask(taskId) {
    if (taskId == null) return;
    if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(taskId);
        return;
    }
    clearTimeout(taskId);
}
