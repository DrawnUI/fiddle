// DrawnUI Fiddle — Monaco C# member completion backed by in-browser Roslyn.
// Registered once when the fiddle editor inits. The `enabled` flag lets the page
// turn IntelliSense off instantly (no C# round-trip) if it feels laggy.
window.fiddleIntelliSense = { enabled: true, autoCompile: true, dotnet: null, registered: false };

// Draggable vertical splitter between the code and canvas panes. Updates the
// --fiddle-split CSS var (code pane width %) live while dragging. Clamped so both
// panes always stay visible; min-width:0 on the panes prevents overflow.
window.initFiddleSplitter = function () {
    const split = document.querySelector('.fiddle-split');
    const divider = split && split.querySelector('.fiddle-divider');
    if (!split || !divider || divider._wired) return;
    divider._wired = true;

    let dragging = false;
    divider.addEventListener('pointerdown', function (e) {
        dragging = true;
        divider.classList.add('dragging');
        try { divider.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });
    divider.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        const rect = split.getBoundingClientRect();
        if (rect.width <= 0) return;
        let pct = ((e.clientX - rect.left) / rect.width) * 100;
        pct = Math.max(20, Math.min(80, pct));
        split.style.setProperty('--fiddle-split', pct + '%');
    });
    const end = function (e) {
        if (!dragging) return;
        dragging = false;
        divider.classList.remove('dragging');
        try { divider.releasePointerCapture(e.pointerId); } catch { }
    };
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);

    // Horizontal handle under the split pane — drags the pane HEIGHT. Monaco
    // (automaticLayout) and the DrawnUI canvas (ResizeObserver) adapt on their own.
    const dividerH = document.querySelector('.fiddle-divider-h');
    if (dividerH && !dividerH._wired) {
        dividerH._wired = true;
        let draggingH = false;
        dividerH.addEventListener('pointerdown', function (e) {
            draggingH = true;
            dividerH.classList.add('dragging');
            try { dividerH.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
        });
        dividerH.addEventListener('pointermove', function (e) {
            if (!draggingH) return;
            const rect = split.getBoundingClientRect();
            let h = e.clientY - rect.top;
            h = Math.max(260, Math.min(Math.round(window.innerHeight * 0.95), h));
            split.style.height = h + 'px';
        });
        const endH = function (e) {
            if (!draggingH) return;
            draggingH = false;
            dividerH.classList.remove('dragging');
            try { dividerH.releasePointerCapture(e.pointerId); } catch { }
        };
        dividerH.addEventListener('pointerup', endH);
        dividerH.addEventListener('pointercancel', endH);
    }
};

window.setFiddleAutoCompile = function (on) {
    window.fiddleIntelliSense.autoCompile = !!on;
};

// Inline color swatches + picker for Color.FromHex("...") / Color.Parse("...") literals.
// Monaco shows a swatch before each match; clicking it opens the built-in picker and the
// chosen color is written back into the code (triggering autocompile).
window.fiddleRegisterColorPicker = function () {
    if (window._fiddleColorPicker || typeof monaco === 'undefined') return;
    window._fiddleColorPicker = true;

    function parseHex(hex) {
        let x = hex.slice(1);
        if (x.length === 3 || x.length === 4) x = x.split('').map(c => c + c).join('');
        if (x.length === 6) x = 'FF' + x;
        if (x.length !== 8) return null;
        const n = parseInt(x, 16);
        if (Number.isNaN(n)) return null;
        return {
            alpha: ((n >>> 24) & 255) / 255,
            red: ((n >>> 16) & 255) / 255,
            green: ((n >>> 8) & 255) / 255,
            blue: (n & 255) / 255,
        };
    }

    monaco.languages.registerColorProvider('csharp', {
        provideDocumentColors(model) {
            const out = [];
            const re = /Color\.(?:FromHex|Parse)\(\s*"(#[0-9a-fA-F]{3,8})"\s*\)/g;
            const text = model.getValue();
            let m;
            while ((m = re.exec(text))) {
                const hex = m[1];
                const color = parseHex(hex);
                if (!color) continue;
                const start = m.index + m[0].indexOf(hex);
                const s = model.getPositionAt(start);
                const e = model.getPositionAt(start + hex.length);
                out.push({
                    color,
                    range: {
                        startLineNumber: s.lineNumber, startColumn: s.column,
                        endLineNumber: e.lineNumber, endColumn: e.column,
                    },
                });
            }
            return out;
        },
        provideColorPresentations(model, info) {
            const h = v => Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase();
            const c = info.color;
            const hex = c.alpha < 1
                ? '#' + h(c.alpha) + h(c.red) + h(c.green) + h(c.blue) // #AARRGGBB (MAUI order)
                : '#' + h(c.red) + h(c.green) + h(c.blue);
            return [{ label: hex }];
        },
    });
};

// Shareable links: code is deflate-compressed and base64url-encoded into the URL hash.
// fiddleShareEncode returns the full share URL; fiddleShareDecode reads the current
// location hash and returns the decoded code, or null when there is none.
window.fiddleShareEncode = async function (code) {
    const bytes = new TextEncoder().encode(code);
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    let bin = '';
    new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + '/#code=' + b64;
};
// Short share links via the fiddle-share Cloudflare Worker (routes on fiddle.drawnui.net).
// Absolute endpoint so shares from localhost dev also produce real short links.
const FIDDLE_SHARE_API = 'https://fiddle.drawnui.net/api/share';

// POST code (+ optional base64 PNG thumbnail for the OG preview) -> short URL like
// https://fiddle.drawnui.net/f/aX3kQ9b2. Throws on failure; caller falls back to #code=.
window.fiddleShareShort = async function (code, pngBase64, bg) {
    const r = await fetch(FIDDLE_SHARE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, png: pngBase64 || undefined, bg: bg || undefined }),
    });
    if (!r.ok) throw new Error('share api ' + r.status);
    return (await r.json()).url;
};

// "Run Web App" export: open the created play link in a new tab. Called only AFTER the
// share entry exists (no blank pre-opened tabs). Returns false when a popup blocker
// intervened so the UI can fall back to a clickable link.
window.fiddleOpenTab = function (url) {
    try {
        const w = window.open(url, '_blank');
        return !!w;
    } catch {
        return false;
    }
};

// Player badge: sandboxed host iframes may block window.open (no allow-popups).
// Fall back to navigating our own frame — sandbox always permits self-navigation.
// Wired via delegation because Blazor strips inline on* attributes from markup.
window.fiddleBadgeOpen = function (url) {
    if (window.fiddleOpenTab(url)) return false;
    location.href = url;
    return false;
};
document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('.fiddle-player-badge') : null;
    if (!a) return;
    e.preventDefault();
    window.fiddleBadgeOpen(a.href);
});

// Live canvas pane CSS size, used to shape the iframe embed's aspect ratio.
window.fiddleCanvasSize = function () {
    const c = document.querySelector('.fiddle-canvas');
    if (!c) return [0, 0];
    const r = c.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
};

// Player mode: canvas-only standalone run UI. The worker serves the app directly at
// /p/{id} (address bar keeps the OG-carrying link); legacy #play={id} hash still works.
window.fiddlePlayId = function () {
    const p = location.pathname.match(/\/p\/([A-Za-z0-9]{6,16})$/);
    if (p) return p[1];
    const m = location.hash.match(/#play=([A-Za-z0-9]{6,16})/);
    return m ? m[1] : null;
};

// Fetch shared fiddle by short id (player boot and #id= boot both use this).
// Returns { code, bg } — bg is the canvas background stored with the share, or null.
window.fiddleFetchShared = async function (id) {
    try {
        const r = await fetch(FIDDLE_SHARE_API + '/' + id);
        if (!r.ok) return null;
        return { code: await r.text(), bg: r.headers.get('X-Fiddle-Bg') };
    } catch {
        return null;
    }
};

// Returns { code, bg } for a shared link in the current URL, or null.
window.fiddleShareDecode = async function () {
    // Short link landing redirected here as #id= — fetch from the share API.
    const idm = location.hash.match(/#id=([A-Za-z0-9]{6,16})/);
    if (idm) return await window.fiddleFetchShared(idm[1]);
    const m = location.hash.match(/#code=([A-Za-z0-9\-_]+)/);
    if (!m) return null;
    try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return { code: new TextDecoder().decode(buf), bg: null };
    } catch {
        return null;
    }
};

// Drop the #code= hash from the address bar without reloading (leaving single-fiddle mode).
window.fiddleClearHash = function () {
    history.replaceState(null, '', location.pathname + location.search);
};

// Reflect the selected fiddle in the address bar (app/<slug>) without a reload/reroute.
// Slug resolves relative to <base href>, so a subpath deploy (/app/) yields /app/<slug>.
window.fiddleSetPath = function (slug) {
    history.pushState(null, '', new URL(slug || '', document.baseURI).href);
};

// Copy text to clipboard; textarea fallback for non-secure contexts.
window.fiddleCopyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { }
    document.body.removeChild(ta);
};

// Pin the console output panel to its latest line.
window.scrollFiddleConsole = function () {
    const el = document.getElementById('fiddle-console-body');
    if (el) el.scrollTop = el.scrollHeight;
};

window.setFiddleIntelliSense = function (on) {
    window.fiddleIntelliSense.enabled = !!on;
    if (!on) {
        // Clear squiggles immediately when turned off.
        const models = (typeof monaco !== 'undefined') ? monaco.editor.getModels() : [];
        models.forEach(function (m) { monaco.editor.setModelMarkers(m, 'fiddle', []); });
    } else {
        window.fiddleRunDiagnostics && window.fiddleRunDiagnostics();
    }
};

// Debounced diagnostics: on every edit, ask Roslyn for errors/warnings and paint
// them as Monaco markers (squiggles).
function wireFiddleDiagnostics() {
    const state = window.fiddleIntelliSense;
    const editor = (typeof monaco !== 'undefined') ? monaco.editor.getEditors()[0] : null;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    // Ctrl/Cmd+S recompiles (manual Run). Monaco captures the keybinding while the
    // editor is focused, so the browser's Save dialog is suppressed.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
        if (state.dotnet) {
            try { state.dotnet.invokeMethodAsync('RunFromShortcut'); } catch { }
        }
    });

    let timer;
    const run = async function () {
        if (!state.enabled || !state.dotnet) {
            monaco.editor.setModelMarkers(model, 'fiddle', []);
            return;
        }
        let diags;
        try {
            diags = await state.dotnet.invokeMethodAsync('GetDiagnostics', model.getValue());
        } catch {
            return;
        }
        const sev = monaco.MarkerSeverity;
        const markers = (diags || []).map(function (d) {
            return {
                startLineNumber: d.startLine,
                startColumn: d.startColumn,
                endLineNumber: d.endLine,
                endColumn: d.endColumn,
                message: d.message,
                severity: d.severity === 'Error' ? sev.Error : sev.Warning,
            };
        });
        monaco.editor.setModelMarkers(model, 'fiddle', markers);

        // AutoCompile: run once the code is error-free. C# side skips if unchanged.
        const hasError = (diags || []).some(function (d) { return d.severity === 'Error'; });
        if (state.autoCompile && !hasError) {
            try { await state.dotnet.invokeMethodAsync('AutoCompile'); } catch { }
        }
    };

    window.fiddleRunDiagnostics = function () { clearTimeout(timer); timer = setTimeout(run, 400); };
    model.onDidChangeContent(function () { window.fiddleRunDiagnostics(); });
    run(); // initial pass
}

// window.fiddle — automation API for AI agents and tests. Everything an agent
// needs to drive the fiddle without simulating Monaco keystrokes:
//   await fiddle.getState()        -> { ready, running, status, errors }
//   await fiddle.getCode()         -> current editor code
//   await fiddle.setCode(code)     -> replace editor code
//   await fiddle.run()             -> { success, errors, status } (compiles + renders)
//   await fiddle.getConsole()      -> Console.WriteLine lines from the snippet
//   await fiddle.listPresets()     -> [{ slug, name }]
//   await fiddle.loadPreset(slug)  -> true/false (loads + runs)
// Canvas pixels: use a compositor screenshot (e.g. Playwright element screenshot of
// '.fiddle-canvas canvas') — WebGL preserveDrawingBuffer:false makes toDataURL blank.
window.registerFiddleApi = function (dotnetRef) {
    window.fiddle = {
        getState: function () { return dotnetRef.invokeMethodAsync('ApiGetState'); },
        getCode: function () { return dotnetRef.invokeMethodAsync('ApiGetCode'); },
        setCode: function (code) { return dotnetRef.invokeMethodAsync('ApiSetCode', code); },
        run: function () { return dotnetRef.invokeMethodAsync('ApiRun'); },
        getConsole: function () { return dotnetRef.invokeMethodAsync('ApiGetConsole'); },
        listPresets: function () { return dotnetRef.invokeMethodAsync('ApiListPresets'); },
        loadPreset: function (slug) { return dotnetRef.invokeMethodAsync('ApiLoadPreset', slug); },
    };
};

window.registerFiddleCompletion = function (dotnetRef) {
    window.fiddleIntelliSense.dotnet = dotnetRef;

    if (window.fiddleIntelliSense.registered || typeof monaco === 'undefined')
        return;
    window.fiddleIntelliSense.registered = true;

    wireFiddleDiagnostics();

    monaco.languages.registerCompletionItemProvider('csharp', {
        triggerCharacters: ['.'],
        provideCompletionItems: async function (model, position) {
            const state = window.fiddleIntelliSense;
            if (!state.enabled || !state.dotnet)
                return { suggestions: [] };

            const code = model.getValue();
            const offset = model.getOffsetAt(position);

            let items;
            try {
                items = await state.dotnet.invokeMethodAsync('GetCompletions', code, offset);
            } catch {
                return { suggestions: [] };
            }
            if (!items || !items.length)
                return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            const kinds = monaco.languages.CompletionItemKind;
            return {
                suggestions: items.map(function (i) {
                    return {
                        label: i.label,
                        insertText: i.insertText,
                        kind: kinds[i.kind] != null ? kinds[i.kind] : kinds.Property,
                        range: range,
                    };
                }),
            };
        },
    });
};
