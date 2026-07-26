/*
 * Prevent KWin's Scale/Fade effects from painting the provisional geometry
 * Firefox assigns before the DictAI positioner applies Wayland coordinates.
 */

"use strict";

const stagingWidth = 137;
const stagingHeight = 139;
const maximumStagingFrameHeight = stagingHeight + 64;
const minimumFinalWidth = 240;
const minimumFinalHeight = 180;
const hiddenAnimations = new Map();

function frameSize(window) {
    const geometry = window.geometry || window.frameGeometry || {};
    return {
        width: Number(geometry.width ?? window.width),
        height: Number(geometry.height ?? window.height)
    };
}

function describeWindow(window) {
    const size = frameSize(window);
    return (
        "class=" +
        String(window.windowClass || window.resourceClass || "") +
        " size=" +
        size.width +
        "x" +
        size.height +
        " caption=" +
        String(window.caption || "")
    );
}

function isDictAiStagingWindow(window) {
    if (!window) {
        return false;
    }

    const windowClass = String(
        window.windowClass || window.resourceClass || ""
    ).toLowerCase();
    const size = frameSize(window);
    return (
        windowClass.includes("firefox") &&
        Math.abs(size.width - stagingWidth) <= 2 &&
        size.height >= stagingHeight - 2 &&
        size.height <= maximumStagingFrameHeight
    );
}

function isDictAiPopup(window) {
    if (!window) {
        return false;
    }
    if (String(window.caption || "").includes("[DICTAI_POPUP|")) {
        return true;
    }

    // Firefox publishes the extension title after the native surface is
    // mapped. These distinctive staging dimensions identify it early enough
    // to cancel Scale/Fade before their first compositor paint.
    return isDictAiStagingWindow(window);
}

function holdStagingWindow(window) {
    console.info("dictai-popup-guard: holding " + describeWindow(window));
    hiddenAnimations.set(
        window,
        set({
            window: window,
            duration: 1,
            animations: [
                {
                    type: Effect.Opacity,
                    from: 0,
                    to: 0
                }
            ]
        })
    );
}

function releaseStagingWindow(window) {
    const animation = hiddenAnimations.get(window);
    if (animation === undefined) {
        return;
    }
    cancel(animation);
    hiddenAnimations.delete(window);
    console.info("dictai-popup-guard: released " + describeWindow(window));
}

effects.windowAdded.connect(function (window) {
    if (!isDictAiPopup(window)) {
        return;
    }

    console.info("dictai-popup-guard: matched " + describeWindow(window));

    // Grabbing this role cancels any opening animation already started by
    // Scale/Fade and prevents another opening effect from taking the window.
    effect.grab(window, Effect.WindowAddedGrabRole);

    // Unlike setting the base window opacity from a normal KWin script, this
    // compositor animation is active during the first paint. Keep the staging
    // surface completely invisible until the positioner applies final bounds.
    if (isDictAiStagingWindow(window)) {
        holdStagingWindow(window);
        window.windowFrameGeometryChanged.connect(function () {
            if (!hiddenAnimations.has(window)) {
                return;
            }

            const size = frameSize(window);
            if (
                size.width >= minimumFinalWidth &&
                size.height >= minimumFinalHeight
            ) {
                releaseStagingWindow(window);
            }
        });
    }
});

effects.windowClosed.connect(function (window) {
    releaseStagingWindow(window);
});
