import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export interface DocumentReadProgress {
    message: string
    progress?: number
}

export interface BrokerDocumentReadOptions {
    pdfPassword?: string
}

type ProgressCallback = (progress: DocumentReadProgress) => void

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('無法轉換 PDF 頁面')), 'image/png')
    })
}

async function recognizeImages(images: Array<{ blob: Blob; label: string }>, onProgress: ProgressCallback): Promise<string[]> {
    if (images.length === 0) return []
    const { createWorker } = await import('tesseract.js')
    onProgress({ message: '載入 OCR 模型，首次使用可能較久', progress: 0 })
    const worker = await createWorker('chi_tra+eng', undefined, {
        logger: event => {
            if (typeof event.progress === 'number') {
                onProgress({ message: event.status === 'loading language traineddata' ? '載入 OCR 模型，首次使用可能較久' : 'OCR 辨識中', progress: event.progress })
            }
        },
    })
    try {
        const texts: string[] = []
        for (let index = 0; index < images.length; index += 1) {
            const image = images[index]
            onProgress({ message: `正在辨識 ${image.label}（${index + 1}/${images.length}）`, progress: index / images.length })
            const result = await worker.recognize(image.blob)
            texts.push(result.data.text)
        }
        return texts
    } finally {
        await worker.terminate()
    }
}

async function readPdf(file: File, onProgress: ProgressCallback, password?: string): Promise<string> {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    let pdfDocument
    try {
        pdfDocument = await pdfjs.getDocument({
            data: await file.arrayBuffer(),
            ...(password ? { password } : {}),
        }).promise
    } catch (reason) {
        const passwordError = reason as { name?: string; code?: number }
        if (passwordError.name === 'PasswordException') {
            if (passwordError.code === pdfjs.PasswordResponses.NEED_PASSWORD) {
                throw new Error('這份 PDF 需要密碼，請輸入對帳單密碼後再試一次。')
            }
            throw new Error('PDF 密碼錯誤，請確認後重新輸入。')
        }
        throw reason
    }
    const sections: string[] = []
    const scannedPages: Array<{ blob: Blob; label: string }> = []

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        onProgress({ message: `讀取 PDF 第 ${pageNumber}/${pdfDocument.numPages} 頁`, progress: pageNumber / pdfDocument.numPages })
        const page = await pdfDocument.getPage(pageNumber)
        const content = await page.getTextContent()
        const pageText = content.items
            .map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
            .join('')
            .trim()
        if (pageText.replace(/\s/g, '').length >= 20) {
            sections.push(`--- ${file.name} 第 ${pageNumber} 頁 ---\n${pageText}`)
            continue
        }

        const viewport = page.getViewport({ scale: 2 })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('無法建立 PDF 畫布')
        await page.render({ canvas, canvasContext: context, viewport }).promise
        scannedPages.push({ blob: await canvasToBlob(canvas), label: `${file.name} 第 ${pageNumber} 頁` })
    }

    const ocrTexts = await recognizeImages(scannedPages, onProgress)
    sections.push(...ocrTexts.map((text, index) => `--- ${scannedPages[index].label} ---\n${text}`))
    return sections.join('\n')
}

/** Images and scanned PDF pages are OCRed locally; the files themselves are never uploaded. */
export async function readBrokerDocuments(
    files: File[],
    onProgress: ProgressCallback,
    options: BrokerDocumentReadOptions = {},
): Promise<string> {
    const sections: string[] = []
    const images: Array<{ blob: Blob; label: string }> = []
    for (const file of files) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            sections.push(await readPdf(file, onProgress, options.pdfPassword))
        } else if (file.type.startsWith('image/')) {
            images.push({ blob: file, label: file.name })
        } else {
            throw new Error(`不支援的檔案格式：${file.name}`)
        }
    }
    const imageTexts = await recognizeImages(images, onProgress)
    sections.push(...imageTexts.map((text, index) => `--- ${images[index].label} ---\n${text}`))
    onProgress({ message: '辨識完成', progress: 1 })
    return sections.filter(Boolean).join('\n\n')
}
