/*
 * Prevent KWin's Scale/Fade effects from painting the provisional geometry
 * Firefox assigns before the DictAI positioner applies Wayland coordinates.
 */

"use strict";

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
    const windowClass = String(window.windowClass || "").toLowerCase();
    return (
        windowClass.includes("firefox") &&
        Math.abs(Number(window.width) - 137) <= 2 &&
        Math.abs(Number(window.height) - 139) <= 2
    );
}

effects.windowAdded.connect(function (window) {
    if (!isDictAiPopup(window)) {
        return;
    }

    // Grabbing this role cancels any opening animation already started by
    // Scale/Fade and prevents another opening effect from taking the window.
    effect.grab(window, Effect.WindowAddedGrabRole);
});
