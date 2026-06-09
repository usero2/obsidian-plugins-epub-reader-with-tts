const obsidian = require('obsidian');

const VIEW_TYPE_EPUB = "epub-reader-view";
const EPUB_EXTENSION = "epub";

const DEFAULT_SETTINGS = {
    scrolledView: true,
    ttsHighlight: true,
    lastVoiceIndex: 0,
    rate: 1.0,
    ttsProvider: "system",  // "system" | "google"
    googleTtsLang: "th",    // default language for Google TTS
    toolbarPosition: "top", // "top" | "bottom"
};

// Google TTS supported languages (subset)
const GOOGLE_TTS_LANGS = [
    { code: "th", name: "Thai (ไทย)" },
    { code: "ja", name: "Japanese (日本語)" },
    { code: "ko", name: "Korean (한국어)" },
    { code: "zh-CN", name: "Chinese Simplified (中文)" },
    { code: "zh-TW", name: "Chinese Traditional (繁體中文)" },
    { code: "en", name: "English" },
    { code: "fr", name: "French (Français)" },
    { code: "de", name: "German (Deutsch)" },
    { code: "es", name: "Spanish (Español)" },
    { code: "it", name: "Italian (Italiano)" },
    { code: "pt", name: "Portuguese (Português)" },
    { code: "ru", name: "Russian (Русский)" },
    { code: "vi", name: "Vietnamese (Tiếng Việt)" },
    { code: "id", name: "Indonesian (Bahasa Indonesia)" },
    { code: "hi", name: "Hindi (हिन्दी)" },
    { code: "ar", name: "Arabic (العربية)" },
];

// ============================================================
// Google TTS player — uses Google Translate's unofficial TTS endpoint
// ============================================================
class GoogleTTSPlayer {
    constructor() {
        this._audio = new Audio();
        this._queue = [];
        this._playing = false;
        this._paused = false;
        this._onChunkEnd = null;
        this._onError = null;
        this._rate = 1.0;

        this._audio.onended = () => {
            if (this._queue.length > 0) {
                this._playNext();
            } else {
                this._playing = false;
                if (this._onChunkEnd) this._onChunkEnd();
            }
        };

        this._audio.onerror = (e) => {
            console.error("Google TTS error:", e);
            this._playing = false;
            if (this._onError) this._onError(e);
        };
    }

    get speaking() { return this._playing; }
    get paused() { return this._paused; }

    setRate(r) {
        this._rate = r;
        if (this._audio) {
            this._audio.playbackRate = this._rate;
        }
    }

    // Split text into chunks ≤ 200 chars (Google TTS limit)
    _splitText(text, maxLen = 190) {
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= maxLen) {
                chunks.push(remaining);
                break;
            }
            // Find a good break point
            let breakAt = remaining.lastIndexOf(' ', maxLen);
            if (breakAt <= 0) breakAt = remaining.lastIndexOf(',', maxLen);
            if (breakAt <= 0) breakAt = remaining.lastIndexOf('。', maxLen);
            if (breakAt <= 0) breakAt = maxLen;
            chunks.push(remaining.substring(0, breakAt + 1).trim());
            remaining = remaining.substring(breakAt + 1).trim();
        }
        return chunks.filter(c => c.length > 0);
    }

    speak(text, lang, onEnd, onError) {
        this.cancel();
        const subChunks = this._splitText(text);
        this._queue = subChunks;
        this._playing = true;
        this._paused = false;
        this._onChunkEnd = onEnd;
        this._onError = onError;
        this._lang = lang;
        this._playNext();
    }

    _playNext() {
        if (!this._playing || this._queue.length === 0) {
            this._playing = false;
            if (this._onChunkEnd) this._onChunkEnd();
            return;
        }

        const chunk = this._queue.shift();
        const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${encodeURIComponent(this._lang)}&q=${encodeURIComponent(chunk)}`;

        this._audio.src = url;
        this._audio.playbackRate = this._rate;
        this._audio.play().catch(e => {
            console.error("Google TTS play error:", e);
            this._playing = false;
            if (this._onError) this._onError(e);
        });
    }

    pause() {
        if (this._playing && !this._paused) {
            this._audio.pause();
            this._paused = true;
        }
    }

    resume() {
        if (this._paused) {
            this._audio.play();
            this._paused = false;
        }
    }

    cancel() {
        this._playing = false;
        this._paused = false;
        this._queue = [];
        this._audio.pause();
    }
}

// ============================================================
// EpubReaderView — FileView with direct HTML rendering
// ============================================================
class EpubReaderView extends obsidian.FileView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.settings = plugin.settings;
        this.book = null;
        this.currentSectionIndex = 0;
        this.totalSections = 0;
        this.ttsEngine = window.speechSynthesis;
        this.googleTTS = new GoogleTTSPlayer();
        this.utterance = null;
        this.isPlaying = false;
        this.voices = [];
        this.currentTextChunks = [];
        this.currentChunkIndex = 0;
        this.selectedVoiceIndex = this.settings.lastVoiceIndex || 0;
        this.rate = this.settings.rate || 1.0;
        this.pitch = 1.0;
        this.viewerDiv = null;
        this.statusEl = null;
        this._highlightedEls = [];
    }

    getViewType() { return VIEW_TYPE_EPUB; }
    getDisplayText() { return this.file ? this.file.basename : "EPUB Reader"; }
    getIcon() { return "book-open"; }
    canAcceptExtension(ext) { return ext === EPUB_EXTENSION; }

    // ---- Build UI ----
    async onOpen() {
        this.contentEl.empty();
        this.contentEl.style.cssText = "display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden;";

        this.toolbarWrapper = this.contentEl.createEl("div");
        this.toolbarWrapper.style.cssText = "display:flex;flex-shrink:0;z-index:10;width:100%;align-items:stretch;";
        this.toolbarWrapper.style.order = this.settings.toolbarPosition === "bottom" ? "1" : "0";
        if (this.settings.toolbarPosition === "bottom") {
            this.toolbarWrapper.style.borderTop = "1px solid var(--background-modifier-border)";
            this.toolbarWrapper.style.boxShadow = "0 -2px 5px rgba(0,0,0,0.05)";
        } else {
            this.toolbarWrapper.style.borderBottom = "1px solid var(--background-modifier-border)";
            this.toolbarWrapper.style.boxShadow = "0 2px 5px rgba(0,0,0,0.05)";
        }

        const mkBtn = (parent, text, title) => {
            const b = parent.createEl("button", { text, attr: { title: title || text } });
            b.style.cssText = "padding:4px 12px;cursor:pointer;border-radius:4px;";
            return b;
        };

        this.prevChBtn = mkBtn(this.toolbarWrapper, "◀ Prev");
        this.prevChBtn.style.cssText = "cursor:pointer;border:none;background:var(--background-secondary-alt);padding:0 15px;font-weight:bold;border-right:1px solid var(--background-modifier-border);border-radius:0;height:auto;display:flex;align-items:center;justify-content:center;";
        this.prevChBtn.onclick = () => {
            if (this.currentTextChunks.length > 0) {
                this.skipTTS(-1);
            } else {
                this.turnPage(-1);
            }
        };

        this.toolbarContainer = this.toolbarWrapper.createEl("div");
        this.toolbarContainer.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

        // --- Toolbar Row 1 ---
        const bar1 = this.toolbarContainer.createEl("div");
        bar1.style.cssText = "display:flex;padding:6px 10px;background:var(--background-secondary);align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;";

        this.playBtn  = mkBtn(bar1, "▶ Play");
        this.pauseBtn = mkBtn(bar1, "⏸ Pause");
        this.stopBtn  = mkBtn(bar1, "⏹ Stop");
        this.playBtn.onclick  = () => this.playTTS();
        this.pauseBtn.onclick = () => this.pauseTTS();
        this.stopBtn.onclick  = () => this.stopTTS();

        bar1.createEl("span", { text: "|" }).style.cssText = "color:var(--text-faint);";

        // TTS Provider selector
        this.providerSelect = bar1.createEl("select");
        this.providerSelect.style.cssText = "max-width:140px;";
        const optSystem = this.providerSelect.createEl("option", { text: "🖥️ System TTS", attr: { value: "system" } });
        const optGoogle = this.providerSelect.createEl("option", { text: "🌐 Google TTS", attr: { value: "google" } });
        this.providerSelect.value = this.settings.ttsProvider || "system";
        this.providerSelect.onchange = async () => {
            this.settings.ttsProvider = this.providerSelect.value;
            await this.plugin.saveSettings();
            this._updateVoiceUI();
            if (this.isPlaying) { this.stopTTS(); }
        };

        // System voice selector
        this.voiceSelect = bar1.createEl("select");
        this.voiceSelect.style.cssText = "max-width:180px;";
        this.voiceSelect.onchange = async (e) => {
            this.selectedVoiceIndex = e.target.selectedIndex;
            this.settings.lastVoiceIndex = this.selectedVoiceIndex;
            await this.plugin.saveSettings();
            if (this.isPlaying) { this.stopTTS(); this.playTTS(); }
        };

        // Google TTS language selector
        this.googleLangSelect = bar1.createEl("select");
        this.googleLangSelect.style.cssText = "max-width:180px;";
        GOOGLE_TTS_LANGS.forEach(lang => {
            const opt = this.googleLangSelect.createEl("option", { text: lang.name, attr: { value: lang.code } });
        });
        this.googleLangSelect.value = this.settings.googleTtsLang || "th";
        this.googleLangSelect.onchange = async () => {
            this.settings.googleTtsLang = this.googleLangSelect.value;
            await this.plugin.saveSettings();
        };

        this.loadVoices();
        if (this.ttsEngine && this.ttsEngine.onvoiceschanged !== undefined) {
            this.ttsEngine.onvoiceschanged = () => this.loadVoices();
        }

        this._updateVoiceUI();

        // --- Toolbar Row 2 ---
        const bar2 = this.toolbarContainer.createEl("div");
        bar2.style.cssText = "display:flex;padding:4px 10px;background:var(--background-secondary);align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;border-top:1px dashed var(--background-modifier-border);";

        bar2.createEl("span", { text: "Speed" }).style.cssText = "font-size:12px;color:var(--text-muted);";
        this.rateInput = bar2.createEl("input", { type: "range", attr: { min: "0.5", max: "3", step: "0.1", value: String(this.rate) } });
        this.rateInput.style.cssText = "width:100px;";
        this.rateLabel = bar2.createEl("span", { text: this.rate.toFixed(1) + "x" });
        this.rateLabel.style.cssText = "font-size:12px;color:var(--text-muted);min-width:30px;";
        this.rateInput.oninput = async (e) => {
            this.rate = parseFloat(e.target.value);
            this.rateLabel.innerText = this.rate.toFixed(1) + "x";
            if (this._isGoogleTTS()) {
                this.googleTTS.setRate(this.rate);
            }
            this.settings.rate = this.rate;
            await this.plugin.saveSettings();
        };
        this.rateInput.onchange = async (e) => {
            this.settings.rate = this.rate;
            await this.plugin.saveSettings();
        };

        this.scrollToggle = mkBtn(bar2, this.settings.scrolledView ? "📜 Scroll" : "📄 Page");
        this.scrollToggle.onclick = () => {
            this.settings.scrolledView = !this.settings.scrolledView;
            this.scrollToggle.innerText = this.settings.scrolledView ? "📜 Scroll" : "📄 Page";
            if (this.file) this._renderBook(this.file);
        };

        this.statusEl = bar2.createEl("span", { text: "" });
        this.statusEl.style.cssText = "margin-left:auto;margin-right:8px;font-size:11px;color:var(--text-muted);white-space:nowrap;";

        this.nextChBtn = mkBtn(this.toolbarWrapper, "Next ▶");
        this.nextChBtn.style.cssText = "cursor:pointer;border:none;background:var(--background-secondary-alt);padding:0 15px;font-weight:bold;border-left:1px solid var(--background-modifier-border);border-radius:0;height:auto;display:flex;align-items:center;justify-content:center;";
        this.nextChBtn.onclick = () => {
            if (this.currentTextChunks.length > 0) {
                this.skipTTS(1);
            } else {
                this.turnPage(1);
            }
        };

        // --- Viewer area ---
        this.viewerDiv = this.contentEl.createEl("div");
        this.viewerDiv.style.cssText = "flex:1 1 auto;min-height:0;width:100%;overflow-y:auto;overflow-x:hidden;padding:20px 40px;box-sizing:border-box;";
        this.viewerDiv.addClass("epub-content-viewer");
    }

    _updateVoiceUI() {
        const isGoogle = (this.settings.ttsProvider === "google");
        this.voiceSelect.style.display = isGoogle ? "none" : "";
        this.googleLangSelect.style.display = isGoogle ? "" : "none";
    }

    async onClose() {
        this.stopTTS();
        if (this.book) { try { this.book.destroy(); } catch(_) {} }
    }

    // ---- FileView lifecycle ----
    async onLoadFile(file) {
        if (!file || file.extension !== EPUB_EXTENSION) return;
        await this._renderBook(file);
    }

    async onUnloadFile(file) {
        this.stopTTS();
        if (this.book) { try { this.book.destroy(); } catch(_) {} }
        this.book = null;
        if (this.viewerDiv) this.viewerDiv.empty();
        if (this.statusEl) this.statusEl.innerText = "";
    }

    // ============================================================
    // Core: parse EPUB and render HTML directly (no iframe)
    // ============================================================
    async _renderBook(file) {
        try {
            this._status("Reading…");
            this.stopTTS();
            this._clearHighlights();

            const data = await this.app.vault.adapter.readBinary(file.path);

            if (this.book) { try { this.book.destroy(); } catch(_) {} }
            if (this.zip) { this.zip = null; }
            if (this.viewerDiv) this.viewerDiv.empty();

            if (typeof window.ePub !== "function" || typeof window.JSZip === "undefined") {
                this._status("ERROR: ePub.js or JSZip missing");
                new obsidian.Notice("Required libraries are missing.");
                return;
            }

            this._status("Parsing…");
            this.book = window.ePub(data);
            this.zip = await window.JSZip.loadAsync(data);
            await this.book.ready;

            this.totalSections = this.book.spine.length;
            this.currentSectionIndex = 0;

            if (this.settings.scrolledView) {
                await this._renderAllSections();
            } else {
                await this._renderSection(0);
            }

            this._status("✓ " + file.basename);
        } catch (e) {
            console.error("EPUB Load Error:", e);
            this._status("ERROR: " + (e.message || e));
            new obsidian.Notice("EPUB Error: " + (e.message || e));
        }
    }

    async _renderAllSections() {
        this.viewerDiv.empty();
        this._status("Loading all chapters…");

        for (let i = 0; i < this.totalSections; i++) {
            const section = this.book.spine.get(i);
            if (!section) continue;
            try {
                await section.load(this.book.load.bind(this.book));
                const content = section.document ? section.document.body : null;
                if (content) {
                    const chapterDiv = this.viewerDiv.createEl("div", { cls: "epub-chapter" });
                    chapterDiv.style.cssText = "margin-bottom:30px;padding-bottom:30px;border-bottom:1px solid var(--background-modifier-border);";
                    chapterDiv.setAttribute("data-section", i);
                    await this._injectContent(chapterDiv, content, section);
                }
            } catch (e) { console.warn("Failed to load section " + i, e); }
        }
        this._status("✓ " + (this.file ? this.file.basename : ""));
    }

    async _renderSection(index) {
        if (index < 0 || index >= this.totalSections) return;
        this.currentSectionIndex = index;
        this.viewerDiv.empty();
        this.viewerDiv.scrollTop = 0;

        const section = this.book.spine.get(index);
        if (!section) return;

        try {
            await section.load(this.book.load.bind(this.book));
            const content = section.document ? section.document.body : null;
            if (content) {
                const chapterDiv = this.viewerDiv.createEl("div", { cls: "epub-chapter" });
                await this._injectContent(chapterDiv, content, section);
            }
            this._status(`[${index + 1}/${this.totalSections}] ` + (this.file ? this.file.basename : ""));
        } catch (e) {
            console.error("Failed to load section:", e);
            this.viewerDiv.createEl("p", { text: "Failed to load this chapter: " + e.message });
        }
    }

    async _injectContent(container, bodyEl, section) {
        const fragment = document.createDocumentFragment();
        for (const child of Array.from(bodyEl.childNodes)) {
            fragment.appendChild(child.cloneNode(true));
        }
        container.appendChild(fragment);

        // Resolve images — try multiple path strategies
        const images = container.querySelectorAll("img, image");
        for (const img of images) {
            const src = img.getAttribute("src") || img.getAttribute("href") || img.getAttributeNS("http://www.w3.org/1999/xlink", "href");
            if (!src || src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("http")) continue;

            const blobUrl = await this._resolveImageSrc(src, section);
            if (blobUrl) {
                if (img.tagName.toLowerCase() === "image") {
                    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", blobUrl);
                    img.setAttribute("href", blobUrl);
                } else {
                    img.setAttribute("src", blobUrl);
                }
            }
        }

        // Also handle CSS background-image on elements
        const allEls = container.querySelectorAll("[style]");
        for (const el of allEls) {
            const style = el.getAttribute("style") || "";
            const match = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
            if (match && match[1] && !match[1].startsWith("data:") && !match[1].startsWith("http")) {
                const blobUrl = await this._resolveImageSrc(match[1], section);
                if (blobUrl) {
                    el.setAttribute("style", style.replace(match[0], `url('${blobUrl}')`));
                }
            }
        }

        // Remove scripts
        container.querySelectorAll("script").forEach(s => s.remove());
        // Fix links
        container.querySelectorAll("a[href]").forEach(a => {
            a.onclick = (e) => e.preventDefault();
            a.removeAttribute("target");
        });
    }

    // Resolve image path using JSZip directly
    async _resolveImageSrc(src, section) {
        if (!this.zip) return null;

        // Clean the src
        let cleanSrc = decodeURIComponent(src).replace(/^\.\//, "");
        const justFilename = cleanSrc.split("/").pop();

        // Get the section's directory for relative path resolution
        const sectionDir = section.href ? section.href.substring(0, section.href.lastIndexOf("/") + 1) : "";

        // Build a list of candidate paths to try
        const candidates = [];
        if (sectionDir) candidates.push(this._normalizePath(sectionDir + cleanSrc));
        candidates.push(cleanSrc);
        if (cleanSrc.startsWith("/")) candidates.push(cleanSrc.substring(1));

        const prefixes = ["OEBPS/", "OPS/", "EPUB/", ""];
        for (const prefix of prefixes) {
            candidates.push(prefix + cleanSrc);
            if (justFilename !== cleanSrc) {
                candidates.push(prefix + justFilename);
                candidates.push(prefix + "images/" + justFilename);
                candidates.push(prefix + "Images/" + justFilename);
                candidates.push(prefix + "image/" + justFilename);
                candidates.push(prefix + "img/" + justFilename);
            }
        }

        const files = Object.keys(this.zip.files);

        // 1. Try exact matches from candidates
        for (const path of candidates) {
            if (this.zip.files[path]) {
                return await this._createBlobUrl(this.zip.files[path], justFilename);
            }
        }

        // 2. Try case-insensitive matches from candidates
        const lowerFiles = files.map(f => f.toLowerCase());
        for (const path of candidates) {
            const idx = lowerFiles.indexOf(path.toLowerCase());
            if (idx !== -1) {
                return await this._createBlobUrl(this.zip.files[files[idx]], justFilename);
            }
        }

        // 3. Fallback: Search the entire ZIP for any file ending with this filename
        const match = files.find(f => f.endsWith("/" + justFilename) || f === justFilename);
        if (match) {
            return await this._createBlobUrl(this.zip.files[match], justFilename);
        }

        return null;
    }

    async _createBlobUrl(zipEntry, filename) {
        try {
            const arrayBuffer = await zipEntry.async("arraybuffer");
            let mimeType = "image/jpeg";
            const ext = filename.split('.').pop().toLowerCase();
            if (ext === "png") mimeType = "image/png";
            else if (ext === "gif") mimeType = "image/gif";
            else if (ext === "svg") mimeType = "image/svg+xml";
            else if (ext === "webp") mimeType = "image/webp";

            const blob = new Blob([arrayBuffer], { type: mimeType });
            return URL.createObjectURL(blob);
        } catch(e) {
            console.error("Failed to create blob for", filename, e);
            return null;
        }
    }

    // Normalize path (resolve ../ and ./)
    _normalizePath(path) {
        const parts = path.split("/");
        const result = [];
        for (const part of parts) {
            if (part === "..") {
                result.pop();
            } else if (part !== "." && part !== "") {
                result.push(part);
            }
        }
        return result.join("/");
    }

    goSection(index) {
        if (index < 0) index = 0;
        if (index >= this.totalSections) index = this.totalSections - 1;
        this._renderSection(index);
    }

    turnPage(offset) {
        if (!this.viewerDiv) return;
        const pageHeight = this.viewerDiv.clientHeight * 0.85; // 85% of screen height
        const currentScroll = this.viewerDiv.scrollTop;
        const maxScroll = this.viewerDiv.scrollHeight - this.viewerDiv.clientHeight;

        if (offset > 0) {
            // Next page
            if (currentScroll >= maxScroll - 10) {
                if (!this.settings.scrolledView) {
                    this.goSection(this.currentSectionIndex + 1);
                }
            } else {
                this.viewerDiv.scrollBy({ top: pageHeight, behavior: "smooth" });
            }
        } else {
            // Prev page
            if (currentScroll <= 10) {
                if (!this.settings.scrolledView) {
                    this.goSection(this.currentSectionIndex - 1);
                }
            } else {
                this.viewerDiv.scrollBy({ top: -pageHeight, behavior: "smooth" });
            }
        }
    }

    _status(msg) { if (this.statusEl) this.statusEl.innerText = msg; }

    // ============================================================
    // TTS with Highlight (supports both System and Google)
    // ============================================================
    loadVoices() {
        if (!this.ttsEngine) return;
        this.voices = this.ttsEngine.getVoices();
        if (!this.voiceSelect) return;
        this.voiceSelect.empty();
        this.voices.forEach((v, i) => {
            const opt = this.voiceSelect.createEl("option", { text: `${v.name} (${v.lang})` });
            opt.value = i;
        });
        if (this.voices.length > 0 && this.voiceSelect.options.length > this.selectedVoiceIndex) {
            this.voiceSelect.selectedIndex = this.selectedVoiceIndex;
        }
    }

    _isGoogleTTS() {
        return this.settings.ttsProvider === "google";
    }

    async playTTS() {
        // Handle resume
        if (this.isPlaying) {
            if (this._isGoogleTTS()) {
                if (this.googleTTS.paused) { this.googleTTS.resume(); return; }
            } else {
                if (this.ttsEngine.paused) { this.ttsEngine.resume(); return; }
            }
            return;
        }

        if (this.currentTextChunks.length === 0 || this.currentChunkIndex >= this.currentTextChunks.length) {
            this._extractText();
        }
        if (this.currentTextChunks.length === 0) {
            new obsidian.Notice("No text found.");
            return;
        }

        // Check if user clicked/selected somewhere to start from cursor
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const anchorNode = sel.anchorNode;
            if (anchorNode && this.viewerDiv.contains(anchorNode)) {
                // Clear selection so it doesn't stay blue while TTS highlights
                if ('highlights' in CSS) sel.removeAllRanges(); 

                const chunkIdx = this.currentTextChunks.findIndex(chunk => {
                    return chunk.ranges.some(r => {
                        const c = r.startContainer;
                        return c === anchorNode || c.parentNode === anchorNode || (anchorNode.contains && anchorNode.contains(c));
                    });
                });
                
                if (chunkIdx !== -1) {
                    this.currentChunkIndex = chunkIdx;
                }
            }
        }

        this.isPlaying = true;
        this.readNextChunk();
    }

    skipTTS(offset) {
        if (this.currentTextChunks.length === 0) return false;

        let newIndex = this.currentChunkIndex + offset;
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= this.currentTextChunks.length) newIndex = this.currentTextChunks.length - 1;

        this.currentChunkIndex = newIndex;

        if (this.isPlaying) {
            if (this._isGoogleTTS()) {
                this.googleTTS._onChunkEnd = null;
                this.googleTTS._onError = null;
                this.googleTTS.cancel();
            } else {
                if (this.utterance) {
                    this.utterance.onend = null;
                    this.utterance.onerror = null;
                }
                if (this.ttsEngine) this.ttsEngine.cancel();
            }
            this.readNextChunk();
        } else {
            const chunk = this.currentTextChunks[this.currentChunkIndex];
            this._highlightChunk(chunk);
        }
        return true;
    }

    readNextChunk() {
        if (!this.isPlaying) return;

        if (this.currentChunkIndex >= this.currentTextChunks.length) {
            this.isPlaying = false;
            this._clearHighlights();
            if (!this.settings.scrolledView && this.currentSectionIndex < this.totalSections - 1) {
                this.goSection(this.currentSectionIndex + 1);
                setTimeout(() => this.playTTS(), 600);
            }
            return;
        }

        const chunk = this.currentTextChunks[this.currentChunkIndex];
        this._highlightChunk(chunk);

        const onEnd = () => { this.currentChunkIndex++; this.readNextChunk(); };
        const onErr = (e) => { console.error("TTS Error:", e); this.isPlaying = false; this._clearHighlights(); };

        if (this._isGoogleTTS()) {
            // Google TTS
            this.googleTTS.setRate(this.rate);
            this.googleTTS.speak(
                chunk.text,
                this.settings.googleTtsLang || "th",
                onEnd,
                onErr
            );
        } else {
            // System TTS
            this.utterance = new SpeechSynthesisUtterance(chunk.text);
            if (this.voices.length > 0) this.utterance.voice = this.voices[this.selectedVoiceIndex];
            this.utterance.rate  = this.rate;
            this.utterance.pitch = this.pitch;
            this.utterance.onend = onEnd;
            this.utterance.onerror = onErr;
            this.ttsEngine.speak(this.utterance);
        }
    }

    pauseTTS() {
        if (this._isGoogleTTS()) {
            this.googleTTS.pause();
        } else {
            if (this.ttsEngine && this.ttsEngine.speaking) this.ttsEngine.pause();
        }
    }

    stopTTS() {
        this.isPlaying = false;
        this.googleTTS.cancel();
        if (this.ttsEngine) this.ttsEngine.cancel();
        this.currentChunkIndex = 0;
        this.currentTextChunks = [];
        this._clearHighlights();
    }

    _extractText() {
        this.currentTextChunks = [];
        this.currentChunkIndex = 0;
        if (!this.viewerDiv) return;

        const blocks = this.viewerDiv.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, div");
        
        blocks.forEach(block => {
            // Ignore divs that just act as containers and have block children
            if (block.tagName === 'DIV' && block.children.length > 0) {
                const hasBlockChildren = Array.from(block.children).some(c => 
                    ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE'].includes(c.tagName));
                if (hasBlockChildren) return;
            }

            const text = block.textContent;
            if (!text || !text.trim()) return;

            const textNodes = [];
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
            let n;
            while ((n = walker.nextNode())) {
                textNodes.push(n);
            }

            if (textNodes.length === 0) return;

            const regex = /([^.!?。！？\n]+[.!?。！？\n]*)/g;
            let match;
            let currentTextNodeIndex = 0;
            let currentTextNodeOffset = 0;

            while ((match = regex.exec(text)) !== null) {
                const fullSentence = match[0];
                
                const pieces = [];
                let remaining = fullSentence;
                const MAX_LEN = 150;
                
                while (remaining.length > 0) {
                    if (remaining.length <= MAX_LEN) {
                        pieces.push(remaining);
                        break;
                    }
                    let breakAt = remaining.lastIndexOf(' ', MAX_LEN);
                    if (breakAt <= 0) breakAt = remaining.lastIndexOf(',', MAX_LEN);
                    if (breakAt <= 0) breakAt = remaining.lastIndexOf('、', MAX_LEN);
                    if (breakAt <= 0) breakAt = remaining.indexOf(' ', MAX_LEN);
                    if (breakAt <= 0) breakAt = MAX_LEN;
                    
                    pieces.push(remaining.substring(0, breakAt + 1));
                    remaining = remaining.substring(breakAt + 1);
                }

                for (const piece of pieces) {
                    const trimmed = piece.trim();
                    let remainingLength = piece.length;
                    const ranges = [];

                    while (remainingLength > 0 && currentTextNodeIndex < textNodes.length) {
                        const tNode = textNodes[currentTextNodeIndex];
                        const nodeLength = tNode.nodeValue.length;
                        const availableInNode = nodeLength - currentTextNodeOffset;

                        if (availableInNode <= 0) {
                            currentTextNodeIndex++;
                            currentTextNodeOffset = 0;
                            continue;
                        }

                        const range = document.createRange();
                        range.setStart(tNode, currentTextNodeOffset);

                        if (availableInNode >= remainingLength) {
                            range.setEnd(tNode, currentTextNodeOffset + remainingLength);
                            ranges.push(range);
                            currentTextNodeOffset += remainingLength;
                            remainingLength = 0;
                        } else {
                            range.setEnd(tNode, nodeLength);
                            ranges.push(range);
                            remainingLength -= availableInNode;
                            currentTextNodeIndex++;
                            currentTextNodeOffset = 0;
                        }
                    }

                    if (trimmed.length > 0) {
                        this.currentTextChunks.push({ text: trimmed, ranges: ranges });
                    }
                }
            }
        });
    }

    // ---- Highlight ----
    _highlightChunk(chunk) {
        this._clearHighlights();
        if (!this.settings.ttsHighlight) return;
        if (!chunk || !chunk.ranges || chunk.ranges.length === 0) return;

        try {
            if ('highlights' in CSS) {
                const highlight = new Highlight(...chunk.ranges);
                CSS.highlights.set('tts-highlight', highlight);
            } else {
                const sel = window.getSelection();
                sel.removeAllRanges();
                chunk.ranges.forEach(r => sel.addRange(r));
            }

            // Scroll into view
            const firstNode = chunk.ranges[0].startContainer;
            const el = firstNode.nodeType === 3 ? firstNode.parentElement : firstNode;
            if (el && el.scrollIntoView) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        } catch(e) { console.error("Highlight error:", e); }
    }

    _clearHighlights() {
        try {
            if ('highlights' in CSS) {
                CSS.highlights.delete('tts-highlight');
            } else {
                window.getSelection().removeAllRanges();
            }
        } catch(_) {}
    }
}

// ============================================================
// Settings
// ============================================================
class EpubReaderSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "EPUB Reader + TTS Settings" });

        new obsidian.Setting(containerEl)
            .setName("Scrolled View")
            .setDesc("Enable seamless infinite scrolling between pages.")
            .addToggle(t => t.setValue(this.plugin.settings.scrolledView).onChange(async v => {
                this.plugin.settings.scrolledView = v; await this.plugin.saveSettings();
            }));

        new obsidian.Setting(containerEl)
            .setName("TTS Highlight")
            .setDesc("Highlight text currently being read aloud.")
            .addToggle(t => t.setValue(this.plugin.settings.ttsHighlight).onChange(async v => {
                this.plugin.settings.ttsHighlight = v; await this.plugin.saveSettings();
            }));

        new obsidian.Setting(containerEl)
            .setName("TTS Provider")
            .setDesc("Choose TTS engine. Use Google TTS for languages not available on your system (e.g., Thai).")
            .addDropdown(d => {
                d.addOption("system", "🖥️ System TTS");
                d.addOption("google", "🌐 Google TTS (supports Thai, Japanese, etc.)");
                d.setValue(this.plugin.settings.ttsProvider || "system");
                d.onChange(async v => {
                    this.plugin.settings.ttsProvider = v; await this.plugin.saveSettings();
                });
            });

        new obsidian.Setting(containerEl)
            .setName("Toolbar Position")
            .setDesc("Choose whether the TTS toolbar should be on top or at the bottom.")
            .addDropdown(d => {
                d.addOption("top", "⬆️ Top");
                d.addOption("bottom", "⬇️ Bottom");
                d.setValue(this.plugin.settings.toolbarPosition || "top");
                d.onChange(async v => {
                    this.plugin.settings.toolbarPosition = v; await this.plugin.saveSettings();
                });
            });

        new obsidian.Setting(containerEl)
            .setName("Google TTS Language")
            .setDesc("Language for Google TTS. Default is Thai.")
            .addDropdown(d => {
                GOOGLE_TTS_LANGS.forEach(l => d.addOption(l.code, l.name));
                d.setValue(this.plugin.settings.googleTtsLang || "th");
                d.onChange(async v => {
                    this.plugin.settings.googleTtsLang = v; await this.plugin.saveSettings();
                });
            });
    }
}

// ============================================================
// Plugin
// ============================================================
class EpubReaderPlugin extends obsidian.Plugin {
    async onload() {
        console.log("Loading EPUB Reader + TTS Plugin");
        await this.loadSettings();
        this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubReaderView(leaf, this));
        try { this.registerExtensions([EPUB_EXTENSION], VIEW_TYPE_EPUB); } catch(e) { console.log("epub extension already registered"); }
        this.addSettingTab(new EpubReaderSettingTab(this.app, this));
    }
    onunload() { console.log("Unloading EPUB Reader + TTS Plugin"); }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

module.exports = EpubReaderPlugin;
