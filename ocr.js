let worker
let reportProgress

async function openWorker() {
  const { createWorker } = globalThis.Tesseract
  const root = chrome.runtime.getURL('ocr/')
  return new Promise((resolve, reject) => {
    createWorker(['rus', 'eng'], 1, {
      workerPath: `${root}worker.min.js`,
      corePath: root,
      langPath: root.replace(/\/$/, ''),
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: update => {
        if (update.status === 'recognizing text') reportProgress?.(update.progress)
      },
      errorHandler: reject
    }).then(resolve, reject)
  })
}

export async function recognize(canvas, onProgress) {
  reportProgress = onProgress
  try {
    worker ??= await openWorker()
    const { data } = await worker.recognize(canvas, {}, { blocks: true })
    return data
  } catch (error) {
    await worker?.terminate()
    worker = null
    throw error
  } finally {
    reportProgress = null
  }
}
