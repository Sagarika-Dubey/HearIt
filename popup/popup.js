const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const markBtn = document.getElementById('markBtn');
const openViewerBtn = document.getElementById('openViewerBtn');

// Navigation Buttons
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

const voiceSelect = document.getElementById('voiceSelect');
const rateInput = document.getElementById('rate');
const rateValue = document.getElementById('rateValue');
const statusDiv = document.getElementById('status');


let currentTabId;

// Populate voices
function populateVoiceList() {
    if (!voiceSelect) return;

    // Clear existing (except default)
    while (voiceSelect.options.length > 1) {
        voiceSelect.remove(1);
    }

    const voices = speechSynthesis.getVoices();
    voices.forEach((voice) => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang})`;
        option.value = voice.voiceURI;
        voiceSelect.appendChild(option);
    });
}

populateVoiceList();
if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
}

// Helper to show debug info in the UI directly
function debug(msg) {
    console.log(msg);
    // We append if it's an error, or just replace for status updates
    if (msg.startsWith('Error')) {
        statusDiv.textContent = msg;
        statusDiv.style.color = 'red';
    } else if (msg.startsWith('Sending')) {
        // Optional: show transient status
        statusDiv.textContent = msg;
        statusDiv.style.color = 'blue';
    } else {
        statusDiv.textContent = msg;
        statusDiv.style.color = '#6b7280';
    }
}

// Initialize
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
        currentTabId = tabs[0].id;
        const url = tabs[0].url || '';

        // PDF Detection (exclude the viewer itself)
        const isViewer = url.includes('/viewer/viewer.html');
        if (!isViewer && (url.toLowerCase().endsWith('.pdf') || (url.startsWith('file:') && url.endsWith('.pdf')))) {
            // It is likely a PDF
            if (openViewerBtn) {
                openViewerBtn.style.display = 'flex';
                openViewerBtn.onclick = () => {
                    const viewerUrl = chrome.runtime.getURL('viewer/viewer.html') + '?file=' + encodeURIComponent(url);
                    chrome.tabs.create({ url: viewerUrl });
                };
            }
            // Hide standard controls since they won't work on the raw PDF
            // Hide standard controls since they won't work on the raw PDF
            const playerCard = document.querySelector('.player-card');
            if (playerCard) playerCard.style.display = 'none';
            const settings = document.querySelector('.settings');
            if (settings) settings.style.display = 'none';
            statusDiv.textContent = 'PDF detected. Open in Reader to listen.';

            // Disable others
            playBtn.style.display = 'none';
        } else {
            // Normal page
            if (openViewerBtn) openViewerBtn.style.display = 'none';
            // Ask for current state
            sendMessage('getState');
        }
    } else {
        debug('Error: No active tab');
    }
});

// Event Listeners
playBtn.addEventListener('click', () => sendMessage('play'));
pauseBtn.addEventListener('click', () => sendMessage('pause'));
resumeBtn.addEventListener('click', () => sendMessage('resume'));
stopBtn.addEventListener('click', () => sendMessage('stop'));

if (markBtn) markBtn.addEventListener('click', () => sendMessage('mark'));
if (prevBtn) prevBtn.addEventListener('click', () => sendMessage('previous'));
if (nextBtn) nextBtn.addEventListener('click', () => sendMessage('next'));

rateInput.addEventListener('input', (e) => {
    const val = e.target.value;
    rateValue.textContent = val;
    sendMessage('setRate', { rate: parseFloat(val) });
});

if (voiceSelect) {
    voiceSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        sendMessage('setVoice', { voiceURI: val });
    });
}

function sendMessage(action, data = {}) {
    debug('Sending: ' + action);
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, { action, ...data }, (response) => {
        // ERROR HANDLING: If message fails (content script not ready/loaded)
        if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message;
            //console.warn('Msg failed:', err);

            // Only try injecting if it looks like the script is missing
            if (err.includes('Receiving end does not exist') || err.includes('Could not establish connection')) {
                debug('Injecting script...');

                // Helper to retry the original message
                const retryMessage = () => {
                    debug('Retrying...');
                    setTimeout(() => {
                        chrome.tabs.sendMessage(currentTabId, { action, ...data }, (res) => {
                            if (chrome.runtime.lastError) {
                                console.warn('Retry failed:', chrome.runtime.lastError.message);
                                debug('Err: Connection failed. Reload page?');
                            } else if (res) {
                                updateUI(res);
                            }
                        });
                    }, 1000); // 1s wait
                };

                // Listen for ready signal from new content script
                const readyListener = (msg, sender) => {
                    if (msg.action === 'contentScriptReady' && sender.tab.id === currentTabId) {
                        chrome.runtime.onMessage.removeListener(readyListener);
                        retryMessage();
                    }
                };
                chrome.runtime.onMessage.addListener(readyListener);

                // Inject
                chrome.scripting.executeScript({
                    target: { tabId: currentTabId },
                    files: ['scripts/content.js']
                }, () => {
                    if (chrome.runtime.lastError) {
                        chrome.runtime.onMessage.removeListener(readyListener);
                        //console.error('Injection failed:', chrome.runtime.lastError.message);
                        debug('Err: Injection failed');
                    } else {
                        // If we don't hear back quickly, try anyway
                        setTimeout(() => {
                            chrome.runtime.onMessage.removeListener(readyListener);
                            retryMessage();
                        }, 2000); // wait up to 2s for explicit ready signal, else brute force
                    }
                });
            } else {
                // Other errors (e.g., page closed)
                debug('Err: ' + (err || 'Unknown').slice(0, 20));
            }
            return;
        }

        // SUCCESS
        if (response) {
            updateUI(response);
        }
    });
}

function updateUI(state) {
    if (!state) return;

    // Ensure state is valid
    if (!state.rate) state.rate = 1.0;

    rateInput.value = state.rate;
    rateValue.textContent = state.rate;

    // Update voice select if state has it
    if (state.voiceURI && voiceSelect) {
        voiceSelect.value = state.voiceURI;
    }

    // Reset all main action buttons first
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'none';

    // Enable all by default, we'll disable specific ones
    playBtn.disabled = false;
    pauseBtn.disabled = false;
    resumeBtn.disabled = false;
    stopBtn.disabled = true;
    if (markBtn) markBtn.disabled = true;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;

    if (state.isPaused) {
        debug('Paused');
        resumeBtn.style.display = 'flex'; // Show Resume
        stopBtn.disabled = false;
        if (markBtn) markBtn.disabled = false;
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
    } else if (state.isSpeaking) {
        debug('Speaking...');
        pauseBtn.style.display = 'flex'; // Show Pause
        stopBtn.disabled = false;
        if (markBtn) markBtn.disabled = false;
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
    } else {
        debug('Ready');
        playBtn.style.display = 'flex'; // Show Play
    }
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'stateUpdate') {
        updateUI(message.state);
    }
});
