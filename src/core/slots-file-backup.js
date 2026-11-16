/**
 * Prompt Keeper - 槽位备份的酒馆服务端文件持久化层
 *
 * 将按聊天隔离的槽位备份写入酒馆用户目录下的
 * `data/<用户>/user/files/prompt-keeper-slots-backup.json`，
 * 使备份随酒馆账号走，不受浏览器 localStorage 清理 / 换设备影响。
 *
 * 使用的 HTTP 接口（已对照官方 release 源码 src/endpoints/files.js 与 src/users.js 校验）：
 *   - POST /api/files/upload  { name, data(base64) } -> { path }  同名覆盖写
 *   - GET  /user/files/<name>                        -> 文件内容（404 表示尚未创建）
 *   - POST /api/files/delete  { path }               -> 200
 * 请求头统一使用 ctx.getRequestHeaders()（含 CSRF token）。
 *
 * 该层为「尽力而为」的自愈备份：任何网络/接口失败都不得影响 chatMetadata 主存档的读写。
 */

import {
    LOG_PREFIX,
    MAX_FILE_BACKUP_CHATS,
    METADATA_VERSION,
    SLOTS_BACKUP_FILE_NAME,
    SLOTS_BACKUP_FILE_WRITE_DEBOUNCE_MS,
} from '../config/constants.js';
import { getCtxSafe } from '../utils/st-context.js';

/** 内存镜像：{ [chatId]: { version, defaultSlot, slots, updatedAt } } */
let fileBackupByChat = null;
/** 服务端文件是否已尝试读取完成 */
let fileBackupLoaded = false;
let loadPromise = null;
let writeTimer = null;
let writeDisabled = false;
let warnedOnce = false;
/** 待写回的聊天 id 集合，防抖期间累积 */
const pendingChatIds = new Set();
/** 待删除的聊天 id 集合 */
const pendingDeleteChatIds = new Set();

function warnOnce(message, error) {
    if (warnedOnce) return;
    warnedOnce = true;
    console.warn(LOG_PREFIX, message, error || '');
}

function getRequestHeadersSafe() {
    const ctx = getCtxSafe();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') return null;
    try {
        const headers = ctx.getRequestHeaders();
        return headers && typeof headers === 'object' ? headers : null;
    } catch (_) {
        return null;
    }
}

/**
 * 解析相对于当前页面的酒馆接口 URL，兼容反向代理子路径部署。
 */
function resolveServerUrl(relativePath) {
    try {
        if (typeof window !== 'undefined' && window.location) {
            return new URL(relativePath, window.location.origin + window.location.pathname).href;
        }
    } catch (_) {}
    return `/${relativePath}`;
}

function encodeJsonToBase64(text) {
    if (typeof TextEncoder === 'function' && typeof btoa === 'function') {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }
    if (typeof btoa === 'function') {
        return btoa(unescape(encodeURIComponent(text)));
    }
    return null;
}

function isPlainChatId(chatId) {
    return Boolean(
        chatId &&
            typeof chatId === 'string' &&
            chatId !== '__proto__' &&
            chatId !== 'constructor' &&
            chatId !== 'prototype'
    );
}

/**
 * 规范化文件内容为 { [chatId]: chatEntry }，丢弃非法条目。
 */
function normalizeFilePayload(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object') return result;
    const byChat = raw.byChat && typeof raw.byChat === 'object' ? raw.byChat : {};

    for (const [chatId, entry] of Object.entries(byChat)) {
        if (!isPlainChatId(chatId)) continue;
        if (!entry || typeof entry !== 'object' || !entry.slots || typeof entry.slots !== 'object') {
            continue;
        }
        if (Object.keys(entry.slots).length === 0) continue;
        result[chatId] = {
            version: METADATA_VERSION,
            defaultSlot: typeof entry.defaultSlot === 'string' ? entry.defaultSlot : null,
            slots: entry.slots,
            updatedAt: Number(entry.updatedAt) || 0,
        };
    }
    return result;
}

/**
 * 仅保留最近更新的若干个聊天，避免文件无限增长。
 */
function trimByChat(byChat) {
    const entries = Object.entries(byChat).sort(
        (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)
    );
    if (entries.length <= MAX_FILE_BACKUP_CHATS) return byChat;
    const trimmed = {};
    for (const [chatId, entry] of entries.slice(0, MAX_FILE_BACKUP_CHATS)) {
        trimmed[chatId] = entry;
    }
    return trimmed;
}

/**
 * 从服务端读取备份文件内容（404 视为空文件，不算失败）。
 * @returns {Promise<Object|null>} 成功返回 byChat 对象，接口不可用返回 null
 */
async function fetchFileFromServer() {
    if (typeof fetch !== 'function') return null;
    const headers = getRequestHeadersSafe();
    const url = `${resolveServerUrl(`user/files/${SLOTS_BACKUP_FILE_NAME}`)}?t=${Date.now()}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: headers || undefined,
            cache: 'no-store',
        });
        if (response.status === 404) {
            return {};
        }
        if (!response.ok) {
            warnOnce(
                `读取服务端槽位备份文件失败（HTTP ${response.status}），本次会话将仅使用聊天元数据。`
            );
            return null;
        }
        const text = await response.text();
        if (!text || !text.trim()) return {};
        return normalizeFilePayload(JSON.parse(text));
    } catch (e) {
        warnOnce('读取服务端槽位备份文件异常，本次会话将仅使用聊天元数据。', e);
        return null;
    }
}

/**
 * 将完整 byChat 内容上传覆盖到服务端文件。
 * @returns {Promise<boolean>} 是否写入成功
 */
async function uploadFileToServer(byChat) {
    if (typeof fetch !== 'function') return false;
    const headers = getRequestHeadersSafe();
    if (!headers) return false;

    const payload = JSON.stringify({
        version: METADATA_VERSION,
        updatedAt: Date.now(),
        byChat,
    });
    const base64 = encodeJsonToBase64(payload);
    if (!base64) return false;

    try {
        const response = await fetch(resolveServerUrl('api/files/upload'), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: SLOTS_BACKUP_FILE_NAME,
                data: base64,
            }),
        });
        if (!response.ok) {
            warnOnce(
                `写入服务端槽位备份文件失败（HTTP ${response.status}），槽位仍会保存在聊天元数据中。`
            );
            writeDisabled = true;
            return false;
        }
        return true;
    } catch (e) {
        warnOnce('写入服务端槽位备份文件异常，槽位仍会保存在聊天元数据中。', e);
        writeDisabled = true;
        return false;
    }
}

/**
 * 读取服务端备份文件到内存镜像。仅在 APP_READY 之后调用，全程不触发对 chatMetadata 的写操作。
 * @param {object} options
 * @param {Object|null} options.legacyByChat 旧 localStorage 备份，服务端文件不存在时用于一次性迁移
 * @returns {Promise<boolean>} 内存镜像中是否存在可用备份（调用方据此决定是否刷新 UI）
 */
export async function loadSlotsFileBackup(options = {}) {
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        const fetched = await fetchFileFromServer();
        if (fetched === null) {
            // 接口不可用：整体降级为只用 chatMetadata，不再尝试写
            fileBackupByChat = fileBackupByChat || {};
            fileBackupLoaded = true;
            writeDisabled = true;
            return false;
        }

        const hadEntries = Object.keys(fetched).length > 0;
        fileBackupByChat = fetched;
        fileBackupLoaded = true;

        // 服务端尚无备份文件时，用旧的 localStorage 备份做一次性迁移
        const legacyByChat = options.legacyByChat;
        if (!hadEntries && legacyByChat && typeof legacyByChat === 'object') {
            const migrated = normalizeFilePayload({ byChat: legacyByChat });
            if (Object.keys(migrated).length > 0) {
                fileBackupByChat = trimByChat(migrated);
                const ok = await uploadFileToServer(fileBackupByChat);
                if (ok) {
                    console.log(
                        LOG_PREFIX,
                        `Migrated ${Object.keys(fileBackupByChat).length} chat backup(s) from localStorage to server file.`
                    );
                }
                return true;
            }
        }

        return hadEntries;
    })();

    return loadPromise;
}

/**
 * 同步读取某个聊天的文件备份（仅查内存镜像，不发起网络请求）。
 */
export function getFileBackupForChat(chatId) {
    if (!fileBackupByChat || !isPlainChatId(chatId)) return null;
    return Object.prototype.hasOwnProperty.call(fileBackupByChat, chatId)
        ? fileBackupByChat[chatId]
        : null;
}

export function isSlotsFileBackupLoaded() {
    return fileBackupLoaded;
}

/**
 * 真正执行写回：先重新拉取服务端文件（避免多端互相覆盖），
 * 再把本地待写聊天的条目合并进去后整体上传。
 */
async function flushPendingWrites() {
    writeTimer = null;
    if (writeDisabled) {
        pendingChatIds.clear();
        pendingDeleteChatIds.clear();
        return;
    }
    if (pendingChatIds.size === 0 && pendingDeleteChatIds.size === 0) return;

    const chatIdsToWrite = Array.from(pendingChatIds);
    const chatIdsToDelete = Array.from(pendingDeleteChatIds);
    pendingChatIds.clear();
    pendingDeleteChatIds.clear();

    // 在任何 await 之前取好内存镜像引用：reset 可能在写入途中把 fileBackupByChat 置空
    const snapshot = fileBackupByChat || {};

    const remote = await fetchFileFromServer();
    const merged = remote === null ? Object.assign({}, snapshot) : remote;

    for (const chatId of chatIdsToWrite) {
        const local = snapshot[chatId];
        if (local) {
            merged[chatId] = local;
        } else {
            delete merged[chatId];
        }
    }
    for (const chatId of chatIdsToDelete) {
        delete merged[chatId];
    }

    const trimmed = trimByChat(merged);

    // 合并回写入期间新产生的改动，避免覆盖这段时间内的保存
    if (fileBackupByChat) {
        for (const chatId of pendingChatIds) {
            const live = fileBackupByChat[chatId];
            if (live) trimmed[chatId] = live;
        }
        for (const chatId of pendingDeleteChatIds) {
            delete trimmed[chatId];
        }
        fileBackupByChat = trimmed;
    }

    await uploadFileToServer(trimmed);
}

function scheduleWrite() {
    if (writeDisabled) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        flushPendingWrites().catch((e) => {
            warnOnce('写入服务端槽位备份文件时发生未捕获异常。', e);
        });
    }, SLOTS_BACKUP_FILE_WRITE_DEBOUNCE_MS);
}

/**
 * 更新某个聊天的文件备份条目（传 null 表示删除该聊天的备份），防抖后异步写回服务端。
 */
export function updateFileBackupForChat(chatId, chatEntry) {
    if (!isPlainChatId(chatId)) return;
    if (!fileBackupByChat) fileBackupByChat = {};

    if (chatEntry && chatEntry.slots && Object.keys(chatEntry.slots).length > 0) {
        fileBackupByChat[chatId] = {
            version: METADATA_VERSION,
            defaultSlot: chatEntry.defaultSlot || null,
            slots: chatEntry.slots,
            updatedAt: Number(chatEntry.updatedAt) || Date.now(),
        };
        pendingDeleteChatIds.delete(chatId);
        pendingChatIds.add(chatId);
    } else {
        delete fileBackupByChat[chatId];
        pendingChatIds.delete(chatId);
        pendingDeleteChatIds.add(chatId);
    }

    scheduleWrite();
}

/**
 * 删除服务端备份文件本身（插件卸载时调用，失败静默忽略）。
 */
export async function deleteSlotsBackupFile() {
    if (typeof fetch !== 'function') return;
    const headers = getRequestHeadersSafe();
    if (!headers) return;
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    pendingChatIds.clear();
    pendingDeleteChatIds.clear();

    try {
        await fetch(resolveServerUrl('api/files/delete'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: `user/files/${SLOTS_BACKUP_FILE_NAME}` }),
        });
    } catch (_) {}
}

/**
 * 重置内存状态（插件热重载 / 卸载时调用）。
 * 会先把尚未写出的改动立即推送到服务端，避免防抖期内的保存丢失。
 */
export function resetSlotsFileBackupState() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (pendingChatIds.size > 0 || pendingDeleteChatIds.size > 0) {
        flushPendingWrites().catch(() => {});
    }
    fileBackupByChat = null;
    fileBackupLoaded = false;
    loadPromise = null;
    writeDisabled = false;
    warnedOnce = false;
}
