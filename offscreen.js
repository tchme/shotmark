import { recognize } from './ocr.js'
import { cropBitmap } from './drawing.js'

let queue = Promise.resolve()

async function readImage({ data, region }) {
  const source = await createImageBitmap(await (await fetch(data)).blob())
  let image = source
  try {
    if (region) image = await cropBitmap(source, region)
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d', { alpha: false })
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
    const { text, blocks } = await recognize(canvas)
    return { text, blocks, width: canvas.width, height: canvas.height }
  } finally {
    if (image !== source) image.close()
    source.close()
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'kadr:read-picture' || sender.tab || sender.id !== chrome.runtime.id ||
      typeof message.data !== 'string' || !message.data.startsWith('data:image/')) return false
  queue = queue.then(() => readImage(message)).then(reply, error => {
    console.error(error)
    reply(null)
  })
  return true
})
