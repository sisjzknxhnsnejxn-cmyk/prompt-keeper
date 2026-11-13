/**
 * Prompt Keeper - 格式化、字符串规范化与原型安全辅助函数
 */

const UNSAFE_OBJECT_KEYS = new Set([
    '__proto__',
    'prototype',
    'constructor',
    'tostring',
    'valueof',
    'hasownproperty',
    'isprototypeof',
    'propertyisenumerable',
    'tolocalestring',
    '__definegetter__',
    '__definesetter__',
    '__lookupgetter__',
    '__lookupsetter__',
]);

/**
 * 安全判断对象自身是否拥有指定属性（避免原型链属性如 toString 误判）
 */
export function hasOwnSlot(obj, key) {
    if (!obj || typeof obj !== 'object' || key == null) return false;
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 规范化槽位或预设显示名称
 */
export function normalizeSlotName(name) {
    return String(name || '').trim() || '未命名预设';
}

/**
 * 规范化用于忽略大小写比对的预设/槽位键名
 */
export function normalizePresetKey(name) {
    return normalizeSlotName(name).toLowerCase();
}

/**
 * 检查槽位名称是否安全，防止原型污染或 Object.prototype 属性冲突
 */
export function isSafeSlotName(slotName) {
    const raw = String(slotName || '').trim();
    if (!raw) return false;
    return !UNSAFE_OBJECT_KEYS.has(raw.toLowerCase());
}

/**
 * 判断两个预设名是否语义匹配（忽略首尾空格与大小写）
 */
export function isPresetNameMatch(currentPreset, targetPreset) {
    return Boolean(
        currentPreset &&
        targetPreset &&
        String(currentPreset).trim().toLowerCase() === String(targetPreset).trim().toLowerCase()
    );
}

/**
 * 判断两个槽位标签在忽略空白和大小写后是否相同
 */
export function areSlotLabelsSame(a, b) {
    return (
        normalizePresetKey(String(a || '').replace(/\s+/g, '')) ===
        normalizePresetKey(String(b || '').replace(/\s+/g, ''))
    );
}

/**
 * 格式化顶栏简短时间 (HH:mm)
 */
export function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
        const d = new Date(timestamp);
        if (Number.isNaN(d.getTime())) return '';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } catch (_) {
        return '';
    }
}

/**
 * 格式化槽位列表中的详细保存时间 (MM/DD HH:mm)
 */
export function formatSlotTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
        const d = new Date(timestamp);
        if (Number.isNaN(d.getTime())) return '未知时间';
        return d.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (_) {
        return '未知时间';
    }
}

/**
 * 生成槽位弹窗项的副标题元信息
 */
export function getSlotMetaLabel(slotName, slot) {
    const timeLabel = formatSlotTime(slot && slot.savedAt);
    const presetName = normalizeSlotName((slot && slot.presetName) || slotName);
    if (!presetName || areSlotLabelsSame(presetName, slotName)) {
        return `保存于 ${timeLabel}`;
    }
    return `预设：${presetName} · 保存于 ${timeLabel}`;
}
