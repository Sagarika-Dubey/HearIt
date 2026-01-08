# 🎧 HearIt — Listen to Web Pages, Effortlessly

**HearIt** is a Chrome extension that converts web page content into natural-sounding speech, making it easy to consume long articles, blogs, and documents by listening instead of reading.

Designed with accessibility, focus, and productivity in mind, HearIt lets users control playback, adjust speed, and choose voices — all directly from a clean, intuitive popup interface.

---

## ✨ Features

- 🔊 **Text-to-Speech for Web Pages**
- ⏯ **Play / Pause / Resume / Stop controls**
- ⏩ **Next & Previous navigation**
- 🎙 **Multiple voice selection**
- ⚡ **Adjustable playback speed**
- 🧠 **Automatic script injection on any page**
- 🎨 **Modern, minimal UI**
- 🔐 **Privacy-friendly (runs fully in-browser)**

---

## 🛠 Tech Stack

- **JavaScript (ES6+)**
- **Chrome Extensions API (Manifest V3)**
- **Web Speech API**
- **HTML5 & CSS3**
- **Google Fonts (Inter)**

---

## 📁 Project Structure
HearIt/

├── manifest.json

├── popup/

│ ├── popup.html

│ ├── popup.css

│ └── popup.js

├── scripts/

│ └── content.js

├── icons/

│ ├── icon16.png

│ ├── icon48.png

│ └── icon128.png

└── README.md

---

## 🔍 Folder Overview

- **manifest.json**  
  Chrome extension configuration (Manifest V3)

- **popup/**  
  Contains the UI and logic for the extension popup  
  - `popup.html` — Popup layout  
  - `popup.css` — Styling  
  - `popup.js` — Playback & control logic  

- **scripts/**  
  - `content.js` — Extracts page content and handles text-to-speech  

- **icons/**  
  Extension icons used in the toolbar and Chrome Web Store

---

## 🚀 How It Works

1. The extension injects a content script into the active tab
2. Page text is extracted dynamically
3. Speech synthesis converts text into voice
4. Playback state is synchronized with the popup UI
5. Users can control voice, speed, and navigation in real time

All processing happens **locally in the browser**.

---

## 🧪 Installation (Local Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/Sagarika-Dubey/HearIt.git
   ```
2. Open Chrome and go to:
   ```bash
   chrome://extensions
   ```
3. Enable Developer Mode
4. Click Load unpacked
5. Select the HearIt project folder

✅ The extension is now ready to use.  

---

## 🖥 Usage

1. Open any article, blog, or document
2. Click the HearIt icon in the toolbar
3. Press Play to start listening
4. Adjust speed or voice as needed
5. Pause, resume, or stop anytime

---

## 🔐 Privacy Policy

HearIt does **not collect, store, or transmit** any personal or browsing data.

- No analytics  
- No tracking  
- No external servers  
- All speech processing happens locally via the browser  

---

## 🌱 Future Enhancements

- Smart content filtering (ignore navigation and footer content)
- Keyboard shortcuts for quick control
- Highlight text while reading
- Save bookmarks and listening progress
- Automatic language detection
- Dark mode support

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repository  
2. Create a new feature branch  
3. Commit your changes  
4. Open a pull request  

---

## ⭐ If you like this project

Give it a ⭐ on GitHub — it really helps!
