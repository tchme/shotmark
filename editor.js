import { takeSnapshot } from './snapshots.js'
import { cropBitmap, draw, labelMetrics, rectangle } from './drawing.js'
import { recognize } from './ocr.js'
import { DiskError, diskHome, notifyDisk, openDiskLogin, sendToDisk } from './disk.js'

const $ = id => document.getElementById(id)
const canvas = $('result')
const preview = $('preview')
const context = canvas.getContext('2d', { alpha: false })
const previewContext = preview.getContext('2d')
const surface = $('surface')
const viewport = $('viewport')
const layer = $('ocr-layer')
const recognizedText = $('recognized-text')
const labelInput = $('label-input')
const toolButtons = [...$('tools').querySelectorAll('[data-tool]')]
const exportButtons = [$('copy-image'), $('save-image'), $('save-disk')]
const visualStyles = {
  arrow: [
    ['tapered', 'Расширяющаяся стрелка'], ['solid', 'Сплошная стрелка'], ['open', 'Открытая стрелка'],
    ['dashed', 'Пунктирная стрелка'], ['double', 'Двусторонняя стрелка'], ['curved', 'Изогнутая стрелка']
  ],
  shape: [
    ['rectangle', 'Прямоугольник'], ['ellipse', 'Эллипс'], ['rounded', 'Скруглённый прямоугольник'],
    ['triangle', 'Треугольник'], ['diamond', 'Ромб'], ['hexagon', 'Шестиугольник'], ['star', 'Звезда']
  ]
}
const hideStyles = [['pixelate', 'Мозаика'], ['blur', 'Мягкое размытие'], ['solid', 'Сплошная замазка']]
const hints = {
  arrow: 'Протяните от начала к кончику стрелки', text: 'Выделите рамку для текста или нажмите на снимок',
  shape: 'Протяните рамку', pen: 'Проведите по снимку', hide: 'Выделите область на снимке',
  crop: 'Выделите фрагмент, который хотите оставить'
}
const chosenStyle = {}
const edits = []
let cursor = 0
let revision = 0
let tool = 'arrow'
let color = '#ef4955'
let original
let drag
let pendingLabel
let zoom = null
let ocrResult
let ocrBusy = false
let ocrMode = false
let filename
let exporting = false
let diskJob
let diskNotice

for (const [family, styles] of Object.entries(visualStyles)) {
  for (const [style, name] of styles) {
    const button = document.createElement('button')
    const icon = document.createElement('canvas')
    button.title = name
    button.setAttribute('aria-label', name)
    button.dataset.style = style
    button.dataset.family = family
    button.append(icon)
    icon.width = 62
    icon.height = 40
    icon.setAttribute('aria-hidden', 'true')
    draw(icon.getContext('2d'), {
      tool: family, style, color: '#cddfeb', size: 3,
      from: family === 'shape' ? { x: 12, y: 8 } : { x: 7, y: style === 'curved' ? 31 : 25 },
      to: family === 'shape' ? { x: 50, y: 32 } : { x: 54, y: style === 'curved' ? 24 : 15 }
    })
    button.addEventListener('click', () => {
      chosenStyle[family] = style
      updateOptions()
    })
    $('visual-styles').append(button)
  }
}

function status(message = '', isError = false) {
  $('status').textContent = message
  $('status').toggleAttribute('data-error', isError)
}

function setTool(value) {
  finishLabel()
  setOcrMode(false)
  tool = value
  preview.dataset.tool = value
  for (const button of toolButtons) button.setAttribute('aria-pressed', button.dataset.tool === value)
  updateOptions()
}

function selectedStyle() {
  return chosenStyle[tool] ?? visualStyles[tool]?.[0][0] ?? (tool === 'hide' ? hideStyles[0][0] : undefined)
}

function updateOptions() {
  const styleSelect = $('style-select')
  const style = selectedStyle()
  styleSelect.closest('label').hidden = tool !== 'hide'
  if (tool === 'hide') {
    styleSelect.replaceChildren(...hideStyles.map(([value, label]) => new Option(label, value)))
    styleSelect.value = style
  }
  $('visual-styles').hidden = !visualStyles[tool]
  if (visualStyles[tool]) $('visual-styles').setAttribute('aria-label', tool === 'arrow' ? 'Стиль стрелки' : 'Форма')
  for (const button of $('visual-styles').children) {
    button.hidden = button.dataset.family !== tool
    button.setAttribute('aria-pressed', !button.hidden && button.dataset.style === style)
  }
  $('palette').hidden = tool === 'crop' || tool === 'hide'
  $('weight-label').hidden = tool === 'crop' || (tool === 'hide' && style === 'solid')
  const mosaic = tool === 'hide' && style === 'pixelate'
  $('weight-caption').textContent = mosaic ? 'Размер блоков' : 'Толщина'
  const levels = mosaic ? ['Мелкие', 'Средние', 'Крупные'] : ['Тонкая', 'Средняя', 'Толстая']
  for (const [index, option] of [...$('weight').options].entries()) option.textContent = levels[index]
  $('hint').textContent = pendingLabel ? 'Ctrl+Enter — готово · Esc — отмена' : hints[tool]
}

function updateSize() {
  if (!original) return
  const padding = getComputedStyle(viewport)
  const width = Math.max(1, viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight))
  const height = Math.max(1, viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom))
  const scale = zoom ?? Math.min(1, width / canvas.width, height / canvas.height)
  surface.style.width = `${canvas.width * scale}px`
  surface.style.height = `${canvas.height * scale}px`
  $('zoom-fit').textContent = `${Math.max(1, Math.round(scale * 100))}%`
  resizeLabel()
}

function render() {
  revision++
  canvas.width = original.width
  canvas.height = original.height
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(original, 0, 0)
  for (let index = 0; index < cursor; index++) draw(context, edits[index])
  preview.width = canvas.width
  preview.height = canvas.height
  $('resolution').textContent = `${canvas.width} × ${canvas.height} px`
  $('undo').disabled = !cursor
  $('redo').disabled = cursor === edits.length
  ocrResult = null
  setOcrMode(false)
  if (!ocrBusy) status()
  updateSize()
}

function commit(operation) {
  edits.splice(cursor, edits.length - cursor, operation)
  cursor++
  render()
}

function moveHistory(direction) {
  finishLabel()
  if (drag || !original || cursor + direction < 0 || cursor + direction > edits.length) return
  cursor += direction
  render()
}

function point(event) {
  const bounds = preview.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(canvas.width, Math.round((event.clientX - bounds.left) * canvas.width / bounds.width))),
    y: Math.max(0, Math.min(canvas.height, Math.round((event.clientY - bounds.top) * canvas.height / bounds.height)))
  }
}

preview.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag || ocrBusy) return
  finishLabel()
  const start = point(event)
  const style = selectedStyle()
  const operation = { tool, from: start, to: start, color, size: Number($('weight').value), style }
  preview.setPointerCapture(event.pointerId)
  drag = { ...operation, points: [start], pointer: event.pointerId }
})

function updateDrag(event) {
  drag.to = point(event)
  const last = drag.points.at(-1)
  if (drag.tool === 'pen' && (last.x !== drag.to.x || last.y !== drag.to.y)) drag.points.push(drag.to)
}

preview.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return
  updateDrag(event)
  previewContext.clearRect(0, 0, preview.width, preview.height)
  draw(previewContext, drag, true)
})

preview.addEventListener('pointerup', event => {
  if (drag?.pointer !== event.pointerId) return
  updateDrag(event)
  const operation = drag
  cancelDrag()
  if (operation.tool === 'text') return startLabel(operation)
  const { w, h } = rectangle(operation.from, operation.to)
  if (operation.tool === 'pen' || (operation.tool === 'arrow' ? Math.hypot(w, h) >= 3 : w >= 2 && h >= 2)) commit(operation)
})

function cancelDrag() {
  drag = null
  previewContext.clearRect(0, 0, preview.width, preview.height)
}
preview.addEventListener('lostpointercapture', cancelDrag)

function startLabel(operation) {
  const area = rectangle(operation.from, operation.to)
  const { font, lineHeight, outline } = labelMetrics(operation.size, operation.color)
  const minWidth = Math.min(72, canvas.width)
  const x = Math.min(area.x, canvas.width - minWidth)
  const y = Math.min(area.y, Math.max(0, canvas.height - lineHeight - 2))
  const width = Math.min(canvas.width - x, area.w >= 8 ? Math.max(minWidth, area.w) : 420)
  pendingLabel = { ...operation, from: { x, y }, width, height: Math.max(lineHeight + 2, area.h) }
  Object.assign(labelInput.style, {
    font, lineHeight: `${lineHeight}px`, color: operation.color, width: `${width}px`, webkitTextStroke: `.55px ${outline}`
  })
  labelInput.value = ''
  labelInput.hidden = false
  resizeLabel()
  updateOptions()
  labelInput.focus({ preventScroll: true })
}

function resizeLabel() {
  if (!pendingLabel) return
  const { from: { x, y }, height } = pendingLabel
  const scale = parseFloat(surface.style.width) / canvas.width
  labelInput.style.left = `${x * scale}px`
  labelInput.style.top = `${y * scale}px`
  labelInput.style.transform = `scale(${scale})`
  const available = canvas.height - y
  labelInput.style.height = `${Math.min(available, height)}px`
  labelInput.style.height = `${Math.min(available, labelInput.scrollHeight)}px`
}

function finishLabel(cancel = false) {
  if (!pendingLabel) return
  const operation = pendingLabel
  const text = labelInput.value.trimEnd()
  pendingLabel = null
  labelInput.hidden = true
  if (!cancel && text) commit({ ...operation, text })
  updateOptions()
}

labelInput.addEventListener('input', resizeLabel)
labelInput.addEventListener('blur', () => finishLabel())
labelInput.addEventListener('keydown', event => {
  if (event.isComposing || (event.key !== 'Escape' && !(event.key === 'Enter' && (event.ctrlKey || event.metaKey)))) return
  event.preventDefault()
  event.stopPropagation()
  finishLabel(event.key === 'Escape')
  toolButtons.find(button => button.dataset.tool === 'text').focus({ preventScroll: true })
})

function setOcrMode(enabled) {
  if (ocrMode && !enabled) window.getSelection().removeAllRanges()
  ocrMode = enabled
  $('ocr-tools').hidden = !enabled
  $('options').hidden = enabled
  layer.hidden = !enabled
  $('recognize').setAttribute('aria-pressed', enabled)
  if (!enabled) {
    layer.replaceChildren()
    if (!drag) previewContext.clearRect(0, 0, preview.width, preview.height)
    $('text-panel').hidden = true
    $('text-panel-toggle').setAttribute('aria-expanded', false)
    recognizedText.value = ''
  } else {
    globalThis.kadrShowWords(layer, ocrResult.blocks, previewContext)
    recognizedText.value = ocrResult.copyText ?? ocrResult.text.trim()
  }
}

async function recognizeText() {
  if (!original || ocrBusy || drag) return
  finishLabel()
  if (ocrMode) return setOcrMode(false)
  if (ocrResult) return setOcrMode(true)
  const snapshotRevision = revision
  ocrBusy = true
  $('recognize').disabled = true
  status('Распознаём текст…')
  try {
    const result = await recognize(canvas, progress => status(`Распознаём текст… ${Math.round(progress * 100)}%`))
    if (snapshotRevision !== revision) return status('Снимок изменился. Запустите распознавание снова.')
    if (!result.text.trim()) return status('На снимке не найден текст.')
    ocrResult = result
    setOcrMode(true)
    status('Текст распознан')
  } catch (error) {
    console.error(error)
    status('Не удалось распознать текст. Попробуйте ещё раз.', true)
  } finally {
    ocrBusy = false
    $('recognize').disabled = false
  }
}
$('recognize').addEventListener('click', recognizeText)
recognizedText.addEventListener('input', () => { ocrResult.copyText = recognizedText.value })

$('exit-ocr').addEventListener('click', () => { setOcrMode(false); status(); $('recognize').focus() })
$('text-panel-toggle').addEventListener('click', () => {
  const open = $('text-panel').hidden
  $('text-panel').hidden = !open
  $('text-panel-toggle').setAttribute('aria-expanded', open)
  if (open) recognizedText.focus()
})

async function copy(write, onSuccess) {
  try {
    await write()
    onSuccess()
  } catch (error) {
    console.error(error)
    status('Не удалось скопировать. Попробуйте ещё раз.', true)
  }
}

$('copy-text').addEventListener('click', () => copy(() => navigator.clipboard.writeText(recognizedText.value), () => status('Текст скопирован')))
document.addEventListener('copy', event => {
  const selection = window.getSelection()
  if (!ocrMode || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return
  const text = selection.toString().trim()
  if (!text) return
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
  status('Выделенный текст скопирован')
})

function png() {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('Could not encode PNG'))
  }, 'image/png'))
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    function fail(error) {
      chrome.downloads.onChanged.removeListener(changed)
      reject(error)
    }
    function check(state) {
      if (state === 'interrupted' || !state) fail(new Error('Download cancelled or interrupted'))
      else if (state === 'complete') {
        chrome.downloads.onChanged.removeListener(changed)
        resolve()
      }
    }
    function changed(delta) {
      if (delta.id === id && delta.state) check(delta.state.current)
    }
    chrome.downloads.onChanged.addListener(changed)
    chrome.downloads.search({ id }).then(([download]) => check(download?.state), fail)
  })
}

async function savePng() {
  const url = URL.createObjectURL(await png())
  try {
    const id = await chrome.downloads.download({ url, filename })
    await waitForDownload(id)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function exportImage(write, progress, errorMessage, closeOnSuccess = true) {
  if (!original || drag || exporting) return
  finishLabel()
  exporting = true
  const panels = document.querySelectorAll('header, main, .view-info')
  for (const panel of panels) panel.inert = true
  for (const button of exportButtons) button.disabled = true
  status(progress)
  try {
    await write()
    if (closeOnSuccess) window.close()
  } catch (error) {
    console.error(error)
    status(error instanceof DiskError ? error.message : errorMessage, true)
  } finally {
    exporting = false
    for (const panel of panels) panel.inert = false
    for (const button of exportButtons) button.disabled = false
  }
}

async function copyPng() {
  const clipboard = navigator.clipboard
  const items = [new ClipboardItem({ 'image/png': png() })]
  if (!('onclipboardchange' in clipboard)) {
    // shortcut: older Chromium cannot confirm a write, retry once while the editor still has focus.
    await clipboard.write(items)
    await new Promise(resolve => setTimeout(resolve, 120))
    if (document.hasFocus()) await clipboard.write(items)
    return
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let confirm
    const changed = new Promise(resolve => { confirm = resolve })
    const onChange = event => {
      if (event.types?.includes('image/png')) confirm(true)
    }
    let timeout
    clipboard.addEventListener('clipboardchange', onChange)
    try {
      await clipboard.write(items)
      const expired = new Promise(resolve => { timeout = setTimeout(() => resolve(false), 400) })
      if (await Promise.race([changed, expired])) return
    } finally {
      clearTimeout(timeout)
      clipboard.removeEventListener('clipboardchange', onChange)
    }
    if (!document.hasFocus()) break
  }
  throw new Error('Clipboard did not report a PNG write')
}
$('copy-image').addEventListener('click', () => exportImage(copyPng, 'Копируем снимок…', 'Не удалось скопировать снимок. Попробуйте ещё раз.'))
$('save-image').addEventListener('click', () => exportImage(savePng, 'Сохраняем PNG…', 'PNG не сохранён. Попробуйте ещё раз.'))

async function exportToDisk() {
  $('disk-notice').hidden = true
  if (diskJob?.revision !== revision) {
    if (diskJob?.tabId !== undefined) await chrome.tabs.remove(diskJob.tabId).catch(() => {})
    const name = filename.replace(/\.png$/, `-${crypto.randomUUID().slice(0, 8)}.png`)
    diskJob = { revision, name }
  }
  diskNotice = diskJob.url ? { url: diskJob.url } : await sendToDisk(diskJob, diskJob.submitted ? null : await png())
  const { url, login } = diskNotice
  if (url) diskJob.url = url
  $('disk-title').textContent = url ? 'Сохранено на Яндекс Диск' : login ? 'Войдите в Яндекс' : 'Ссылка пока не получена'
  $('disk-message').textContent = url ? 'Изображение доступно всем, у кого есть ссылка.' : login
    ? 'Войдите и снова нажмите «На Яндекс Диск». Снимок останется здесь.'
    : 'Проверьте загрузку на Диске или нажмите «На Яндекс Диск» ещё раз.'
  $('disk-open').textContent = login ? 'Войти в Яндекс' : 'Открыть на Диске'
  $('disk-copy').hidden = !url
  $('disk-notice').hidden = false
  status()
  if (url || login) await notifyDisk(url).catch(console.error)
}

$('save-disk').addEventListener('click', () => exportImage(exportToDisk, 'Сохраняем на Яндекс Диск…', 'Не удалось сохранить на Яндекс Диск. Попробуйте ещё раз.', false))
$('dismiss-disk-notice').addEventListener('click', () => { $('disk-notice').hidden = true })
$('disk-copy').addEventListener('click', () => copy(() => navigator.clipboard.writeText(diskNotice.url), () => window.close()))
$('disk-open').addEventListener('click', async () => {
  const { url, login } = diskNotice
  try {
    if (login) return await openDiskLogin()
    if (!url && diskJob?.tabId !== undefined) {
      const tab = await chrome.tabs.update(diskJob.tabId, { active: true }).catch(() => null)
      if (tab) return await chrome.windows.update(tab.windowId, { focused: true })
    }
    await chrome.tabs.create({ url: url ?? diskHome })
    if (url) window.close()
  } catch {
    status('Не удалось открыть Яндекс Диск.', true)
  }
})

for (const button of toolButtons) button.addEventListener('click', () => setTool(button.dataset.tool))
for (const swatch of $('palette').children) swatch.addEventListener('click', () => {
  color = swatch.dataset.color
  for (const button of $('palette').children) button.setAttribute('aria-pressed', button === swatch)
})
$('style-select').addEventListener('change', event => {
  chosenStyle[tool] = event.target.value
  updateOptions()
})
$('undo').addEventListener('click', () => moveHistory(-1))
$('redo').addEventListener('click', () => moveHistory(1))
$('zoom-out').addEventListener('click', () => changeZoom(1 / 1.25))
$('zoom-in').addEventListener('click', () => changeZoom(1.25))
$('zoom-fit').addEventListener('click', () => { zoom = null; updateSize() })
$('settings').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  } catch (error) {
    console.error(error)
    status('Откройте chrome://extensions/shortcuts в браузере.', true)
  }
})

function changeZoom(factor) {
  if (!original) return
  const scale = zoom ?? surface.clientWidth / canvas.width
  zoom = Math.max(Math.min(.15, scale), Math.min(4, scale * factor))
  updateSize()
}

document.addEventListener('keydown', event => {
  if (exporting) return
  if (event.key === 'Escape' && ocrMode) {
    setOcrMode(false)
    status()
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target.matches('input, textarea')) return
  if (event.code === 'KeyZ' || event.code === 'KeyY') {
    event.preventDefault()
    moveHistory(event.shiftKey || event.code === 'KeyY' ? 1 : -1)
  }
})
new ResizeObserver(updateSize).observe(viewport)

async function start() {
  const snapshot = await takeSnapshot(location.hash.slice(1))
  if (!snapshot) throw new Error('Capture has already been received or has expired')
  globalThis.history.replaceState(null, '', location.pathname)
  const bitmap = await createImageBitmap(snapshot.image)
  original = snapshot.region ? await cropBitmap(bitmap, snapshot.region) : bitmap
  if (snapshot.region) bitmap.close()
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  filename = `Кадр-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`
  $('file-name').textContent = filename
  $('loading').hidden = true
  surface.hidden = false
  setTool(snapshot.region ? 'arrow' : 'crop')
  render()
}

start().catch(error => {
  console.error(error)
  $('loading').textContent = 'Снимок недоступен. Вернитесь во вкладку и сделайте новый.'
  for (const button of document.querySelectorAll('button')) button.disabled = button.id !== 'settings'
})
