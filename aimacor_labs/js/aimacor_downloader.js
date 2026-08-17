import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AimacorLabs.Downloader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AimacorLabs_Downloader") {

            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                o.aimacor_models = [];
                if (this.rowsContainer) {
                    for (let row of this.rowsContainer.children) {
                        const enabled = row.querySelector(".model-toggle").checked;
                        const url = row.querySelector(".url-input").value;
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");

                        const isHF = selectFile.style.display === "block";
                        const selected_url = isHF ? selectFile.value : url;
                        let filename = isHF ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();

                        const filesize = row.querySelector(".size-label").innerText;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;

                        if (url.trim() !== "") {
                            o.aimacor_models.push({ enabled, url, selected_url, filename, filesize, folder, subfolder });
                        }
                    }
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.aimacor_models) {
                    this.restored_models = o.aimacor_models;
                    if (this.folders_loaded && this.rowsContainer && this.rowsContainer.children.length === 0) {
                        this.rowsContainer.innerHTML = "";
                        this.restored_models.forEach(m => this.addRow(m, true));
                        setTimeout(() => {
                            Array.from(this.rowsContainer.children).forEach((r, idx) => setTimeout(() => this.checkRowStatus(r), idx * 200));
                        }, 500);
                    }
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const MIN_WIDTH = 950;
                this.size = [1000, 200];
                let folders = [];
                let currentPreset = "default";
                const _this = this;

                this.folders_loaded = false;

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 10px; color: #d8faff; background: #05070d;
                    font-family: 'Consolas', 'Courier New', monospace; font-size: 12px; width: 100%; height: 100%;
                    box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                    border-radius: 6px; border: 1px solid #1c2b3a;
                `;

                container.innerHTML = `
                    <style>
                        :root {
                            --neon-cyan: #00fff9;
                            --neon-magenta: #ff00e6;
                            --neon-violet: #bd00ff;
                            --neon-green: #39ff14;
                            --neon-red: #ff2d55;
                            --neon-yellow: #f9f871;
                            --bg-panel: #0b0f18;
                            --bg-row: #10151f;
                        }
                        .amc-switch { position: relative; display: inline-block; width: 30px; height: 16px; flex-shrink: 0; }
                        .amc-switch input { opacity: 0; width: 0; height: 0; }
                        .amc-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #2a2f3a; transition: .2s; border-radius: 16px; border: 1px solid #3a4152; }
                        .amc-slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 1px; bottom: 1px; background-color: #6a7383; transition: .2s; border-radius: 50%; }
                        .amc-switch input:checked + .amc-slider { background-color: #06202b; border-color: var(--neon-cyan); box-shadow: 0 0 6px var(--neon-cyan); }
                        .amc-switch input:checked + .amc-slider:before { transform: translateX(14px); background-color: var(--neon-cyan); box-shadow: 0 0 4px var(--neon-cyan); }

                        .amc-dl-row { display: flex; gap: 8px; align-items: center; background: var(--bg-row); padding: 6px; border-radius: 4px; transition: 0.2s; border: 1px solid #1c2536; }
                        .amc-dl-row.disabled { opacity: 0.4; }
                        .amc-dl-row.drag-over-top { border-top: 3px solid var(--neon-cyan); box-shadow: 0 -2px 8px var(--neon-cyan); }
                        .amc-dl-row.drag-over-bottom { border-bottom: 3px solid var(--neon-cyan); box-shadow: 0 2px 8px var(--neon-cyan); }

                        .amc-drag-handle { cursor: grab; color: #4a5568; font-size: 15px; user-select: none; padding: 0 4px; display: flex; align-items: center; }
                        .amc-drag-handle:hover { color: var(--neon-cyan); }

                        .amc-btn { cursor: pointer; padding: 5px 8px; color: #d8faff; border: 1px solid #2a3646; border-radius: 4px; font-weight: bold; background: #131a26; transition: 0.15s; font-family: inherit; }
                        .amc-btn:hover { background: #1b2536; border-color: var(--neon-cyan); box-shadow: 0 0 6px rgba(0,255,249,0.4); color: #fff; }
                        .amc-btn:disabled { cursor: default; opacity: 1 !important; }
                        .amc-input { padding: 4px 6px; border-radius: 3px; border: 1px solid #232d3d; outline: none; background: #0b0f18; color: #d8faff; font-family: inherit; }
                        .amc-input:focus { border-color: var(--neon-cyan); box-shadow: 0 0 5px rgba(0,255,249,0.3); }

                        .amc-title-bar { font-weight: bold; letter-spacing: 1px; color: var(--neon-cyan); text-shadow: 0 0 8px rgba(0,255,249,0.6); }

                        .amc-progress-wrap { position: relative; width: 100%; height: 22px; background: #0b0f18; border: 1px solid #2a3646; border-radius: 4px; overflow: hidden; }
                        .amc-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--neon-violet), var(--neon-cyan)); box-shadow: 0 0 8px var(--neon-cyan); transition: width 0.3s ease; }
                        .amc-progress-text { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; text-shadow: 0 0 3px #000; }

                        .amc-led { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; transition: 0.2s; }
                        .amc-led.pulse { animation: amc-pulse 1s infinite ease-in-out; }
                        @keyframes amc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
                    </style>
                    <div style="display:flex; align-items:center; gap:8px; padding-bottom: 4px; border-bottom: 1px solid #1c2b3a;">
                        <span class="amc-title-bar">⚡ AIMACOR LABS // MODEL DOWNLOADER</span>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="amc-btn-add" class="amc-btn" style="flex: 1;">➕ Add Model</button>
                        <button id="amc-btn-check" class="amc-btn">🔄 Check Status</button>
                        <input id="amc-civ-token" type="password" class="amc-input" style="flex: 1.5;" placeholder="Civitai API Key">
                        <input id="amc-hf-token" type="password" class="amc-input" style="flex: 1.5;" placeholder="HuggingFace Token">
                        <button id="amc-btn-savetokens" class="amc-btn" style="border-color: var(--neon-green); color: var(--neon-green);">💾 Save Tokens</button>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; background: var(--bg-panel); padding: 6px; border-radius: 4px; border: 1px solid #1c2536;">
                        <select id="amc-preset-sel" style="flex: 1; padding: 4px; background: #0b0f18; color: #d8faff; border: 1px solid #232d3d; border-radius: 3px; font-family: inherit;"></select>
                        <button id="amc-btn-load" class="amc-btn">📂 Load</button>
                        <button id="amc-btn-save" class="amc-btn">💾 Save</button>
                        <button id="amc-btn-saveas" class="amc-btn">📝 Save As...</button>
                        <button id="amc-btn-import" class="amc-btn">📥 Import</button>
                        <input type="file" id="amc-file-import" accept=".json" style="display: none;">
                        <button id="amc-btn-export" class="amc-btn">📤 Export</button>
                    </div>
                    <div id="amc-rows-container" style="display: flex; flex-direction: column; gap: 4px;"></div>
                    <button id="amc-btn-dl-all" class="amc-btn" style="margin-top: auto; background: #0b2a1a; border-color: var(--neon-green); color: var(--neon-green); padding: 8px; box-shadow: 0 0 6px rgba(57,255,20,0.25);">⬇️ Download All Enabled</button>
                `;

                this.rowsContainer = container.querySelector("#amc-rows-container");

                this.computeSize = function (out) {
                    let baseH = 130;
                    let numRows = this.rowsContainer ? this.rowsContainer.children.length : 0;
                    let contentHeight = baseH + (numRows * 44);
                    return [MIN_WIDTH, contentHeight];
                };

                const forceResize = () => {
                    setTimeout(() => {
                        const min = this.computeSize();
                        const w = Math.max(this.size[0], min[0]);
                        const h = Math.max(this.size[1], min[1]);
                        this.setSize([w, h]);
                        app.graph.setDirtyCanvas(true, true);
                    }, 10);
                };

                const originalOnResize = this.onResize;
                this.onResize = function (size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    let numRows = this.rowsContainer ? this.rowsContainer.children.length : 0;
                    let contentHeight = 130 + (numRows * 44);
                    if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                    if (size[1] < contentHeight) size[1] = contentHeight;
                };

                const getRowPayload = (row) => {
                    const urlInput = row.querySelector(".url-input").value;
                    const fileSelect = row.querySelector(".file-select");
                    const isHF = fileSelect.style.display === "block";

                    let fname = isHF ? fileSelect.options[fileSelect.selectedIndex]?.text : row.querySelector(".filename-input").value;
                    if (fname) fname = fname.split('/').pop().split('\\').pop();

                    return {
                        url: isHF ? fileSelect.value : urlInput,
                        folder: row.querySelector(".folder-select").value,
                        subfolder: row.querySelector(".subfolder-input").value,
                        filename: fname,
                        civitai_token: container.querySelector("#amc-civ-token").value,
                        hf_token: container.querySelector("#amc-hf-token").value
                    };
                };

                // Aplica una carpeta detectada automáticamente SOLO si el usuario no
                // ha elegido una carpeta a mano en esta fila todavía.
                const applyFolderHint = (row, hint) => {
                    if (!hint) return;
                    if (row.dataset.folderManual === "true") return;
                    const folderSel = row.querySelector(".folder-select");
                    if (!folders.includes(hint)) return; // solo aplicamos carpetas que existen localmente
                    if (folderSel.value !== hint) folderSel.value = hint;
                };

                const setLed = (led, color, glow, pulsing) => {
                    led.style.backgroundColor = color;
                    led.style.boxShadow = glow ? `0 0 8px ${color}` : "none";
                    led.classList.toggle("pulse", !!pulsing);
                };

                const showProgressUI = (row, show) => {
                    row.querySelector(".amc-progress-wrap").style.display = show ? "block" : "none";
                    row.querySelector(".amc-controls-normal").style.display = show ? "none" : "flex";
                };

                const checkRowStatus = async (row) => {
                    const payload = getRowPayload(row);
                    if (!payload.url || payload.url === "none") return;

                    const led = row.querySelector(".amc-led");
                    const btn = row.querySelector(".amc-dl-btn");
                    const stopBtn = row.querySelector(".amc-stop-btn");
                    const copyBtn = row.querySelector(".amc-copy-btn");
                    const sizeLabel = row.querySelector(".size-label");
                    const fileSelect = row.querySelector(".file-select");
                    const fnameInput = row.querySelector(".filename-input");
                    const progWrap = row.querySelector(".amc-progress-wrap");
                    const progBar = row.querySelector(".amc-progress-bar");
                    const progText = row.querySelector(".amc-progress-text");

                    setLed(led, "#ff9500", true, false);

                    try {
                        const res = await fetch("/aimacor/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                        const data = await res.json();

                        if (data.filename && data.filename !== "Direct Link" && data.filename !== "Pending...") {
                            if (fileSelect.style.display !== "block") {
                                fnameInput.value = data.filename;
                                fnameInput.style.color = "#d8faff";
                            }
                        }

                        let newSize = data.filesize || "Unknown";
                        if ((newSize === "Unknown" || newSize === "Error" || newSize === "0 B") && fileSelect.style.display === "block") {
                            const opt = fileSelect.options[fileSelect.selectedIndex];
                            if (opt && opt.dataset.size) newSize = opt.dataset.size;
                        }
                        if (newSize !== "Unknown" && newSize !== "Error" && newSize !== "0 B") {
                            sizeLabel.innerText = newSize;
                        }

                        // Auto-detección de carpeta para links directos (Civitai, etc.)
                        // en base al nombre de archivo resuelto por el backend.
                        if (data.folder_hint) applyFolderHint(row, data.folder_hint);

                        if (data.exists) {
                            progWrap.style.display = "none";
                            setLed(led, "var(--neon-green)", true, false);
                            led.title = `Ready: ${data.filename}`;
                            btn.innerText = "Completed"; btn.disabled = true; btn.style.borderColor = "var(--neon-green)"; btn.style.color = "var(--neon-green)";
                            stopBtn.style.display = "none";
                            copyBtn.style.display = "inline-block";
                            copyBtn.dataset.path = data.full_dir || "";
                        } else if (data.is_downloading) {
                            copyBtn.style.display = "none";
                            setLed(led, "var(--neon-yellow)", true, true);
                            led.title = data.dl_status || "Downloading...";
                            progWrap.style.display = "block";
                            btn.style.display = "none";
                            stopBtn.style.display = "inline-block";
                            // El texto del botón refleja el estado REAL del servidor en cada
                            // poll, en vez de un texto fijado localmente al hacer clic — así
                            // nunca queda atascado en "Cancelling..." en la próxima descarga.
                            const isCancelling = data.dl_status === "cancelling";
                            stopBtn.innerText = isCancelling ? "⏹ Cancelling..." : "⏹ Stop";
                            stopBtn.disabled = isCancelling;
                            const pct = data.progress >= 0 ? data.progress : 0;
                            progBar.style.width = pct + "%";
                            progText.innerText = data.dl_status && data.dl_status !== "downloading" ? data.dl_status.toUpperCase() : `${pct}%`;
                        } else if (data.message === "auth_required") {
                            copyBtn.style.display = "none";
                            progWrap.style.display = "none";
                            setLed(led, "var(--neon-magenta)", true, false);
                            led.title = "API Key Required";
                            btn.style.display = "inline-block"; btn.innerText = "Need Token"; btn.disabled = false;
                            btn.style.borderColor = "var(--neon-magenta)"; btn.style.color = "var(--neon-magenta)";
                            stopBtn.style.display = "none";
                        } else {
                            copyBtn.style.display = "none";
                            progWrap.style.display = "none";
                            setLed(led, "var(--neon-red)", true, false);
                            led.title = "Not downloaded";
                            btn.style.display = "inline-block"; btn.innerText = "Download"; btn.disabled = false;
                            btn.style.borderColor = "#2a3646"; btn.style.color = "#d8faff";
                            stopBtn.style.display = "none";
                        }
                        return data;
                    } catch (e) {
                        setLed(led, "var(--neon-red)", true, false);
                    }
                };

                const downloadRow = async (row) => {
                    const payload = getRowPayload(row);
                    if (!payload.url || payload.url === "none") return;

                    // Si quedaba un polling anterior corriendo (ej. de un intento previo
                    // cancelado), lo detenemos antes de arrancar uno nuevo.
                    if (row.dataset.pollId) clearInterval(Number(row.dataset.pollId));

                    const led = row.querySelector(".amc-led");
                    const btn = row.querySelector(".amc-dl-btn");
                    const stopBtn = row.querySelector(".amc-stop-btn");
                    btn.innerText = "⏳ Starting..."; btn.disabled = true;
                    stopBtn.innerText = "⏹ Stop"; stopBtn.disabled = false; // reset por si quedó "Cancelling..." de antes
                    setLed(led, "var(--neon-yellow)", true, true);

                    try {
                        await fetch("/aimacor/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                        const poll = setInterval(async () => {
                            const data = await checkRowStatus(row);
                            // Detener el polling en CUALQUIER estado final: completado,
                            // cancelado, o error — no solo cuando "exists" es true.
                            if (!data || !data.is_downloading) clearInterval(poll);
                        }, 1500);
                        row.dataset.pollId = poll;
                    } catch (e) { }
                };

                const cancelRow = async (row) => {
                    const payload = getRowPayload(row);
                    if (!payload.url) return;
                    const stopBtn = row.querySelector(".amc-stop-btn");
                    stopBtn.innerText = "⏹ Cancelling..."; stopBtn.disabled = true;
                    try {
                        await fetch("/aimacor/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: payload.url }) });
                        // El polling ya activo (de downloadRow) recogerá el resultado final
                        // en su próximo tick; este chequeo extra solo acelera el refresco.
                        setTimeout(() => checkRowStatus(row), 500);
                    } catch (e) { }
                };

                let draggedRow = null;

                const addRow = (data = {}, isRestoring = false) => {
                    const isEnabled = data.enabled !== undefined ? data.enabled : (data.active !== undefined ? data.active : true);
                    const savedUrl = data.url || data.selected_url || "";
                    const savedSelectedUrl = data.selected_url || data.url || "";
                    const savedFilename = data.filename || data.file || data.name || "Direct Link";
                    const savedFilesize = data.filesize || data.size || "-- MB";
                    const savedFolder = data.folder || data.dir || "";
                    const savedSubfolder = data.subfolder || data.sub_folder || "";

                    const isRealName = savedFilename && savedFilename !== "Direct Link" && savedFilename !== "Pending...";
                    const showSelect = savedSelectedUrl && savedSelectedUrl.includes("huggingface.co/");

                    const row = document.createElement("div");
                    row.className = `amc-dl-row ${isEnabled ? '' : 'disabled'}`;
                    // Si la fila trae una carpeta ya guardada (preset/restauración), la
                    // tratamos como elegida manualmente para no pisarla con auto-detección.
                    row.dataset.folderManual = savedFolder ? "true" : "false";

                    let folderOptions = [...folders];
                    if (savedFolder && !folderOptions.includes(savedFolder)) {
                        folderOptions.push(savedFolder);
                    }

                    row.innerHTML = `
                        <div class="amc-drag-handle" draggable="true" title="Drag to reorder">⠿</div>
                        <label class="amc-switch">
                            <input type="checkbox" class="model-toggle" ${isEnabled ? 'checked' : ''}>
                            <span class="amc-slider"></span>
                        </label>
                        <input type="text" class="url-input amc-input" placeholder="URL (Civitai, HF...)" value="${savedUrl}" style="flex: 2;">
                        <div style="flex: 2; position: relative;">
                            <select class="file-select amc-input" style="width: 100%; display: ${showSelect ? 'block' : 'none'};"></select>
                            <input type="text" class="filename-input amc-input" value="${savedFilename}" style="width: 100%; display: ${showSelect ? 'none' : 'block'}; text-align: center; color: ${isRealName ? '#d8faff' : '#6a7383'};">
                        </div>
                        <div class="size-label" style="flex: 0.5; text-align: center; color: #7fa; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${savedFilesize}</div>
                        <select class="folder-select amc-input" style="flex: 1.2;">
                            ${folderOptions.map(f => `<option value="${f}" ${savedFolder === f ? 'selected' : ''}>${f}</option>`).join('')}
                        </select>
                        <input type="text" class="subfolder-input amc-input" placeholder="Subfolder" value="${savedSubfolder}" style="flex: 1;">
                        <div style="flex: 1.4; position: relative; display: flex; align-items: center;">
                            <div class="amc-progress-wrap" style="display:none; width: 100%;">
                                <div class="amc-progress-bar"></div>
                                <div class="amc-progress-text">0%</div>
                            </div>
                            <div class="amc-controls-normal" style="display:flex; gap: 6px; width: 100%;">
                                <button class="amc-btn amc-dl-btn" style="flex: 1;">Download</button>
                            </div>
                            <button class="amc-btn amc-stop-btn" style="display:none; border-color: var(--neon-red); color: var(--neon-red); margin-left: 6px;" title="Cancel download">⏹ Stop</button>
                        </div>
                        <button class="amc-btn amc-copy-btn" style="display:none; padding: 5px 6px;" title="Copy folder path">📋</button>
                        <div class="amc-led" style="background-color: var(--neon-red); box-shadow: 0 0 8px var(--neon-red);" title="Not downloaded"></div>
                        <button class="amc-del-btn" style="background: transparent; border: none; color: #6a7383; cursor: pointer; padding: 0px 4px; font-size: 14px;">❌</button>
                    `;

                    if (showSelect) {
                        const sel = row.querySelector(".file-select");
                        const opt = document.createElement("option");
                        opt.value = savedSelectedUrl; opt.innerText = savedFilename;
                        sel.appendChild(opt);
                    }
                    // (Ya no forzamos "loras" por defecto: la carpeta se detecta
                    // automáticamente según el archivo en cuanto se resuelve la URL.)

                    row.querySelector(".model-toggle").addEventListener("change", (e) => {
                        if (e.target.checked) row.classList.remove("disabled"); else row.classList.add("disabled");
                    });

                    row.querySelector(".amc-del-btn").addEventListener("click", () => {
                        row.remove();
                        forceResize();
                    });

                    row.querySelector(".amc-dl-btn").addEventListener("click", () => downloadRow(row));
                    row.querySelector(".amc-stop-btn").addEventListener("click", () => cancelRow(row));

                    row.querySelector(".amc-copy-btn").addEventListener("click", (e) => {
                        const path = e.currentTarget.dataset.path;
                        if (!path) return;
                        navigator.clipboard?.writeText(path).then(() => {
                            const btn = e.currentTarget;
                            const original = btn.innerText;
                            btn.innerText = "✅";
                            setTimeout(() => btn.innerText = original, 1200);
                        }).catch(() => { });
                    });

                    const handleUrlFetch = async (isRestoringCall = false) => {
                        const url = row.querySelector(".url-input").value;
                        const sel = row.querySelector(".file-select");
                        const fInput = row.querySelector(".filename-input");
                        const sizeLbl = row.querySelector(".size-label");

                        if (!url) return;
                        if (!isRestoringCall) sizeLbl.innerText = "⏳...";

                        try {
                            const res = await fetch("/aimacor/parse_url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, hf_token: container.querySelector("#amc-hf-token").value }) });
                            const parsed = await res.json();

                            const desiredSelection = isRestoringCall && data.selected_url ? data.selected_url : sel.value;

                            if (parsed.type === "repo") {
                                sel.innerHTML = "";
                                parsed.files.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f.url;
                                    opt.innerText = f.name.split('/').pop().split('\\').pop();
                                    opt.dataset.size = f.size;
                                    opt.dataset.folderHint = f.folder_hint || "";
                                    sel.appendChild(opt);
                                });
                                sel.style.display = "block"; fInput.style.display = "none";

                                if (Array.from(sel.options).some(o => o.value === desiredSelection)) {
                                    sel.value = desiredSelection;
                                }

                                // Auto-detección de carpeta: usamos la estructura del propio
                                // repo (carpeta 'vae/', 'loras/', etc. definida por el autor).
                                applyFolderHint(row, sel.options[sel.selectedIndex]?.dataset.folderHint);

                                if (!isRestoringCall || sizeLbl.innerText === "-- MB" || sizeLbl.innerText === "Unknown") {
                                    sizeLbl.innerText = sel.options[sel.selectedIndex]?.dataset.size || "-- MB";
                                }
                            } else {
                                sel.style.display = "none"; fInput.style.display = "block";
                                if (!isRestoringCall) {
                                    fInput.value = "Direct Link"; fInput.style.color = "#6a7383";
                                }
                            }

                            if (!isRestoringCall) checkRowStatus(row);

                        } catch (e) { if (!isRestoringCall) sizeLbl.innerText = "Error"; }
                    };

                    row.querySelector(".url-input").addEventListener("change", () => handleUrlFetch(false));

                    row.querySelector(".file-select").addEventListener("change", () => {
                        const sel = row.querySelector(".file-select");
                        const opt = sel.options[sel.selectedIndex];
                        if (opt && opt.dataset.size) row.querySelector(".size-label").innerText = opt.dataset.size;
                        // Si el usuario elige otro archivo del mismo repo, re-evaluamos la
                        // carpeta sugerida (solo si no la fijó manualmente).
                        if (opt && opt.dataset.folderHint) applyFolderHint(row, opt.dataset.folderHint);
                        checkRowStatus(row);
                    });

                    row.querySelector(".folder-select").addEventListener("change", () => {
                        // Este listener solo se dispara con interacción real del usuario
                        // (los cambios programáticos de applyFolderHint no lo disparan),
                        // así que a partir de aquí respetamos su elección manual.
                        row.dataset.folderManual = "true";
                        checkRowStatus(row);
                    });
                    row.querySelector(".subfolder-input").addEventListener("change", () => checkRowStatus(row));
                    row.querySelector(".filename-input").addEventListener("change", () => checkRowStatus(row));

                    const handle = row.querySelector(".amc-drag-handle");
                    handle.addEventListener("mousedown", () => { row.draggable = true; });

                    row.addEventListener("dragend", () => {
                        row.draggable = false;
                        draggedRow = null;
                        row.classList.remove('drag-over-top', 'drag-over-bottom');
                        row.style.opacity = '';
                    });

                    row.addEventListener('dragstart', (e) => {
                        draggedRow = row;
                        e.dataTransfer.effectAllowed = 'move';
                        setTimeout(() => row.style.opacity = '0.4', 0);
                    });

                    row.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        const rect = row.getBoundingClientRect();
                        if (e.clientY < rect.top + rect.height / 2) {
                            row.classList.add('drag-over-top'); row.classList.remove('drag-over-bottom');
                        } else {
                            row.classList.add('drag-over-bottom'); row.classList.remove('drag-over-top');
                        }
                    });
                    row.addEventListener('dragleave', () => { row.classList.remove('drag-over-top', 'drag-over-bottom'); });
                    row.addEventListener('drop', (e) => {
                        e.stopPropagation();
                        row.classList.remove('drag-over-top', 'drag-over-bottom');
                        if (draggedRow && draggedRow !== row) {
                            const rect = row.getBoundingClientRect();
                            if (e.clientY < rect.top + rect.height / 2) _this.rowsContainer.insertBefore(draggedRow, row);
                            else _this.rowsContainer.insertBefore(draggedRow, row.nextSibling);
                        }
                        return false;
                    });

                    _this.rowsContainer.appendChild(row);
                    if (!isRestoring) forceResize();

                    if (data.url && data.url.startsWith("http")) {
                        setTimeout(() => handleUrlFetch(isRestoring), isRestoring ? 300 + Math.random() * 800 : 100);
                    }
                };

                this.addRow = addRow;
                this.checkRowStatus = checkRowStatus;

                container.querySelector("#amc-btn-add").addEventListener("click", () => addRow());

                container.querySelector("#amc-btn-check").addEventListener("click", async () => {
                    Array.from(this.rowsContainer.children).forEach(r => checkRowStatus(r));
                });

                container.querySelector("#amc-btn-dl-all").addEventListener("click", async () => {
                    Array.from(this.rowsContainer.children).forEach(r => {
                        if (!r.querySelector(".model-toggle").checked) return;
                        const btn = r.querySelector(".amc-dl-btn");
                        const led = r.querySelector(".amc-led");
                        const bg = led.style.backgroundColor;
                        if (bg.includes("255, 45, 85") || bg === "var(--neon-red)" || bg === "rgb(255, 45, 85)") {
                            btn.click();
                        } else if (bg.includes("255, 0, 230") || bg === "rgb(255, 0, 230)") {
                            alert("A token is missing to download secure models.");
                        }
                    });
                });

                container.querySelector("#amc-btn-savetokens").addEventListener("click", async (e) => {
                    const btn = e.target;
                    try {
                        btn.innerText = "⌛...";
                        await fetch("/aimacor/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ civitai: container.querySelector("#amc-civ-token").value, huggingface: container.querySelector("#amc-hf-token").value }) });
                        btn.innerText = "✅ Saved!"; setTimeout(() => btn.innerText = "💾 Save Tokens", 2000);
                    } catch (e) { btn.innerText = "❌ Error"; }
                });

                const presetSel = container.querySelector("#amc-preset-sel");
                const refreshPresetsList = async () => {
                    try {
                        const res = await fetch("/aimacor/download_presets");
                        const data = await res.json();
                        if (data.status === "success") {
                            presetSel.innerHTML = "";
                            data.files.forEach(f => {
                                const opt = document.createElement("option"); opt.value = f; opt.innerText = f; presetSel.appendChild(opt);
                            });
                            if (data.files.length > 0) presetSel.value = data.files.includes(currentPreset) ? currentPreset : data.files[0];
                        }
                    } catch (e) { }
                };

                container.querySelector("#amc-btn-load").addEventListener("click", async () => {
                    if (!presetSel.value) return;
                    try {
                        const res = await fetch(`/aimacor/download_presets?name=${presetSel.value}`);
                        const data = await res.json();
                        if (data.status === "success") {
                            _this.rowsContainer.innerHTML = "";
                            data.data.forEach(item => addRow(item, true));
                            currentPreset = presetSel.value;
                            forceResize();
                            setTimeout(() => { Array.from(_this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 500);
                        }
                    } catch (e) { }
                });

                const saveToServer = async (presetName) => {
                    const models = [];
                    for (let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");
                        let filename = selectFile.style.display === "block" ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();

                        models.push({
                            enabled: row.querySelector(".model-toggle").checked,
                            url: row.querySelector(".url-input").value,
                            selected_url: selectFile.style.display === "block" ? selectFile.value : row.querySelector(".url-input").value,
                            filename: filename,
                            filesize: row.querySelector(".size-label").innerText,
                            folder: row.querySelector(".folder-select").value,
                            subfolder: row.querySelector(".subfolder-input").value
                        });
                    }
                    try {
                        await fetch("/aimacor/download_presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: presetName, data: models }) });
                        currentPreset = presetName;
                        await refreshPresetsList();
                        container.querySelector("#amc-btn-save").innerText = "✅ Saved";
                        setTimeout(() => container.querySelector("#amc-btn-save").innerText = "💾 Save", 2000);
                    } catch (e) { }
                };

                container.querySelector("#amc-btn-save").addEventListener("click", () => {
                    if (!currentPreset || currentPreset === "default") {
                        const name = prompt("Enter a name for this preset:", "My_Models");
                        if (name) saveToServer(name);
                    } else { saveToServer(currentPreset); }
                });

                container.querySelector("#amc-btn-saveas").addEventListener("click", () => {
                    const name = prompt("Enter a NEW name for this preset:", currentPreset + "_copy");
                    if (name) saveToServer(name);
                });

                container.querySelector("#amc-btn-export").addEventListener("click", () => {
                    const models = [];
                    for (let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");
                        let filename = selectFile.style.display === "block" ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();

                        models.push({
                            enabled: row.querySelector(".model-toggle").checked,
                            url: row.querySelector(".url-input").value,
                            selected_url: selectFile.style.display === "block" ? selectFile.value : row.querySelector(".url-input").value,
                            filename: filename,
                            filesize: row.querySelector(".size-label").innerText,
                            folder: row.querySelector(".folder-select").value,
                            subfolder: row.querySelector(".subfolder-input").value
                        });
                    }

                    let exportName = "aimacor_models";
                    if (models.length > 0 && models[0].filename && models[0].filename !== "Direct Link") {
                        exportName = "download_list_" + models[0].filename.replace(/\.[^/.]+$/, "");
                    }

                    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(models, null, 4));
                    const downloadAnchorNode = document.createElement('a');
                    downloadAnchorNode.setAttribute("href", dataStr);
                    downloadAnchorNode.setAttribute("download", exportName + ".json");
                    document.body.appendChild(downloadAnchorNode);
                    downloadAnchorNode.click();
                    downloadAnchorNode.remove();
                });

                const fileImportInput = container.querySelector("#amc-file-import");
                container.querySelector("#amc-btn-import").addEventListener("click", () => fileImportInput.click());
                fileImportInput.addEventListener("change", (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        try {
                            const data = JSON.parse(event.target.result);
                            _this.rowsContainer.innerHTML = "";
                            data.forEach(item => addRow(item, true));
                            forceResize();
                            setTimeout(() => { Array.from(_this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 500);
                        } catch (err) { alert("Invalid JSON file."); }
                    };
                    reader.readAsText(file);
                    fileImportInput.value = "";
                });

                async function fetchFolders() {
                    try {
                        const res = await fetch("/aimacor/folders");
                        folders = await res.json();
                        _this.folders_loaded = true;
                    } catch (e) { }
                }

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);

                fetch("/aimacor/tokens").then(r => r.json()).then(d => {
                    if (d.civitai) container.querySelector("#amc-civ-token").value = d.civitai;
                    if (d.huggingface) container.querySelector("#amc-hf-token").value = d.huggingface;
                }).catch(() => { });

                refreshPresetsList().then(() => {
                    fetchFolders().then(() => {
                        if (this.restored_models && this.restored_models.length > 0) {
                            this.rowsContainer.innerHTML = "";
                            this.restored_models.forEach(m => addRow(m, true));
                            setTimeout(() => { Array.from(this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 1000);
                        } else {
                            if (this.rowsContainer.children.length === 0) {
                                addRow();
                            }
                        }
                    });
                });
            };
        }
    }
});
