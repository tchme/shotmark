export const diskHome = 'https://disk.yandex.ru/client/disk'
export const diskLogin = `https://passport.yandex.ru/auth?from=cloud&retpath=${encodeURIComponent(diskHome)}`
export const diskLoginNotification = 'kadr-disk-login'
export const diskNotificationPrefix = 'kadr-disk:'
export class DiskError extends Error {}

export function publicDiskUrl(value) {
  if (typeof value !== 'string' || value.length > 400) return null
  let url
  try { url = new URL(value.trim()) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['yadi.sk', 'disk.yandex.ru', 'disk.yandex.com'].includes(url.hostname) || !/^\/[id]\/[\w-]+\/?$/.test(url.pathname)) return null
  url.protocol = 'https:'
  return url.href
}

export function openDiskLogin() {
  return chrome.windows.create({ url: diskLogin, type: 'popup', width: 660, height: 760 })
}

export async function notifyDisk(url) {
  if (await chrome.notifications.getPermissionLevel() !== 'granted') return
  await chrome.notifications.create(url ? diskNotificationPrefix + url : diskLoginNotification, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icon.png'), isClickable: true,
    title: url ? 'Скриншот сохранён на Яндекс Диск' : 'Войдите в Яндекс',
    message: url ? 'Нажмите, чтобы открыть изображение' : 'Нажмите, чтобы войти. Снимок останется в редакторе.'
  })
}

async function waitForDiskTab(id) {
  const started = Date.now()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(id)
    if (tab.status === 'complete') {
      if (tab.url?.startsWith('https://disk.yandex.ru/client/')) return true
      // After the observed Passport redirect, the destination is outside the Disk host permission.
      if (!tab.url && !tab.pendingUrl && Date.now() - started > 700) return false
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new DiskError('Не удалось открыть веб-версию Яндекс Диска.')
}

export async function sendToDisk(job, png) {
  const browserWindows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  const browser = browserWindows.find(item => item.focused) ?? browserWindows[0]
  let preserveTab = false
  try {
    job.tabId ??= (await chrome.tabs.create({ url: diskHome, active: false, windowId: browser?.id })).id
    if (!await waitForDiskTab(job.tabId)) return { login: true }
    const [state] = await chrome.scripting.executeScript({ target: { tabId: job.tabId }, func: diskPageState, world: 'MAIN' })
    if (state.result === 'login') return { login: true }
    if (state.result !== 'ready') throw new DiskError('Яндекс Диск не открыл список файлов. Откройте Диск и повторите попытку.')

    let data = null
    if (!job.submitted) {
      data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new DiskError('Не удалось подготовить PNG.'))
        reader.readAsDataURL(png)
      })
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: job.tabId }, func: uploadAndShareOnPage, args: [job.name, data], world: 'MAIN'
    })
    const response = result.result
    if (response?.submitted) job.submitted = true
    const url = publicDiskUrl(response?.url)
    if (url) return { url }
    preserveTab = job.submitted
    if (preserveTab) return { pending: true }
    throw new DiskError('Не удалось начать загрузку через веб-версию Диска.')
  } finally {
    if (!preserveTab && job.tabId !== undefined) {
      await chrome.tabs.remove(job.tabId).catch(() => {})
      delete job.tabId
      delete job.submitted
    }
  }
}

async function diskPageState() {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const login = document.querySelector('a[href*="passport.yandex.ru/auth"]')
    if (login?.getClientRects().length && /^(войти|sign in|log in)$/iu.test(login.textContent.trim())) return 'login'
    if (document.querySelector('input[type="file"]')) return 'ready'
    const controls = [...document.querySelectorAll('button, [role="button"], label')]
    if (controls.some(item => item.getClientRects().length &&
      [item.textContent, item.getAttribute('aria-label'), item.title].some(value => /^(загрузить|upload)$/iu.test(value?.trim() || '')))) return 'ready'
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return 'unknown'
}

// Serialized into the signed-in Disk page. All file and share actions are scoped to the requested filename.
async function uploadAndShareOnPage(name, data) {
  const controls = 'button, a, [role="button"], [role="menuitem"]'
  const itemSelector = '.listing-item, [role="row"], [role="listitem"], [class*="upload-item"], [class*="uploader-item"], [class*="uploads-list-item"]'
  const shareLabel = /^(поделиться(?: ссылкой)?|скопировать ссылку|копировать ссылку|share(?: link)?|copy link)$/iu
  const copyLabel = /^(скопировать(?: ссылку)?|копировать(?: ссылку)?|copy(?: link)?)$/iu
  const linkPattern = /https?:\/\/(?:yadi\.sk|disk\.yandex\.(?:ru|com))\/[id]\/[\w-]+(?:\?[^\s"'<>]*)?/iu
  const visible = element => element.getClientRects().length > 0
  let submitted = data === null
  let copied

  function control(root, pattern) {
    return [...root.querySelectorAll(controls)].find(button => visible(button) && !button.disabled &&
      [button.getAttribute('aria-label'), button.title, button.textContent].some(value => pattern.test(value?.trim() || '')))
  }

  function fileLabels() {
    return [...document.querySelectorAll('[title], [aria-label], span, p, div')].filter(element => visible(element) &&
      (element.title === name || element.getAttribute('aria-label') === name || (!element.childElementCount && element.textContent.trim() === name)))
  }

  function shareForFile() {
    for (const label of fileLabels()) {
      const row = label.closest(itemSelector)
      if (row) {
        const share = control(row, shareLabel)
        if (share) return share
      }
    }
  }

  async function waitFor(read, maxMs) {
    const deadline = Date.now() + maxMs
    do {
      const value = read()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
  }

  function publicLinks() {
    const links = new Set()
    for (const element of document.querySelectorAll('input, textarea, a[href]')) {
      if (!visible(element)) continue
      const link = (element.value || element.href || '').match(linkPattern)?.[0]
      if (link) links.add(link)
    }
    return links
  }

  if (data && !fileLabels().length) {
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), char => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    const input = document.querySelector('input[type="file"]:not([webkitdirectory]):not([directory]):not(:disabled)')
    if (input) {
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      const target = document.querySelector('.listing, main, [role="main"]') || document.body
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    }
    submitted = true
  }

  let share = await waitFor(shareForFile, 25_000)
  if (!share) {
    const label = fileLabels()[0]
    if (!label) return { submitted }
    const row = label.closest(itemSelector) || label
    const { x, y } = row.getBoundingClientRect()
    const before = new Set([...document.querySelectorAll(controls)].filter(visible))
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x + 5, clientY: y + 5 }))
    share = await waitFor(() => [...document.querySelectorAll(controls)].find(button => !before.has(button) && visible(button) &&
      [button.getAttribute('aria-label'), button.title, button.textContent].some(value => shareLabel.test(value?.trim() || ''))), 4_000)
  }
  if (!share) return { submitted }

  const before = publicLinks()
  const clipboard = navigator.clipboard
  const writeText = clipboard?.writeText
  function intercept(text) {
    copied = String(text).match(linkPattern)?.[0]
    return Promise.resolve()
  }
  function captureCopy(event) {
    copied = (event.clipboardData?.getData('text/plain') || document.activeElement?.value || document.getSelection()?.toString() || '').match(linkPattern)?.[0]
    if (copied) event.preventDefault()
  }
  if (writeText) clipboard.writeText = intercept
  window.addEventListener('copy', captureCopy)
  try {
    share.click()
    const newUrl = () => copied || [...publicLinks()].find(link => !before.has(link))
    const action = await waitFor(() => newUrl() || control(document.querySelector('[role="dialog"], dialog[open], [class*="share-dialog"]') || share.parentElement, copyLabel), 8_000)
    if (typeof action === 'string') return { submitted, url: action }
    action?.click()
    return { submitted, url: (await waitFor(newUrl, 5_000)) || null }
  } finally {
    if (clipboard?.writeText === intercept) clipboard.writeText = writeText
    window.removeEventListener('copy', captureCopy)
  }
}
