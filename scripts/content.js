// Prevent multiple injections
if (window.pageVoiceInitialized) {
    console.log('Page Voice already initialized');
} else {
    window.pageVoiceInitialized = true;
    console.log('Page Voice content script loaded');

    var speechState = {
        isSpeaking: false,
        isPaused: false,
        rate: 1.0
    };

    var synthesis = window.speechSynthesis;
    var currentUtterance = null;
    var textMap = [];
    var activeUtterances = new Set();
    var isInternalStop = false;
    var extensionContextValid = true;
    var markedRanges = [];
    var currentCharIndex = 0;

    // Navigation Globals
    var globalFullText = '';
    var globalCurrentOffset = 0;

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
        // Extract text from an element, prioritizing visible content
        let text = '';
        const nodes = element.childNodes;

        for (let node of nodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                const content = node.textContent.trim();
                if (content) text += content + ' ';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();

                // Skip these entirely
                if (['script', 'style', 'noscript', 'iframe', 'svg', 'button'].includes(tag)) {
                    continue;
                }

                // Skip hidden elements
                if (!isVisible(node)) continue;

                // Recursively get text from child elements
                const childText = getReadableText(node);
                if (childText) {
                    text += childText + ' ';

                    // Add breaks after block elements
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

        // Try multiple strategies
        const strategies = [
            // Strategy 1: article tag
            () => {
                const article = document.querySelector('article');
                if (article && isVisible(article)) {
                    const text = getReadableText(article);
                    console.log(`Article found: ${text.length} chars`);
                    if (text.length > 100) return { element: article, strategy: 'article tag', chars: text.length };
                }
                return null;
            },

            // Strategy 2: main tag
            () => {
                const main = document.querySelector('main');
                if (main && isVisible(main)) {
                    const text = getReadableText(main);
                    console.log(`Main found: ${text.length} chars`);
                    if (text.length > 100) return { element: main, strategy: 'main tag', chars: text.length };
                }
                return null;
            },

            // Strategy 3: role="main"
            () => {
                const roleMain = document.querySelector('[role="main"]');
                if (roleMain && isVisible(roleMain)) {
                    const text = getReadableText(roleMain);
                    console.log(`Role=main found: ${text.length} chars`);
                    if (text.length > 100) return { element: roleMain, strategy: 'role=main', chars: text.length };
                }
                return null;
            },

            // Strategy 4: Largest content container by class
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

            // Strategy 5: Find element with most paragraph children
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

        // Try each strategy
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

        // Get all text nodes in the root
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

                    // Reject these tags
                    if (['script', 'style', 'noscript', 'iframe', 'svg'].includes(tag)) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Reject if in navigation/header/footer
                    if (parent.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Reject buttons and inputs
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

            // Add spacing between different block elements
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

    function highlightRange(charIndex, charLength) {
        CSS.highlights.delete('speech-word');
        currentCharIndex = charIndex;

        for (const item of textMap) {
            if (charIndex >= item.start && charIndex < item.end) {
                try {
                    const range = new Range();
                    const offsetStart = Math.max(0, charIndex - item.start);
                    const offsetEnd = Math.min(item.node.nodeValue.length, offsetStart + charLength);

                    if (offsetEnd > offsetStart) {
                        range.setStart(item.node, offsetStart);
                        range.setEnd(item.node, offsetEnd);

                        window.currentSpeechRange = range.cloneRange();
                        const highlight = new Highlight(range);
                        CSS.highlights.set('speech-word', highlight);

                        // Scroll into view
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

    function markCurrentLocation() {
        if (!window.currentSpeechRange) {
            console.warn('No active range to mark');
            updateDebugOverlay('⚠ No position to mark');
            setTimeout(() => {
                if (speechState.isSpeaking) {
                    updateDebugOverlay(`Speaking...\n${markedRanges.length} marks`);
                }
            }, 1500);
            return;
        }

        try {
            const clonedRange = window.currentSpeechRange.cloneRange();
            markedRanges.push(clonedRange);

            // Update highlight with all marked ranges
            const highlight = new Highlight(...markedRanges);
            CSS.highlights.set('speech-mark', highlight);

            console.log(`✓ Marked position ${currentCharIndex}, total: ${markedRanges.length}`);
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
                        // Restart keeping offset
                        startSpeaking(currentCharIndex);
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
        isInternalStop = false;

        // Rebuild map only if starting fresh or map missing
        if (startOffset === 0 || !globalFullText) {
            globalFullText = buildTextMap();
        }

        if (!globalFullText || globalFullText.length < 10) {
            const msg = 'Error: No readable text found!\nCheck console for details.';
            updateDebugOverlay(msg);
            speechState.isSpeaking = false;
            speechState.isPaused = false;
            broadcastState();
            return;
        }

        // Validation
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

        const textToSpeak = globalFullText.substring(startOffset);
        updateDebugOverlay(`Starting... (${Math.round((startOffset / globalFullText.length) * 100)}%)`);

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.rate = speechState.rate;
        utterance.volume = 1.0;
        utterance.pitch = 1.0;

        const enVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
        if (enVoice) {
            utterance.voice = enVoice;
            console.log(`Using voice: ${enVoice.name} (${enVoice.lang})`);
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
            }
        };

        utterance.onend = () => {
            if (currentUtterance === utterance) {
                console.log('✓ Speech ended');
                speechState.isSpeaking = false;
                speechState.isPaused = false;
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
                clearHighlight();
                cleanupCurrentUtterance();
                updateDebugOverlay(`Error: ${e.error}\n${markedRanges.length} marks`);
                broadcastState();
            }
        };

        utterance.onboundary = (event) => {
            if (currentUtterance === utterance && event.name === 'word') {
                // event.charIndex is relative to the SUBSTRING
                const absoluteIndex = globalCurrentOffset + event.charIndex;
                currentCharIndex = absoluteIndex;
                highlightRange(absoluteIndex, event.charLength || 5);
            }
        };

        try {
            synthesis.speak(utterance);
            // Chrome quirk workaround
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
            cleanupCurrentUtterance();
            broadcastState();
        }
    }

    function navigate(direction) {
        if (!globalFullText) {
            console.warn('No text loaded for navigation');
            return;
        }

        let newIndex = currentCharIndex;

        if (direction === 'next') {
            // Look ahead to find next sentence
            const lookAhead = 20;
            const searchStart = newIndex + lookAhead;

            if (searchStart >= globalFullText.length) {
                console.log('Already at end of content');
                updateDebugOverlay('End of content');
                return;
            }

            const remainingText = globalFullText.substring(searchStart);
            const match = remainingText.match(/[.!?]\s+/);

            if (match) {
                newIndex = searchStart + match.index + match[0].length;
            } else {
                // No punctuation found, jump by fixed amount
                newIndex = Math.min(searchStart + 100, globalFullText.length - 1);
            }

            console.log(`Navigate next: ${currentCharIndex} -> ${newIndex}`);
        }
        else if (direction === 'previous') {
            // Look back to find previous sentence
            const lookBack = 20;
            const searchEnd = Math.max(0, newIndex - lookBack);

            if (searchEnd === 0) {
                newIndex = 0;
                console.log('Navigate to start');
            } else {
                const previousText = globalFullText.substring(0, searchEnd);
                const matches = [...previousText.matchAll(/[.!?]\s+/g)];

                if (matches.length > 0) {
                    const lastMatch = matches[matches.length - 1];
                    newIndex = lastMatch.index + lastMatch[0].length;
                } else {
                    // No punctuation found, jump back by fixed amount
                    newIndex = Math.max(0, searchEnd - 100);
                }
            }

            console.log(`Navigate previous: ${currentCharIndex} -> ${newIndex}`);
        }

        // Clamp to valid range
        newIndex = Math.max(0, Math.min(newIndex, globalFullText.length - 1));

        // Restart speech from new position
        startSpeaking(newIndex);
    }

    function pauseSpeaking() {
        console.log('Attempting to pause');
        if (synthesis.speaking && !synthesis.paused) {
            synthesis.pause();
            speechState.isPaused = true;
            speechState.isSpeaking = true; // Still considered "speaking", just paused
            updateDebugOverlay(`Paused\n${markedRanges.length} marks`);
            broadcastState();
            console.log('✓ Paused');
        } else {
            console.log('Cannot pause - not speaking or already paused');
        }
    }

    function resumeSpeaking() {
        console.log('Attempting to resume');
        if (synthesis.paused) {
            synthesis.resume();
            speechState.isPaused = false;
            speechState.isSpeaking = true;
            updateDebugOverlay(`Speaking...\n${markedRanges.length} marks`);
            broadcastState();
            console.log('✓ Resumed');
        } else {
            console.log('Cannot resume - not paused');
        }
    }

    function stopSpeaking() {
        console.log('Stopping speech');
        isInternalStop = true;

        if (synthesis.speaking || synthesis.pending) {
            synthesis.cancel();
        }

        speechState.isSpeaking = false;
        speechState.isPaused = false;
        cleanupCurrentUtterance();
        activeUtterances.clear();
        clearHighlight();
        updateDebugOverlay(`Stopped\n${markedRanges.length} marks`);
        broadcastState();

        setTimeout(() => {
            isInternalStop = false;
        }, 100);

        console.log('✓ Stopped');
    }

    function broadcastState() {
        if (!extensionContextValid || !chrome.runtime?.id) return;
        chrome.runtime.sendMessage({
            action: 'stateUpdate',
            state: speechState
        }).catch(() => { });
    }

    window.addEventListener('beforeunload', () => stopSpeaking());

    console.log('✓ Page Voice initialized successfully');
}