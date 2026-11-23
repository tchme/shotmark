import { saveSnapshot, takeSnapshot } from './snapshots.js'
import { diskLoginNotification, diskNotificationPrefix, openDiskLogin, publicDiskUrl } from './disk.js'

const pending = new Set()
const pictureMenu = 'recognize-picture'
let creatingOcr

async function openDiskNotification(id) {
  if (id === diskLoginNotification) await openDiskLogin()
  else {
    if (!id.startsWith(diskNotificationPrefix)) return
    const url = publicDiskUrl(id.slice(diskNotificationPrefix.length))
    if (!url) return
    await chrome.tabs.create({ url })
  }
  await chrome.notifications.clear(id)
}

chrome.notifications.onClicked.addListener(id => {
  openDiskNotification(id).catch(console.error)
})

async function openEditor(data, region) {
  const id = crypto.randomUUID()
  const image = await (await fetch(data)).blob()
  await saveSnapshot(id, { image, region })
  try {
    await chrome.windows.create({ type: 'popup', url: `editor.html#${id}`, width: 1280, height: 850 })
  } catch (error) {
    await takeSnapshot(id)
    throw error
  }
}

async function showError(tabId, error, title = 'Кадр — захват не удался. Нажмите, чтобы повторить.') {
  console.error(error)
  await chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {})
  await chrome.action.setTitle({ tabId, title }).catch(() => {})
}

async function captureTab(tab) {
  if (!(await chrome.tabs.get(tab.id)).active) return
  const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  if ((await chrome.tabs.get(tab.id)).active) return data
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || pending.has(tab.id)) return
  pending.add(tab.id)
  const target = { tabId: tab.id }
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
    await chrome.action.setTitle({ tabId: tab.id, title: 'Кадр — снять область' })
    const active = await chrome.scripting.executeScript({ target, func: async () => {
      if (globalThis.kadrSelection) return true
      if (globalThis.kadrPicture?.close()) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return false
    } }).catch(() => [])
    if (active[0]?.result) return
    const data = await captureTab(tab)
    if (!data) return
    const selector = active.length && await chrome.scripting.executeScript({ target, func: selectRegion, args: [data] }).catch(() => [])
    if (!selector?.[0]?.result) await openEditor(data, null)
  } catch (error) {
    await showError(tab.id, error)
  } finally {
    pending.delete(tab.id)
  }
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: pictureMenu, title: 'Распознать текст на картинке', contexts: ['image'] })
})
chrome.contextMenus.onClicked.addListener(recognizePicture)

async function recognizePicture(info, tab) {
  if (info.menuItemId !== pictureMenu || !tab?.id || !info.srcUrl) return
  const id = crypto.randomUUID()
  let target = { tabId: tab.id, frameIds: [info.frameId ?? 0] }
  let prepared = false
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
    await chrome.action.setTitle({ tabId: tab.id, title: 'Кадр — снять область' })
    await chrome.scripting.executeScript({ target, files: ['word-layer.js', 'page-picture.js'] })
    const [image] = await chrome.scripting.executeScript({ target,
      func: (src, id) => globalThis.kadrPicture?.prepare(src, id), args: [info.srcUrl, id]
    })
    if (!image?.result) throw new Error('The selected image is unavailable')
    prepared = true
    target = { tabId: tab.id, documentIds: [image.documentId] }
    const { region } = image.result
    const data = image.result.data ?? await captureTab(tab)
    if (!data) throw new Error('Could not capture the selected image')
    if (region) {
      await chrome.scripting.executeScript({ target, func: id => globalThis.kadrPicture?.started(id), args: [id] })
    }
    await ensureOcrDocument()
    const result = await chrome.runtime.sendMessage({ type: 'kadr:read-picture', data, region })
    await chrome.scripting.executeScript({ target, func: deliverPicture, args: [id, result ?? null] })
  } catch (error) {
    if (prepared) {
      console.error(error)
      await chrome.scripting.executeScript({ target, func: deliverPicture, args: [id, null] }).catch(() => {})
    } else await showError(tab.id, error, 'Кадр — картинка недоступна. Попробуйте снять её область.')
  }
}

function deliverPicture(id, result) {
  globalThis.kadrPicture?.ready(id, result)
}

async function ensureOcrDocument() {
  if (creatingOcr) return creatingOcr
  const url = chrome.runtime.getURL('offscreen.html')
  const existing = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
    : (await clients.matchAll()).filter(client => client.url === url)
  if (creatingOcr) return creatingOcr
  if (existing.length) return
  creatingOcr = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Recognize picture text locally in an OCR worker.' })
  try {
    await creatingOcr
  } finally {
    creatingOcr = null
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'kadr:selection' || sender.frameId !== 0 || !sender.tab?.id) return false
  const { data, region } = message
  if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,') ||
      !Array.isArray(region) || region.length !== 4 || region.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
      region[0] >= region[2] || region[1] >= region[3]) return false
  openEditor(data, region).then(() => reply(true), async error => {
    await showError(sender.tab.id, error)
    reply(false)
  })
  return true
})

// This function is serialized and executed in the tab's isolated world.
async function selectRegion(data) {
  if (globalThis.kadrSelection) return true
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), char => char.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`
    dialog { all:initial; position:fixed; inset:0; width:100vw; height:100vh; padding:0; margin:0; border:0;
      overflow:hidden; touch-action:none; cursor:crosshair; user-select:none; }
    canvas, .shade { position:absolute; inset:0; width:100%; height:100%; }
    .shade { background:#090e19a6; }
    .box { position:absolute; outline:2px solid #a0f0d8; box-shadow:0 0 0 200vmax #090e19a6; }
    .tip { position:absolute; left:50%; top:20px; transform:translateX(-50%); color:#f0f6fc; white-space:nowrap;
      font:600 14px system-ui; background:#17222c; border:1px solid #506173; padding:10px 14px; border-radius:6px; }
    .size { position:absolute; top:6px; left:6px; color:#a0f0d8; background:#17222c;
      padding:3px 7px; font:600 12px monospace; white-space:nowrap; }
    [hidden] { display:none; }
  `)
  shadow.adoptedStyleSheets = [sheet]
  const dialog = document.createElement('dialog')
  const canvas = document.createElement('canvas')
  const shade = document.createElement('div')
  const box = document.createElement('div')
  const size = document.createElement('span')
  const tip = document.createElement('div')
  dialog.setAttribute('aria-label', 'Выбор области')
  shade.className = 'shade'
  box.className = 'box'
  box.hidden = true
  size.className = 'size'
  tip.className = 'tip'
  tip.textContent = 'Выделите область мышью · Esc — отмена'
  box.append(size)
  dialog.append(canvas, shade, box, tip)
  shadow.append(dialog)
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()

  function close() {
    globalThis.kadrSelection = false
    dialog.close()
    host.remove()
    window.removeEventListener('resize', close)
  }

  let start
  function point(event) {
    return [Math.max(0, Math.min(dialog.clientWidth, event.clientX)), Math.max(0, Math.min(dialog.clientHeight, event.clientY))]
  }
  function bounds(event) {
    const [x, y] = point(event)
    return [Math.min(x, start[0]), Math.min(y, start[1]), Math.max(x, start[0]), Math.max(y, start[1])]
  }
  dialog.addEventListener('pointerdown', event => {
    if (event.button !== 0 || start) return
    dialog.setPointerCapture(event.pointerId)
    start = point(event)
  })
  dialog.addEventListener('pointermove', event => {
    if (!start) return
    const [left, top, right, bottom] = bounds(event)
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right-left}px`, height: `${bottom-top}px` })
    box.hidden = false
    shade.hidden = true
    size.textContent = `${Math.round((right-left) * canvas.width / dialog.clientWidth)} × ${Math.round((bottom-top) * canvas.height / dialog.clientHeight)}`
  })
  function reset() {
    start = null
    shade.hidden = false
    box.hidden = true
  }
  dialog.addEventListener('pointerup', event => {
    if (!start) return
    const [left, top, right, bottom] = bounds(event)
    if (right-left < 3 || bottom-top < 3) return reset()
    const region = [left/dialog.clientWidth, top/dialog.clientHeight, right/dialog.clientWidth, bottom/dialog.clientHeight]
    close()
    chrome.runtime.sendMessage({ type: 'kadr:selection', data, region }).catch(console.error)
  })
  dialog.addEventListener('pointercancel', reset)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('contextmenu', event => event.preventDefault())
  document.documentElement.append(host)
  dialog.showModal()
  window.addEventListener('resize', close)
  globalThis.kadrSelection = true
  return true
}
