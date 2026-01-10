// Prevent multiple injections
chrome.runtime.sendMessage({ action: 'contentScriptReady' });
if (window.pageVoiceInitialized) {
    console.log('Page Voice already initialized');
} else {
    window.pageVoiceInitialized = true;
    console.log('Page Voice content script loaded');

    var speechState = {
        isSpeaking: false,
        isPaused: false,
        rate: 1.0,
        voiceURI: null
    };

    var synthesis = window.speechSynthesis;
    var currentUtterance = null;
    var textMap = [];
    var activeUtterances = new Set();
    var isInternalStop = false;
    var extensionContextValid = true;
    var markedRanges = [];
    var currentCharIndex = 0;
    var pausedAtIndex = 0;
    var lastBoundaryIndex = 0;

    // Navigation Globals
    var globalFullText = '';
    var globalCurrentOffset = 0;

    // Word segmenter cache
    var wordSegmenter = null;
    var cachedSegments = null;

    // Highlight tracking interval
    var highlightInterval = null;
    var estimatedPosition = 0;
    var lastBoundaryTime = 0;
    var speechStartTime = 0;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      ::highlight(speech-word) {
        background-color: #fef08a !important;
        color: #000 !important;
      }
      ::highlight(speech-mark) {
        background-color: #86efac !important;
        color: #000 !important;
        text-decoration: underline !important;
      }
      #page-voice-debug {
        position: fixed;
        bottom: 10px;
        right: 10px;
        background: rgba(0,0,0,0.9);
        color: white;
        padding: 12px;
        border-radius: 8px;
        z-index: 999999;
        font-family: monospace;
        font-size: 11px;
        pointer-events: none;
        max-width: 300px;
        line-height: 1.4;
      }
    `;
    document.head.appendChild(style);

    let debugOverlay = null;
    function updateDebugOverlay(text) {
        if (!debugOverlay) {
            debugOverlay = document.createElement('div');
            debugOverlay.id = 'page-voice-debug';
            document.body.appendChild(debugOverlay);
        }
        debugOverlay.innerHTML = text.replace(/\n/g, '<br>');
        console.log('[PageVoice]', text);
    }

    function forceLoadVoices() {
        const voices = synthesis.getVoices();
        if (voices.length === 0) {
            synthesis.onvoiceschanged = () => {
                console.log('Voices loaded:', synthesis.getVoices().length);
            };
        }
    }
    forceLoadVoices();

    function getPageLanguage() {
        return document.documentElement.lang || navigator.language || 'en';
    }

    function getWordSegmenter() {
        if (!wordSegmenter) {
            try {
                const lang = getPageLanguage();
                wordSegmenter = new Intl.Segmenter(lang, { granularity: 'word' });
                console.log(`Created word segmenter for language: ${lang}`);
            } catch (e) {
                console.warn('Could not create word segmenter:', e);
            }
        }
        return wordSegmenter;
    }

    function isVisible(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;

        const style = window.getComputedStyle(element);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;

        return true;
    }

    function getReadableText(element) {
        let text = '';
        const nodes = element.childNodes;

        for (let node of nodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                const content = node.textContent.trim();
                if (content) text += content + ' ';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();

                if (['script', 'style', 'noscript', 'iframe', 'svg', 'button'].includes(tag)) {
                    continue;
                }

                if (!isVisible(node)) continue;

                const childText = getReadableText(node);
                if (childText) {
                    text += childText + ' ';

                    if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br'].includes(tag)) {
                        text += '. ';
                    }
                }
            }
        }

        return text.trim();
    }

    function findBestContentRoot() {
        console.log('=== Finding Best Content Root ===');

        const strategies = [
            // PDF Viewer Strategy
            () => {
                const viewer = document.getElementById('viewer');
                if (viewer && isVisible(viewer)) {
                    console.log('PDF Viewer found');
                    return { element: viewer, strategy: 'pdf-viewer', chars: 1000 }; // High confidence
                }
                return null;
            },

            () => {
                const article = document.querySelector('article');
                if (article && isVisible(article)) {
                    const text = getReadableText(article);
                    console.log(`Article found: ${text.length} chars`);
                    if (text.length > 100) return { element: article, strategy: 'article tag', chars: text.length };
                }
                return null;
            },

            () => {
                const main = document.querySelector('main');
                if (main && isVisible(main)) {
                    const text = getReadableText(main);
                    console.log(`Main found: ${text.length} chars`);
                    if (text.length > 100) return { element: main, strategy: 'main tag', chars: text.length };
                }
                return null;
            },

            () => {
                const roleMain = document.querySelector('[role="main"]');
                if (roleMain && isVisible(roleMain)) {
                    const text = getReadableText(roleMain);
                    console.log(`Role=main found: ${text.length} chars`);
                    if (text.length > 100) return { element: roleMain, strategy: 'role=main', chars: text.length };
                }
                return null;
            },

            () => {
                const contentSelectors = [
                    '.post-content', '.article-content', '.entry-content',
                    '.content', '.main-content', '#content', '#main-content',
                    '[class*="content"]', '[id*="content"]'
                ];

                for (const selector of contentSelectors) {
                    try {
                        const elements = document.querySelectorAll(selector);
                        for (const el of elements) {
                            if (isVisible(el)) {
                                const text = getReadableText(el);
                                if (text.length > 200) {
                                    console.log(`Content class found (${selector}): ${text.length} chars`);
                                    return { element: el, strategy: `selector: ${selector}`, chars: text.length };
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`Selector failed: ${selector}`, e);
                    }
                }
                return null;
            },

            () => {
                const containers = document.querySelectorAll('div, section, article');
                let best = null;
                let maxScore = 0;

                for (const container of containers) {
                    if (!isVisible(container)) continue;

                    const paragraphs = container.querySelectorAll('p');
                    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
                    const score = paragraphs.length * 10 + headings.length * 5;

                    if (score > maxScore && score > 20) {
                        const text = getReadableText(container);
                        if (text.length > 300) {
                            maxScore = score;
                            best = { element: container, strategy: 'paragraph density', chars: text.length, score: score };
                        }
                    }
                }

                if (best) console.log(`Paragraph density found: ${best.chars} chars, score: ${best.score}`);
                return best;
            }
        ];

        for (const strategy of strategies) {
            const result = strategy();
            if (result) {
                console.log(`✓ Using strategy: ${result.strategy}`);
                console.log(`Element: ${result.element.tagName}.${result.element.className}`);
                return result.element;
            }
        }

        console.log('⚠ Falling back to body');
        return document.body;
    }

    function buildTextMap() {
        console.log('=== Building Text Map ===');
        textMap = [];
        let fullText = '';
        let currentIndex = 0;

        const rootNode = findBestContentRoot();

        const walker = document.createTreeWalker(
            rootNode,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;

                    const text = node.nodeValue;
                    if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
                    if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

                    const tag = parent.tagName.toLowerCase();

                    if (['script', 'style', 'noscript', 'iframe', 'svg'].includes(tag)) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    if (parent.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) {
                        // Exception for PDF viewer which might be inside something else (unlikely but safe)
                        if (!parent.closest('#viewer')) {
                            return NodeFilter.FILTER_REJECT;
                        }
                    }

                    if (parent.closest('button, input, select, textarea, label')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        let lastElement = null;

        while (node = walker.nextNode()) {
            const text = node.nodeValue;
            const parent = node.parentElement;
            const tag = parent.tagName.toLowerCase();

            if (lastElement && lastElement !== parent) {
                const lastTag = lastElement.tagName.toLowerCase();
                if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'li'].includes(lastTag)) {
                    fullText += '. ';
                    currentIndex += 2;
                }
            }

            textMap.push({
                node: node,
                start: currentIndex,
                end: currentIndex + text.length,
                text: text,
                element: parent,
                tag: tag
            });

            fullText += text + ' ';
            currentIndex += text.length + 1;
            lastElement = parent;
        }

        console.log(`✓ Text map built:`);
        console.log(`  - Nodes: ${textMap.length}`);
        console.log(`  - Total chars: ${fullText.length}`);
        console.log(`  - First 150 chars: "${fullText.substring(0, 150)}..."`);

        if (textMap.length > 0) {
            const tags = [...new Set(textMap.map(t => t.tag))];
            console.log(`  - Tags found: ${tags.join(', ')}`);
        }

        return fullText.trim();
    }

    function getWordLength(text, startPos) {
        const segmenter = getWordSegmenter();

        try {
            if (segmenter) {
                const slice = text.substring(startPos, startPos + 50);
                const segments = segmenter.segment(slice);

                for (const seg of segments) {
                    if (seg.index === 0 && seg.isWordLike) {
                        return seg.segment.length;
                    }
                }

                for (const seg of segments) {
                    if (seg.isWordLike) {
                        return seg.index + seg.segment.length;
                    }
                }
            }
        } catch (e) {
            console.warn('Intl.Segmenter failed, using fallback:', e);
        }

        // Robust fallback using regex patterns
        const slice = text.substring(startPos, startPos + 50);

        // CJK characters (Chinese, Japanese, Korean)
        const cjkMatch = slice.match(/^[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/);
        if (cjkMatch) return 1;

        // Arabic script
        const arabicMatch = slice.match(/^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/);
        if (arabicMatch) return arabicMatch[0].length;

        // Thai script
        const thaiMatch = slice.match(/^[\u0E00-\u0E7F]+/);
        if (thaiMatch) return thaiMatch[0].length;

        // Devanagari (Hindi, Sanskrit, etc.)
        const devanagariMatch = slice.match(/^[\u0900-\u097F]+/);
        if (devanagariMatch) return devanagariMatch[0].length;

        // Standard word (Latin, Cyrillic, etc.)
        const wordMatch = slice.match(/^[\w\u00C0-\u024F\u0400-\u04FF]+/);
        if (wordMatch) return wordMatch[0].length;

        // Single character fallback
        return 1;
    }

    function highlightRange(charIndex, charLength) {
        CSS.highlights.delete('speech-word');
        currentCharIndex = charIndex;

        // Get proper word length for any language
        let actualLength = charLength;
        if (!actualLength || actualLength < 1) {
            actualLength = getWordLength(globalFullText, charIndex);
        }

        for (const item of textMap) {
            if (charIndex >= item.start && charIndex < item.end) {
                try {
                    const range = new Range();
                    const offsetStart = Math.max(0, charIndex - item.start);
                    const offsetEnd = Math.min(item.node.nodeValue.length, offsetStart + actualLength);

                    if (offsetEnd > offsetStart) {
                        range.setStart(item.node, offsetStart);
                        range.setEnd(item.node, offsetEnd);

                        window.currentSpeechRange = range.cloneRange();
                        const highlight = new Highlight(range);
                        CSS.highlights.set('speech-word', highlight);

                        item.element.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                        });
                    }
                } catch (e) {
                    console.warn('Highlight error:', e);
                }
                break;
            }
        }
    }

    // Fallback highlighting for voices that don't fire boundary events
    function startHighlightInterval() {
        stopHighlightInterval();

        const textToSpeak = globalFullText.substring(globalCurrentOffset);
        const estimatedDuration = (textToSpeak.length / 15) * 1000 / speechState.rate;
        const updateFrequency = 200;

        speechStartTime = Date.now();
        lastBoundaryTime = speechStartTime;
        estimatedPosition = globalCurrentOffset;

        highlightInterval = setInterval(() => {
            if (!speechState.isSpeaking || speechState.isPaused) {
                stopHighlightInterval();
                return;
            }

            // If we have recent boundary events, use those
            const timeSinceLastBoundary = Date.now() - lastBoundaryTime;
            if (timeSinceLastBoundary < 1500) {
                return;
            }

            // Estimate position based on time elapsed
            const elapsed = Date.now() - speechStartTime;
            const progressRatio = elapsed / estimatedDuration;
            estimatedPosition = globalCurrentOffset + Math.floor(textToSpeak.length * progressRatio);

            if (estimatedPosition < globalFullText.length) {
                highlightRange(estimatedPosition, 0);
            } else {
                stopHighlightInterval();
            }
        }, updateFrequency);
    }

    function stopHighlightInterval() {
        if (highlightInterval) {
            clearInterval(highlightInterval);
            highlightInterval = null;
        }
    }

    function markCurrentLocation() {
        console.log('Marking location at index:', currentCharIndex);

        let positionToMark = currentCharIndex;

        // Safety check: if no range, try to create one from current index
        if (!window.currentSpeechRange && globalFullText && textMap.length > 0) {
            console.log('No active range, trying to recreate from index ' + positionToMark);
            for (const item of textMap) {
                if (positionToMark >= item.start && positionToMark < item.end) {
                    try {
                        const len = getWordLength(globalFullText, positionToMark);
                        const range = new Range();
                        const offsetStart = Math.max(0, positionToMark - item.start);
                        const offsetEnd = Math.min(item.node.nodeValue.length, offsetStart + len);
                        if (offsetEnd > offsetStart) {
                            range.setStart(item.node, offsetStart);
                            range.setEnd(item.node, offsetEnd);
                            window.currentSpeechRange = range.cloneRange();
                        }
                    } catch (e) {
                        console.warn('Recovery creation failed', e);
                    }
                    break;
                }
            }
        }

        if (!window.currentSpeechRange) {
            console.warn('No active range to mark');
            updateDebugOverlay('Cannot mark: No text selected');
            setTimeout(() => {
                if (speechState.isSpeaking) updateDebugOverlay('Speaking...');
                else if (speechState.isPaused) updateDebugOverlay('Paused');
                else updateDebugOverlay('Ready');
            }, 1000);
            return;
        }

        try {
            const clonedRange = window.currentSpeechRange.cloneRange();
            markedRanges.push(clonedRange);

            const highlight = new Highlight(...markedRanges);
            CSS.highlights.set('speech-mark', highlight);

            console.log(`✓ Marked position ${positionToMark}, total: ${markedRanges.length}`);
            updateDebugOverlay(`✓ Marked!\nTotal marks: ${markedRanges.length}`);
            setTimeout(() => {
                if (speechState.isSpeaking) {
                    updateDebugOverlay(`Speaking...\n${markedRanges.length} marks`);
                }
            }, 1500);
        } catch (e) {
            console.error('Mark error:', e);
            updateDebugOverlay('✗ Mark failed');
        }
    }

    function clearHighlight() {
        CSS.highlights.delete('speech-word');
    }

    function clearAllMarks() {
        markedRanges = [];
        CSS.highlights.delete('speech-mark');
        updateDebugOverlay('Marks cleared');
        console.log('All marks cleared');
    }

    function broadcastState() {
        if (!extensionContextValid) return;
        try {
            chrome.runtime.sendMessage({
                action: 'stateUpdate',
                state: speechState
            });
        } catch (e) {
            if (e.message.includes('context invalidated')) {
                extensionContextValid = false;
            }
        }
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!chrome.runtime?.id) {
            extensionContextValid = false;
            return false;
        }

        try {
            switch (request.action) {
                case 'getState':
                    sendResponse(speechState);
                    break;
                case 'play':
                    startSpeaking(0);
                    sendResponse(speechState);
                    break;
                case 'pause':
                    pauseSpeaking();
                    sendResponse(speechState);
                    break;
                case 'resume':
                    resumeSpeaking();
                    sendResponse(speechState);
                    break;
                case 'stop':
                    stopSpeaking();
                    sendResponse(speechState);
                    break;
                case 'mark':
                    markCurrentLocation();
                    sendResponse(speechState);
                    break;
                case 'clearMarks':
                    clearAllMarks();
                    sendResponse(speechState);
                    break;
                case 'next':
                    navigate('next');
                    sendResponse(speechState);
                    break;
                case 'previous':
                    navigate('previous');
                    sendResponse(speechState);
                    break;
                case 'setRate':
                    speechState.rate = request.rate;
                    if (speechState.isSpeaking && !speechState.isPaused) {
                        const savedPosition = Math.max(currentCharIndex, lastBoundaryIndex);
                        startSpeaking(savedPosition);
                    }
                    sendResponse(speechState);
                    break;
                case 'setVoice':
                    speechState.voiceURI = request.voiceURI;
                    console.log('Voice selected:', speechState.voiceURI);
                    if (speechState.isSpeaking && !speechState.isPaused) {
                        const savedPosition = Math.max(currentCharIndex, lastBoundaryIndex);
                        startSpeaking(savedPosition);
                    }
                    sendResponse(speechState);
                    break;
            }
        }
        catch (e) {
            console.error('Message handler error:', e);
            sendResponse({ error: e.message });
        }

        return true;
    });

    function getSegments() {
        if (!cachedSegments && globalFullText) {
            try {
                const lang = getPageLanguage();
                console.log(`Using language for segmentation: ${lang}`);
                const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
                cachedSegments = [...segmenter.segment(globalFullText)];
                console.log(`Computed ${cachedSegments.length} sentence segments`);
            } catch (e) {
                console.warn('Intl.Segmenter failed, using fallback', e);
                const sentences = globalFullText.split(/[.!?]+\s+/);
                let index = 0;
                cachedSegments = sentences.map(sentence => {
                    const segment = {
                        segment: sentence,
                        index: index,
                        input: globalFullText
                    };
                    index += sentence.length + 2;
                    return segment;
                });
                console.log(`Fallback segmentation: ${cachedSegments.length} segments`);
            }
        }
        return cachedSegments || [];
    }

    function navigate(direction) {
        console.log(`=== Navigate ${direction} ===`);

        if (!globalFullText) {
            globalFullText = buildTextMap();
            cachedSegments = null;
        }

        const segments = getSegments();
        if (segments.length === 0) {
            console.warn('No segments found');
            return;
        }

        let navPosition = currentCharIndex;
        if (lastBoundaryIndex > 0 && Math.abs(currentCharIndex - lastBoundaryIndex) < 50) {
            navPosition = lastBoundaryIndex;
        }

        let currentSegIndex = segments.findIndex(seg =>
            navPosition >= seg.index && navPosition < seg.index + seg.segment.length
        );

        if (currentSegIndex === -1) {
            if (navPosition >= globalFullText.length) {
                currentSegIndex = segments.length - 1;
            } else {
                currentSegIndex = 0;
            }
        }

        let newIndex = navPosition;

        if (direction === 'next') {
            if (currentSegIndex < segments.length - 1) {
                newIndex = segments[currentSegIndex + 1].index;
                console.log(`Jumping to next sentence segment: ${newIndex}`);
            } else {
                newIndex = globalFullText.length;
                console.log('At last sentence');
            }
        } else if (direction === 'previous') {
            const currentSeg = segments[currentSegIndex];
            if (navPosition - currentSeg.index > 10) {
                newIndex = currentSeg.index;
                console.log(`Restarting current sentence: ${newIndex}`);
            } else {
                if (currentSegIndex > 0) {
                    newIndex = segments[currentSegIndex - 1].index;
                    console.log(`Jumping to previous sentence segment: ${newIndex}`);
                } else {
                    newIndex = 0;
                    console.log('At first sentence');
                }
            }
        }

        updateDebugOverlay(`${direction === 'next' ? '→' : '←'} Jumping to ${newIndex}`);
        startSpeaking(newIndex);
    }

    function pauseSpeaking() {
        console.log('Pausing speech...');
        stopHighlightInterval();

        // Use the most reliable position
        pausedAtIndex = currentCharIndex;
        if (lastBoundaryIndex > 0 && Math.abs(currentCharIndex - lastBoundaryIndex) < 50) {
            pausedAtIndex = lastBoundaryIndex;
        }

        isInternalStop = true;
        if (synthesis.speaking || synthesis.pending) {
            synthesis.cancel();
        }
        cleanupCurrentUtterance();
        isInternalStop = false;

        speechState.isSpeaking = false;
        speechState.isPaused = true;

        updateDebugOverlay(`⏸ Paused at ${pausedAtIndex}\n${markedRanges.length} marks`);
        broadcastState();
        console.log(`✓ Paused at position: ${pausedAtIndex}`);
    }

    function resumeSpeaking() {
        console.log(`Resuming speech from position: ${pausedAtIndex}`);

        if (!speechState.isPaused) {
            console.log('Not in paused state');
            return;
        }

        speechState.isPaused = false;

        if (pausedAtIndex < 0) pausedAtIndex = 0;
        if (pausedAtIndex > globalFullText.length) pausedAtIndex = globalFullText.length - 1;

        startSpeaking(pausedAtIndex);
        console.log('✓ Resumed');
    }

    function stopSpeaking() {
        console.log('Stopping speech');
        stopHighlightInterval();

        isInternalStop = true;
        if (synthesis.speaking || synthesis.pending) {
            synthesis.cancel();
        }
        cleanupCurrentUtterance();
        isInternalStop = false;

        speechState.isSpeaking = false;
        speechState.isPaused = false;
        globalCurrentOffset = 0;
        currentCharIndex = 0;
        pausedAtIndex = 0;
        lastBoundaryIndex = 0;

        clearHighlight();
        activeUtterances.clear();

        updateDebugOverlay(`⏹ Stopped\n${markedRanges.length} marks`);
        broadcastState();
    }

    function cleanupCurrentUtterance() {
        if (currentUtterance) {
            currentUtterance.onstart = null;
            currentUtterance.onend = null;
            currentUtterance.onerror = null;
            currentUtterance.onboundary = null;
            currentUtterance.onpause = null;
            currentUtterance.onresume = null;
            activeUtterances.delete(currentUtterance);
            currentUtterance = null;
        }
    }

    function startSpeaking(startOffset = 0) {
        console.log(`=== Starting Speech (Offset: ${startOffset}) ===`);
        updateDebugOverlay('Starting...');

        const voices = synthesis.getVoices();
        console.log(`Available voices: ${voices.length}`);

        // Stop any current speech
        isInternalStop = true;
        if (synthesis.speaking || synthesis.pending) {
            synthesis.cancel();
        }
        cleanupCurrentUtterance();
        stopHighlightInterval();
        isInternalStop = false;

        // Rebuild map only if starting fresh or map missing
        if (startOffset === 0 || !globalFullText) {
            globalFullText = buildTextMap();
            wordSegmenter = null;
            getWordSegmenter();
            cachedSegments = null;
        }

        if (!globalFullText || globalFullText.length < 10) {
            const msg = 'Error: No readable text found!\nCheck console for details.';
            updateDebugOverlay(msg);
            speechState.isSpeaking = false;
            speechState.isPaused = false;
            broadcastState();
            return;
        }

        if (startOffset < 0) startOffset = 0;
        if (startOffset >= globalFullText.length) {
            updateDebugOverlay('End of content');
            speechState.isSpeaking = false;
            speechState.isPaused = false;
            broadcastState();
            return;
        }

        globalCurrentOffset = startOffset;
        currentCharIndex = startOffset;
        lastBoundaryIndex = startOffset;
        pausedAtIndex = startOffset;

        const textToSpeak = globalFullText.substring(startOffset);
        updateDebugOverlay(`Starting... (${Math.round((startOffset / globalFullText.length) * 100)}%)`);

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.rate = speechState.rate;
        utterance.volume = 1.0;
        utterance.pitch = 1.0;

        let selectedVoice = null;

        if (speechState.voiceURI) {
            selectedVoice = voices.find(v => v.voiceURI === speechState.voiceURI);
        }

        if (!selectedVoice) {
            const pageLang = getPageLanguage();
            const langCode = pageLang.split('-')[0].toLowerCase();

            selectedVoice = voices.find(v => v.lang.toLowerCase().startsWith(pageLang.toLowerCase()));

            if (!selectedVoice) {
                selectedVoice = voices.find(v => v.lang.toLowerCase().startsWith(langCode));
            }

            if (!selectedVoice) {
                selectedVoice = voices.find(v => v.lang.startsWith('en'));
            }

            if (!selectedVoice && voices.length > 0) {
                selectedVoice = voices[0];
            }
        }

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            console.log(`Using voice: ${selectedVoice.name} (${selectedVoice.lang}) for page language: ${getPageLanguage()}`);
        }

        currentUtterance = utterance;
        activeUtterances.add(utterance);

        utterance.onstart = () => {
            if (currentUtterance === utterance) {
                speechState.isSpeaking = true;
                speechState.isPaused = false;
                updateDebugOverlay(`Speaking...\n${textToSpeak.length} chars\n${markedRanges.length} marks`);
                broadcastState();
                console.log('✓ Speech started');

                // Start fallback highlighting for voices with poor boundary support
                startHighlightInterval();
            }
        };

        utterance.onend = () => {
            if (currentUtterance === utterance) {
                console.log('✓ Speech ended');
                speechState.isSpeaking = false;
                speechState.isPaused = false;
                stopHighlightInterval();
                clearHighlight();
                cleanupCurrentUtterance();
                updateDebugOverlay(`Finished\n${markedRanges.length} marks`);
                broadcastState();
            }
        };

        utterance.onerror = (e) => {
            if (isInternalStop || e.error === 'interrupted' || e.error === 'canceled') {
                activeUtterances.delete(utterance);
                return;
            }
            if (currentUtterance === utterance) {
                console.error('Speech error:', e.error);
                speechState.isSpeaking = false;
                speechState.isPaused = false;
                stopHighlightInterval();
                clearHighlight();
                cleanupCurrentUtterance();
                updateDebugOverlay(`Error: ${e.error}\n${markedRanges.length} marks`);
                broadcastState();
            }
        };

        utterance.onboundary = (event) => {
            if (currentUtterance !== utterance) return;

            // Update time tracking for boundary events
            lastBoundaryTime = Date.now();

            // Calculate absolute position in full text
            const absoluteIndex = globalCurrentOffset + event.charIndex;

            // Update all position tracking variables
            currentCharIndex = absoluteIndex;
            lastBoundaryIndex = absoluteIndex;
            pausedAtIndex = absoluteIndex;

            // Highlight on boundary events
            if (event.name === 'word') {
                highlightRange(absoluteIndex, event.charLength || 0);
            } else if (event.name === 'sentence') {
                highlightRange(absoluteIndex, 0);
            } else {
                highlightRange(absoluteIndex, 0);
            }
        };

        try {
            synthesis.speak(utterance);
            setTimeout(() => {
                if (currentUtterance === utterance && synthesis.pending && !synthesis.speaking) {
                    console.log('Chrome quirk: restarting speech');
                    synthesis.cancel();
                    synthesis.speak(utterance);
                }
            }, 100);
        } catch (err) {
            console.error('Synthesis error:', err);
            updateDebugOverlay(`Error: ${err.message}`);
            speechState.isSpeaking = false;
            speechState.isPaused = false;
            stopHighlightInterval();
            cleanupCurrentUtterance();
            broadcastState();
        }
    }

    window.addEventListener('beforeunload', () => stopSpeaking());

    console.log('✓ Page Voice initialized successfully');
}