/*
 * DictAI Popup Positioner
 *
 * KWin is the only component allowed to place top-level windows at absolute
 * coordinates on native Wayland. The browser popup briefly publishes its
 * requested geometry in its title; this script consumes that marker.
 */

const trackedWindows = new Map();
const dictAiWindows = new Set();
const positionedWindows = new Set();
const autoFitAnchors = new Map();
const initialAutoFitAnchors = new Map();
const hiddenMarker = /\[DICTAI_HIDDEN\]/;
const autoFitMarker = /\[DICTAI_AUTOFIT\|(top|bottom)(?:\|(\d+))?\]/;
const positionMarker =
    /\[DICTAI_POPUP\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|(-?\d+)\|(-?\d+)(?:\|(top|bottom))?\]/;
const stagingWidth = 137;
const stagingHeight = 139;
const maximumStagingFrameHeight = stagingHeight + 64;
let lastNonDictAiActiveWindow = workspace.activeWindow || null;

function isSupportedBrowserWindow(window) {
    const resourceClass = String(
        (window && window.resourceClass) || ""
    ).toLowerCase();
    return (
        resourceClass.includes("firefox") ||
        resourceClass.includes("google-chrome") ||
        resourceClass.includes("chromium") ||
        resourceClass.includes("chrome")
    );
}

function isChromiumWindow(window) {
    const resourceClass = String(
        (window && window.resourceClass) || ""
    ).toLowerCase();
    return (
        resourceClass.includes("google-chrome") ||
        resourceClass.includes("chromium") ||
        resourceClass.includes("chrome")
    );
}

function isDictAiStagingWindow(window) {
    if (!window || !isSupportedBrowserWindow(window)) {
        return false;
    }
    const geometry = window.frameGeometry;
    return (
        Math.abs(geometry.width - stagingWidth) <= 2 &&
        geometry.height >= stagingHeight - 2 &&
        geometry.height <= maximumStagingFrameHeight
    );
}

function hasDictAiMarker(window) {
    const caption = String((window && window.caption) || "");
    return hiddenMarker.test(caption) || positionMarker.test(caption);
}

function isDictAiWindow(window) {
    return Boolean(
        window && (dictAiWindows.has(window) || hasDictAiMarker(window))
    );
}

function syncAutoFitAnchor(window) {
    const match = autoFitMarker.exec(String((window && window.caption) || ""));
    if (!match) {
        autoFitAnchors.delete(window);
        return;
    }
    if (autoFitAnchors.has(window)) {
        return;
    }

    const geometry = window.frameGeometry;
    const initialAnchor = initialAutoFitAnchors.get(window);
    autoFitAnchors.set(
        window,
        initialAnchor && initialAnchor.edge === match[1]
            ? initialAnchor
            : {
                edge: match[1],
                coordinate:
                    match[1] === "bottom"
                        ? geometry.y + geometry.height
                        : geometry.y
            }
    );
    initialAutoFitAnchors.delete(window);
}

function preserveAutoFitAnchor(window) {
    const anchor = autoFitAnchors.get(window);
    if (!anchor || !positionedWindows.has(window)) {
        return;
    }

    const geometry = Object.assign({}, window.frameGeometry);
    const targetY =
        anchor.edge === "bottom"
            ? anchor.coordinate - geometry.height
            : anchor.coordinate;
    if (Math.abs(geometry.y - targetY) < 1) {
        return;
    }

    geometry.y = targetY;
    window.frameGeometry = geometry;
}

function applyAutoFitGeometry(window) {
    const match = autoFitMarker.exec(String((window && window.caption) || ""));
    const targetHeight = match ? Number(match[2]) : NaN;
    const anchor = autoFitAnchors.get(window);
    if (
        !match ||
        !Number.isFinite(targetHeight) ||
        targetHeight <= 0 ||
        !anchor ||
        !positionedWindows.has(window)
    ) {
        return;
    }

    const geometry = Object.assign({}, window.frameGeometry);
    geometry.height = targetHeight;
    geometry.y =
        anchor.edge === "bottom"
            ? anchor.coordinate - targetHeight
            : anchor.coordinate;
    window.frameGeometry = geometry;
}

function pointCoordinate(point, property) {
    const value = point[property];
    return Number(typeof value === "function" ? value.call(point) : value);
}

function sameApplication(firstWindow, secondWindow) {
    if (!firstWindow || !secondWindow) {
        return false;
    }

    const firstClass = String(firstWindow.resourceClass || "");
    const secondClass = String(secondWindow.resourceClass || "");
    return firstClass.length > 0 && firstClass === secondClass;
}

function syncChromeDefinitionLayer(activeWindow) {
    const keepAboveChrome = isChromiumWindow(activeWindow);
    for (const candidate of dictAiWindows) {
        if (isChromiumWindow(candidate) && !candidate.deleted) {
            candidate.keepAbove = keepAboveChrome;
        }
    }
}

function raiseChromeDefinitionWindows(latestWindow) {
    if (!isChromiumWindow(latestWindow)) {
        return;
    }

    // Clicking another word necessarily raises Chrome's main window, which
    // otherwise leaves its earlier independent definition windows behind it.
    // Raise the existing definitions first and the newest one last. This keeps
    // the group visible without leaving it above non-Chrome applications.
    syncChromeDefinitionLayer(latestWindow);
    for (const candidate of dictAiWindows) {
        if (
            candidate !== latestWindow &&
            !candidate.deleted &&
            sameApplication(candidate, latestWindow)
        ) {
            workspace.raiseWindow(candidate);
        }
    }
    workspace.raiseWindow(latestWindow);
}

function positionDictAiWindow(window, capturedSourceWindow, capturedCursor) {
    const match = positionMarker.exec(String(window.caption || ""));
    if (!match) {
        return false;
    }

    // Keep the surface out of the compositor output until its final geometry
    // is applied. This avoids Firefox's default centered first frame.
    window.opacity = 0;

    const x = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    const height = Number(match[4]);
    const relativeX = Number(match[5]);
    const relativeY = Number(match[6]);
    const viewportInsetX = Number(match[7]);
    const viewportInsetY = Number(match[8]);
    const cursorOffsetX = Number(match[9]);
    const cursorOffsetY = Number(match[10]);
    const verticalAnchor =
        match[11] || (cursorOffsetY < 0 ? "bottom" : "top");

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        !Number.isFinite(relativeX) ||
        !Number.isFinite(relativeY) ||
        !Number.isFinite(viewportInsetX) ||
        !Number.isFinite(viewportInsetY) ||
        !Number.isFinite(cursorOffsetX) ||
        !Number.isFinite(cursorOffsetY)
    ) {
        window.opacity = 1;
        return false;
    }

    const transientSource = window.transientFor || null;
    const sourceWindow =
        transientSource ||
        (sameApplication(window, capturedSourceWindow)
            ? capturedSourceWindow
            : null);

    let targetX = x;
    let targetY = y;
    if (
        capturedCursor &&
        Number.isFinite(capturedCursor.x) &&
        Number.isFinite(capturedCursor.y)
    ) {
        // KWin owns the real global cursor position on Wayland. Combining it
        // with the DOM-computed click-to-popup offset exactly reproduces the
        // in-page popup placement without relying on Firefox screenX/screenY.
        targetX = capturedCursor.x + cursorOffsetX;
        targetY = capturedCursor.y + cursorOffsetY;
    } else if (sourceWindow) {
        const sourceGeometry = sourceWindow.clientGeometry;
        targetX = sourceGeometry.x + viewportInsetX + relativeX;
        targetY = sourceGeometry.y + viewportInsetY + relativeY;
    }

    const workArea = workspace.clientArea(
        KWin.WorkArea,
        sourceWindow || window
    );
    targetX = Math.max(
        workArea.x,
        Math.min(targetX, workArea.x + workArea.width - width)
    );
    targetY = Math.max(
        workArea.y,
        Math.min(targetY, workArea.y + workArea.height - height)
    );

    const geometry = Object.assign({}, window.frameGeometry);
    if (
        Math.abs(geometry.x - targetX) < 1 &&
        Math.abs(geometry.y - targetY) < 1 &&
        Math.abs(geometry.width - width) < 1 &&
        Math.abs(geometry.height - height) < 1
    ) {
        positionedWindows.add(window);
        window.opacity = 1;
        raiseChromeDefinitionWindows(window);
        return true;
    }

    geometry.x = targetX;
    geometry.y = targetY;
    geometry.width = Math.max(240, width);
    geometry.height = Math.max(180, height);
    // The browser may request its first content-fit resize immediately after
    // this placement. Preserve the exact selected-word edge instead of
    // recapturing an already-resized frame from a later caption event.
    initialAutoFitAnchors.set(window, {
        edge: verticalAnchor,
        coordinate:
            verticalAnchor === "bottom"
                ? targetY + geometry.height
                : targetY
    });
    // Mark it before assigning frameGeometry because that assignment can emit
    // frameGeometryChanged synchronously. Placement is intentionally one-shot
    // so the user can freely move the resulting independent window.
    positionedWindows.add(window);
    window.frameGeometry = geometry;
    window.opacity = 1;
    raiseChromeDefinitionWindows(window);
    console.info(
        "dictai-positioner: positioned popup at " +
            targetX +
            "," +
            targetY
    );

    return true;
}

function handleDictAiWindow(window, capturedSourceWindow, capturedCursor) {
    const caption = String(window.caption || "");
    // The final geometry marker must take precedence over the initial hidden
    // marker while the popup document is starting.
    if (positionMarker.test(caption)) {
        dictAiWindows.add(window);
        if (positionedWindows.has(window)) {
            return true;
        }
        return positionDictAiWindow(
            window,
            capturedSourceWindow,
            capturedCursor
        );
    }
    if (hiddenMarker.test(caption)) {
        dictAiWindows.add(window);
        if (!positionedWindows.has(window)) {
            window.opacity = 0;
        }
        return true;
    }
    return false;
}

function watchWindow(window) {
    if (trackedWindows.has(window)) {
        const tracked = trackedWindows.get(window);
        handleDictAiWindow(
            window,
            tracked.sourceWindow,
            tracked.cursor
        );
        return;
    }

    const activeWindow = workspace.activeWindow;
    const stagedAsDictAi = isDictAiStagingWindow(window);
    const markedAsDictAi = hasDictAiMarker(window) || stagedAsDictAi;
    const sourceWindow =
        window.transientFor ||
        (
            activeWindow &&
            activeWindow !== window &&
            !isDictAiWindow(activeWindow)
                ? activeWindow
                : null
        ) ||
        (markedAsDictAi ? lastNonDictAiActiveWindow : null);
    const cursorPosition = workspace.cursorPos;
    const capturedCursor = {
        x: pointCoordinate(cursorPosition, "x"),
        y: pointCoordinate(cursorPosition, "y")
    };
    const captionHandler = function () {
        syncAutoFitAnchor(window);
        applyAutoFitGeometry(window);
        handleDictAiWindow(window, sourceWindow, capturedCursor);
    };
    const geometryHandler = function () {
        preserveAutoFitAnchor(window);
        handleDictAiWindow(window, sourceWindow, capturedCursor);
    };

    trackedWindows.set(window, {
        sourceWindow,
        cursor: capturedCursor,
        captionHandler,
        geometryHandler
    });
    if (stagedAsDictAi) {
        // The staging dimensions are available at windowAdded, before the browser
        // publishes any title. Suppress this provisional centred surface; the
        // title marker will shortly provide the final size and coordinates.
        dictAiWindows.add(window);
        window.opacity = 0;
    }
    if (window.captionChanged) {
        window.captionChanged.connect(captionHandler);
    }
    if (window.frameGeometryChanged) {
        window.frameGeometryChanged.connect(geometryHandler);
    }
    if (window.closed) {
        window.closed.connect(function () {
            trackedWindows.delete(window);
            dictAiWindows.delete(window);
            positionedWindows.delete(window);
            autoFitAnchors.delete(window);
            initialAutoFitAnchors.delete(window);
        });
    }

    syncAutoFitAnchor(window);
    applyAutoFitGeometry(window);
    handleDictAiWindow(window, sourceWindow, capturedCursor);
}

workspace.windowList().forEach(watchWindow);
workspace.windowAdded.connect(watchWindow);
workspace.windowActivated.connect(function (window) {
    syncChromeDefinitionLayer(window);
    if (!window) {
        return;
    }

    if (isDictAiWindow(window)) {
        return;
    }

    lastNonDictAiActiveWindow = window;
});
