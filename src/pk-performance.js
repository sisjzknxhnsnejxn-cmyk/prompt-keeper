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
    // PC 端只需要 click。pointerup + touchend + click 三套兜底会让事件路径更重，
    // 在 SillyTavern 预设管理器大量 DOM/hover 场景下容易放大卡顿。
    if (!pkIsCoarsePointerDevice()) return ['click'];

    return [
        ...(window.PointerEvent ? ['pointerup'] : []),
        'touchend',
        'click',
    ];
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
