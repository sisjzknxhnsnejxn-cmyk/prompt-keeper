function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
        const d = new Date(timestamp);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } catch (_) {
        return '';
    }
}

function updateStatusDisplay(hasSave, savedAt) {
    requestAnimationFrame(() => {
        const $status = jQuery('#prompt-keeper-status');
        if ($status.length === 0) return;

        if (hasSave) {
            const timeStr = formatTime(savedAt || getSavedAt());
            const label = timeStr ? `✓ 已保存 ${timeStr}` : '✓ 已保存';
            $status.text(label).removeClass('pk-not-saved').addClass('pk-saved');
        } else {
            $status.text('⚠ 无保存').removeClass('pk-saved').addClass('pk-not-saved');
        }
    });
}

function formatSlotTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
        return new Date(timestamp).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (_) {
        return '未知时间';
    }
}

function closeSlotPicker() {
    jQuery('#prompt-keeper-modal').remove();
}

function shouldHandleInteraction(element) {
    if (!element) return false;
    const now = Date.now();
    const lastHandled = Number(element.dataset.pkLastHandled || 0);
    if (now - lastHandled < INTERACTION_DEBOUNCE_MS) return false;
    element.dataset.pkLastHandled = String(now);
    return true;
}

function toggleSlotPickerTheme() {
    const $modal = jQuery('#prompt-keeper-modal');
    if ($modal.length === 0) return;
    const isLight = $modal.hasClass('pk-modal-light');
    const nextTheme = isLight ? 'dark' : 'light';
    applySlotPickerTheme($modal, nextTheme);

    const settings = loadPluginSettings();
    settings.slotPickerTheme = nextTheme;
    savePluginSettings();
}

function getSlotPickerThemeLabel(theme) {
    return theme === 'light' ? '☀ 日间' : '🌙 夜间';
}

function applySlotPickerTheme($modal, theme) {
    $modal
        .toggleClass('pk-modal-light', theme === 'light')
        .toggleClass('pk-modal-dark', theme === 'dark');
    $modal.find('.pk-modal-theme').text(getSlotPickerThemeLabel(theme));
}

function animatePressedButton($btn) {
    if (!$btn || !$btn.length) return;
    $btn.removeClass('pk-btn-active');
    void $btn[0].offsetWidth;
    $btn.addClass('pk-btn-active');
    setTimeout(() => $btn.removeClass('pk-btn-active'), 220);
}

function showSlotPicker(mode) {
    const ctx = getCtx();
    const chatMetadata = ctx.chatMetadata;
    const rawState = chatMetadata && chatMetadata[METADATA_KEY];
    const savedState = migrateState(rawState);
    persistMigratedStateIfNeeded(chatMetadata, rawState, savedState);
    const slotEntries = getSlotEntries(savedState);

    if (slotEntries.length === 0) {
        toastr.info('暂无保存槽位', 'Prompt Keeper');
        return;
    }

    closeSlotPicker();

    const isDelete = mode === 'delete';
    const title = isDelete ? '删除槽位' : '恢复槽位';
    const settings = loadPluginSettings();
    const theme = settings.slotPickerTheme === 'dark' ? 'dark' : 'light';
    const $modal = jQuery(`
        <div id="prompt-keeper-modal" class="pk-modal-overlay pk-modal-${theme}">
            <div class="pk-modal-card" role="dialog" aria-modal="true" aria-label="${title}">
                <div class="pk-modal-header">
                    <strong>${title}</strong>
                <button type="button" class="pk-modal-theme" title="切换主题" aria-label="切换槽位选择弹窗主题">${getSlotPickerThemeLabel(theme)}</button>
                </div>
                <div class="pk-modal-list"></div>
                <button type="button" class="pk-modal-cancel" aria-label="关闭槽位选择弹窗">取消</button>
            </div>
        </div>
    `);

    const $list = $modal.find('.pk-modal-list');
    for (const [name, slot] of slotEntries) {
        const isDefault = savedState.defaultSlot === name;
        const presetName = normalizeSlotName(slot.presetName || name);
        const presetLabel = normalizePresetKey(presetName) !== normalizePresetKey(name)
            ? `${presetName} · ${formatSlotTime(slot.savedAt)}`
            : formatSlotTime(slot.savedAt);
        const $item = jQuery(`
            <button type="button" class="pk-slot-item ${isDelete ? 'pk-slot-delete' : ''}">
                <span class="pk-slot-main">
                    <span class="pk-slot-name"></span>
                    ${isDefault ? '<span class="pk-slot-default">默认</span>' : ''}
                </span>
                <span class="pk-slot-time"></span>
            </button>
        `);
        $item.find('.pk-slot-name').text(name);
        $item.find('.pk-slot-time').text(presetLabel);
        const onSlotPress = async function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (!shouldHandleInteraction($item[0]) || $item.prop('disabled')) return;

            animatePressedButton($item);
            $item.addClass('pk-slot-selected pk-slot-working').prop('disabled', true);
            $list.find('.pk-slot-item').not($item).prop('disabled', true).addClass('pk-slot-disabled');

            if (isDelete) {
                const confirmed = window.confirm('删除此槽位？');
                if (!confirmed) {
                    $item.removeClass('pk-slot-selected pk-slot-working').prop('disabled', false);
                    $list.find('.pk-slot-item').not($item).prop('disabled', false).removeClass('pk-slot-disabled');
                    return;
                }
                deleteSlotFromMetadata(name);
            } else {
                $item.find('.pk-slot-time').text('恢复中…');
                await restoreStatesFromMetadata(false, name);
            }
            closeSlotPicker();
        };
        for (const eventType of BUTTON_EVENT_TYPES) {
            $item[0].addEventListener(eventType, onSlotPress, { passive: false });
        }
        $list.append($item);
    }

    const themeButton = $modal.find('.pk-modal-theme')[0];
    const cancelButton = $modal.find('.pk-modal-cancel')[0];

    const onThemePress = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!shouldHandleInteraction(themeButton)) return;
        animatePressedButton(jQuery(themeButton));
        toggleSlotPickerTheme();
    };
    const onCancelPress = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!shouldHandleInteraction(cancelButton)) return;
        animatePressedButton(jQuery(cancelButton));
        closeSlotPicker();
    };

    for (const eventType of BUTTON_EVENT_TYPES) {
        themeButton.addEventListener(eventType, onThemePress, { passive: false });
        cancelButton.addEventListener(eventType, onCancelPress, { passive: false });
    }

    $modal.on('click.pk pointerup.pk touchend.pk', function (e) {
        if (e.target === this) closeSlotPicker();
    });

    jQuery(document.body).append($modal);
    console.debug(LOG_PREFIX, `Slot picker opened in ${mode} mode with ${slotEntries.length} slot(s).`);
}

function handlePromptKeeperButtonAction(selector, $btn) {
    const actions = {
        '#prompt-keeper-save': () => saveStatesToMetadata(),
        '#prompt-keeper-restore': () => showSlotPicker('restore'),
        '#prompt-keeper-delete': () => deleteStateFromMetadata(),
    };

    const action = actions[selector];
    if (!action) return;
    executeButtonAction(action, $btn, selector);
}

function bindNativeButtonEvent(button, eventType, useCapture = false) {
    button.removeEventListener(eventType, onPromptKeeperButtonPress, useCapture);
    button.addEventListener(eventType, onPromptKeeperButtonPress, {
        capture: useCapture,
        passive: false,
    });
}

function bindDocumentButtonEvent(eventType) {
    document.removeEventListener(eventType, onPromptKeeperButtonPress, true);
    document.addEventListener(eventType, onPromptKeeperButtonPress, {
        capture: true,
        passive: false,
    });
}

function bindDelegatedButtonEvents() {
    if (promptKeeperButtonDelegationBound) return;

    for (const eventType of BUTTON_EVENT_TYPES) {
        bindDocumentButtonEvent(eventType);
    }

    promptKeeperButtonDelegationBound = true;
    console.debug(LOG_PREFIX, 'Document-level delegated button events bound.');
}

function getPromptKeeperButtonFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const target of path) {
        if (target && target.id && ['prompt-keeper-save', 'prompt-keeper-restore', 'prompt-keeper-delete'].includes(target.id)) {
            return target;
        }
        if (target && target.closest) {
            const button = target.closest(PROMPT_KEEPER_BUTTON_SELECTOR);
            if (button) return button;
        }
    }
    return e.target && e.target.closest
        ? e.target.closest(PROMPT_KEEPER_BUTTON_SELECTOR)
        : null;
}

function onPromptKeeperButtonPress(e) {
    const button = getPromptKeeperButtonFromEvent(e);
    if (!button) return;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
    }
    handlePromptKeeperButtonAction(`#${button.id}`, jQuery(button));
}

function isPromptKeeperMutation(mutations) {
    return mutations.every((mutation) => {
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.length > 0 && nodes.every((node) => {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return true;
            return node.id === 'prompt-keeper-bar' || (node.closest && node.closest('#prompt-keeper-bar'));
        });
    });
}

function pauseUIObserver() {
    observerPaused = true;
    console.debug(LOG_PREFIX, 'UI Observer paused (drag in progress).');
}

function resumeUIObserver() {
    observerPaused = false;
    console.debug(LOG_PREFIX, 'UI Observer resumed (drag ended).');
    if (!document.getElementById('prompt-keeper-bar')) {
        console.debug(LOG_PREFIX, 'Bar missing after drag, re-injecting.');
        injectUI();
    }
}

function bindDragPauseListeners() {
    if (dragListenersBound) return;
    dragListenersBound = true;

    jQuery(document).on('mousedown touchstart', '[data-pm-identifier] .drag-handle, [data-pm-identifier].ui-sortable-handle, .prompt_manager_prompt .drag-handle, .prompt-manager-detach-action-menu', function () {
        pauseUIObserver();
    });

    jQuery(document).on('mouseup touchend', function () {
        if (observerPaused) {
            setTimeout(resumeUIObserver, 300);
        }
    });

    jQuery(document).on('sortstart', function () {
        pauseUIObserver();
    });
    jQuery(document).on('sortstop sortupdate', function () {
        setTimeout(resumeUIObserver, 300);
    });

    console.debug(LOG_PREFIX, 'Drag pause/resume listeners bound.');
}

function startUIObserver() {
    if (uiObserver) {
        uiObserver.disconnect();
        uiObserver = null;
    }

    if (jQuery('#prompt-keeper-bar').length === 0) return;

    bindDragPauseListeners();

    const barElement = document.getElementById('prompt-keeper-bar');
    const barParent = barElement ? barElement.parentNode : null;

    // 优先监听 bar 的直接父节点（范围最小），否则退回外层持久容器
    let observeTarget = null;
    let useSubtree = false;

    if (barParent && barParent !== document.body) {
        observeTarget = barParent;
        useSubtree = false;
    } else {
        observeTarget =
            document.getElementById('ai_response_configuration') ||
            document.getElementById('openai_settings') ||
            document.getElementById('rm_api_block') ||
            document.body;
        useSubtree = true;
    }

    uiObserver = new MutationObserver((mutations) => {
        if (observerPaused) return;
        if (isPromptKeeperMutation(mutations)) return;
        if (observerRafId) return;

        observerRafId = requestAnimationFrame(() => {
            observerRafId = null;
            if (observerPaused) return;
            if (document.getElementById('prompt-keeper-bar')) return;
            if (observerThrottleTimer) return;
            if (Date.now() - lastUIInjectAt < UI_REINJECT_SETTLE_MS) return;

            observerThrottleTimer = setTimeout(() => {
                observerThrottleTimer = null;

                if (observerReinjectionCount >= OBSERVER_REINJECTION_LIMIT) {
                    console.warn(LOG_PREFIX, `UI re-injection limit (${OBSERVER_REINJECTION_LIMIT}) reached in ${OBSERVER_REINJECTION_WINDOW / 1000}s. Pausing observer to prevent infinite loop.`);
                    return;
                }

                if (!document.getElementById('prompt-keeper-bar')) {
                    observerReinjectionCount++;

                    if (!observerReinjectionResetTimer) {
                        observerReinjectionResetTimer = setTimeout(() => {
                            observerReinjectionCount = 0;
                            observerReinjectionResetTimer = null;
                            console.debug(LOG_PREFIX, 'Observer re-injection counter reset.');
                            if (!document.getElementById('prompt-keeper-bar')) {
                                console.debug(LOG_PREFIX, 'Bar still missing after counter reset, attempting re-injection.');
                                injectUI();
                            }
                        }, OBSERVER_REINJECTION_WINDOW);
                    }

                    console.debug(LOG_PREFIX, `UI bar was removed from DOM, re-injecting... (${observerReinjectionCount}/${OBSERVER_REINJECTION_LIMIT})`);
                    injectUI();
                }
            }, UI_REINJECT_SETTLE_MS);
        });
    });

    uiObserver.observe(observeTarget, {
        childList: true,
        subtree: useSubtree,
    });

    console.debug(LOG_PREFIX, `UI Observer attached to ${observeTarget.id || observeTarget.tagName} with subtree:${useSubtree}`);
}

/**
 * 按钮动作执行器：防重复触发（iOS 上 click+touchend 可能双触发）
 */
function executeButtonAction(action, $btn, buttonId = 'unknown') {
    const now = Date.now();
    const lastHandled = Number(lastButtonActionById[buttonId] || 0);
    if (now - lastHandled < BUTTON_DEBOUNCE_MS) {
        console.debug(LOG_PREFIX, `Button action debounced for ${buttonId}.`);
        return;
    }
    lastButtonActionById[buttonId] = now;

    // 视觉反馈：按钮短暂高亮
    animatePressedButton($btn);

    Promise.resolve(action()).catch((error) => {
        console.error(LOG_PREFIX, `Button action failed for ${buttonId}:`, error);
        toastr.error('操作失败，请查看控制台', 'Prompt Keeper');
    });
}

/**
 * 直接绑定按钮事件（非事件委托）。
 * 同时绑定 click 和 touchend，iOS Safari 上 touchend 更可靠。
 * 防重复触发通过 BUTTON_DEBOUNCE_MS 时间窗口控制。
 */
function bindButtonEvents() {
    const selectors = ['#prompt-keeper-save', '#prompt-keeper-restore', '#prompt-keeper-delete'];

    bindDelegatedButtonEvents();

    for (const selector of selectors) {
        const $btn = jQuery(selector);
        if ($btn.length === 0) continue;
        const button = $btn[0];

        // 移除可能的旧绑定，防止 Edge/ST 1.16 中 capture + delegated + direct 多路径互相拦截。
        $btn.off('.pk');
        for (const eventType of BUTTON_EVENT_TYPES) {
            button.removeEventListener(eventType, onPromptKeeperButtonPress, true);
            button.removeEventListener(eventType, onPromptKeeperButtonPress, false);
        }

        $btn.prop('disabled', false)
            .attr('aria-disabled', 'false')
            .attr('data-pk-action', selector.replace('#prompt-keeper-', ''))
            .removeClass('disabled interactable_disabled');
        for (const eventType of BUTTON_EVENT_TYPES) {
            // Edge + SillyTavern 1.16 有时会在冒泡阶段吞掉 menu_button 的 click，
            // 所以同时绑定原生 capture 与 bubble；executeButtonAction 会统一去重。
            bindNativeButtonEvent(button, eventType, true);
            bindNativeButtonEvent(button, eventType, false);
        }
    }

    console.debug(LOG_PREFIX, 'Button events bound with Edge/ST 1.16 compatible native handlers.');
}

function injectUI() {
    if (jQuery('#prompt-keeper-bar').length > 0) {
        bindButtonEvents();
        requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));
        console.debug(LOG_PREFIX, 'UI already exists; button events rebound.');
        return;
    }
    if (uiInjectInProgress) return;

    uiInjectInProgress = true;

    const buttonBarHtml = `
    <div id="prompt-keeper-bar" class="prompt-keeper-bar" data-pk-root="true">
        <div class="prompt-keeper-header">
            <i class="fa-solid fa-bookmark"></i>
            <span>Prompt Keeper</span>
            <span id="prompt-keeper-status" class="pk-not-saved">⚠ 无保存</span>
        </div>
        <div id="prompt-keeper-btn-group" class="prompt-keeper-btn-group">
            <button type="button" id="prompt-keeper-save" class="menu_button" data-pk-action="save" title="保存当前预设条目配置" aria-label="保存当前预设条目配置">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>保存</span>
            </button>
            <button type="button" id="prompt-keeper-restore" class="menu_button" data-pk-action="restore" title="恢复保存的预设条目配置" aria-label="恢复保存的预设条目配置">
                <i class="fa-solid fa-rotate-left"></i>
                <span>恢复</span>
            </button>
            <button type="button" id="prompt-keeper-delete" class="menu_button" data-pk-action="delete" title="删除当前聊天的保存配置" aria-label="删除当前聊天的保存配置">
                <i class="fa-solid fa-trash-can"></i>
                <span>删除</span>
            </button>
        </div>
    </div>`;

    let injected = false;

    if (!injected) {
        const $quickPromptDrawer = jQuery('#quick_prompts_container, #quickPromptEditor, #quick-prompts-inline-drawer').first();
        if ($quickPromptDrawer.length > 0) {
            $quickPromptDrawer.before(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        jQuery('.inline-drawer-header').each(function () {
            if (injected) return;
            const text = jQuery(this).text().trim();
            if (text.match(/快速提示词|Quick Prompt|Prompt Editor/i)) {
                const $drawer = jQuery(this).closest('.inline-drawer');
                if ($drawer.length > 0) {
                    $drawer.before(buttonBarHtml);
                    injected = true;
                }
            }
        });
    }

    if (!injected) {
        const $topP = jQuery('#top_p_block, [data-param="top_p"], #range_block_top_p').first();
        if ($topP.length > 0) {
            const $block = $topP.closest('.range-block, .range_block, .completions_block_inner');
            if ($block.length > 0) {
                $block.after(buttonBarHtml);
            } else {
                $topP.after(buttonBarHtml);
            }
            injected = true;
        }
    }

    if (!injected) {
        const $list = jQuery(
            '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
        ).first();
        if ($list.length > 0) {
            $list.after(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        const $aiConfig = jQuery('#ai_response_configuration');
        if ($aiConfig.length > 0) {
            $aiConfig.append(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        const $openai = jQuery('#openai_settings');
        if ($openai.length > 0) {
            $openai.append(buttonBarHtml);
            injected = true;
        }
    }

    if (!injected) {
        console.warn(LOG_PREFIX, 'Could not find UI injection point.');
        uiInjectInProgress = false;
        return;
    }


    // 直接绑定按钮事件（非事件委托，iOS 兼容）
    bindButtonEvents();

    requestAnimationFrame(() => updateStatusDisplay(hasSavedState(), getSavedAt()));

    lastUIInjectAt = Date.now();
    uiInjectInProgress = false;
    console.log(LOG_PREFIX, 'UI injected successfully.');
}

function tryInjectUI(maxRetries = 15, interval = 1000) {
    if (jQuery('#prompt-keeper-bar').length > 0) {
        bindButtonEvents();
        return;
    }
    if (uiInjectInProgress) return;

    let attempts = 0;
    const tryInject = () => {
        if (jQuery('#prompt-keeper-bar').length > 0) {
            bindButtonEvents();
            return;
        }
        if (uiInjectInProgress) return;
        injectUI();
        if (jQuery('#prompt-keeper-bar').length === 0 && attempts < maxRetries) {
            attempts++;
            setTimeout(tryInject, interval);
        }
    };
    tryInject();
}






