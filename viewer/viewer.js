
// viewer.js
pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';

const urlParams = new URLSearchParams(window.location.search);
const fileUrl = urlParams.get('file');

const container = document.getElementById('viewer');
const pageNumSpan = document.getElementById('page-num');
const pageCountSpan = document.getElementById('page-count');
const errorContainer = document.getElementById('error-message');

let pdfDoc = null;

async function loadPDF() {
    if (!fileUrl) {
        showError('No PDF file specified.');
        return;
    }

    try {
        console.log('Loading PDF:', fileUrl);
        const loadingTask = pdfjsLib.getDocument(fileUrl);
        pdfDoc = await loadingTask.promise;

        pageCountSpan.textContent = pdfDoc.numPages;
        console.log('PDF loaded, pages:', pdfDoc.numPages);

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            await renderPage(pageNum);
        }

        // Notify content script that we are ready
        window.postMessage({ type: 'PDF_VIEWER_READY', pages: pdfDoc.numPages }, '*');

    } catch (error) {
        console.error('Error loading PDF:', error);
        showError('Error loading PDF: ' + error.message);
    }
}

async function renderPage(pageNum) {
    const page = await pdfDoc.getPage(pageNum);

    // Scale: 1.5 is a reasonable default for reading
    const scale = 1.5;
    const viewport = page.getViewport({ scale });

    // Create page wrapper
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    pageDiv.style.width = Math.floor(viewport.width) + 'px';
    pageDiv.style.height = Math.floor(viewport.height) + 'px';
    pageDiv.dataset.pageNumber = pageNum;

    // Canvas for rendering content
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = Math.floor(viewport.height);
    canvas.width = Math.floor(viewport.width);

    // Text Layer Div
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
    textLayerDiv.style.height = Math.floor(viewport.height) + 'px';

    pageDiv.appendChild(canvas);
    pageDiv.appendChild(textLayerDiv);
    container.appendChild(pageDiv);

    // Render PDF to canvas
    const renderContext = {
        canvasContext: context,
        viewport: viewport
    };

    try {
        await page.render(renderContext).promise;

        // Render text layer
        const textContent = await page.getTextContent();
        pdfjsLib.renderTextLayer({
            textContent: textContent,
            container: textLayerDiv,
            viewport: viewport,
            textDivs: []
        });

    } catch (e) {
        console.warn('Page render error:', e);
    }
}

function showError(msg) {
    errorContainer.textContent = msg;
    errorContainer.style.display = 'block';
}

// Initial load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPDF);
} else {
    loadPDF();
}
