const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const markBtn = document.getElementById('markBtn');

// Navigation Buttons
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

const rateInput = document.getElementById('rate');
const rateValue = document.getElementById('rateValue');
const statusDiv = document.getElementById('status');


let currentTabId;

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
        // Ask for current state
        sendMessage('getState');
    } else {
        debug('Error: No active tab');
    }
});

// Event Listeners
playBtn.addEventListener('click', () => sendMessage('play'));
pauseBtn.addEventListener('click', () => sendMessage('pause'));
resumeBtn.addEventListener('click', () => sendMessage('resume'));
stopBtn.addEventListener('click', () => sendMessage('stop'));

rateInput.addEventListener('input', (e) => {
    const val = e.target.value;
    rateValue.textContent = val;
    sendMessage('setRate', { rate: parseFloat(val) });
});

function sendMessage(action, data = {}) {
    debug('Sending: ' + action);
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('Msg failed, attempting injection...', chrome.runtime.lastError);
            debug('Injecting script...');

            // ActiveTab or Scripting permission fallback
            chrome.scripting.executeScript({
                target: { tabId: currentTabId },
                files: ['scripts/content.js']
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Injection failed:', chrome.runtime.lastError);
                    debug('Err: ' + chrome.runtime.lastError.message.slice(0, 20));
                } else {
                    // Retry message after injection
                    debug('Injected. Retrying...');
                    setTimeout(() => {
                        chrome.tabs.sendMessage(currentTabId, { action, ...data }, (res) => {
                            if (res) updateUI(res);
                            else debug('Retry failed.');
                        });
                    }, 500); // Increased delay for stability
                }
            });
            return;
        }
        if (response) {
            updateUI(response);
        }
    });
}

function updateUI(state) {
    if (!state) return;

    rateInput.value = state.rate;
    rateValue.textContent = state.rate;

    // Reset buttons
    playBtn.style.display = 'flex';
    resumeBtn.style.display = 'none';

    playBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;

    if (state.isSpeaking) {
        debug('Speaking...');
        playBtn.disabled = true;
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
    } else if (state.isPaused) {
        debug('Paused');
        playBtn.style.display = 'none';
        resumeBtn.style.display = 'flex';
        resumeBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = false;
        const markBtn = document.getElementById('markBtn');

        // ...

        // Event Listeners
        playBtn.addEventListener('click', () => sendMessage('play'));
        pauseBtn.addEventListener('click', () => sendMessage('pause'));
        resumeBtn.addEventListener('click', () => sendMessage('resume'));
        stopBtn.addEventListener('click', () => sendMessage('stop'));
        markBtn.addEventListener('click', () => sendMessage('mark'));

        // ...

        function updateUI(state) {
            if (!state) return;

            rateInput.value = state.rate;
            rateValue.textContent = state.rate;

            // Reset buttons
            playBtn.style.display = 'flex';
            resumeBtn.style.display = 'none';

            playBtn.disabled = false;
            pauseBtn.disabled = true;
            stopBtn.disabled = true;
            if (markBtn) markBtn.disabled = true;
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;

            if (state.isSpeaking) {
                debug('Speaking...');
                playBtn.disabled = true;
                pauseBtn.disabled = false;
                stopBtn.disabled = false;
                if (markBtn) markBtn.disabled = false;
                if (prevBtn) prevBtn.disabled = false;
                if (nextBtn) nextBtn.disabled = false;
            } else if (state.isPaused) {
                debug('Paused');
                playBtn.style.display = 'none';
                resumeBtn.style.display = 'flex';
                resumeBtn.disabled = false;
                pauseBtn.disabled = true;
                stopBtn.disabled = false;
                if (markBtn) markBtn.disabled = false;
                if (prevBtn) prevBtn.disabled = false;
                if (nextBtn) nextBtn.disabled = false;
            } else {
                debug('Ready');
            }
        }

        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === 'stateUpdate') {
                updateUI(message.state);
            }
        });
    }
};
