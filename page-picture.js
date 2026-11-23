(() => {
  if (globalThis.kadrPicture) return

  const parentOf = element => element.parentElement || element.getRootNode().host
  const viewport = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })
  let active

  function intersect(a, b) {
    return {
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)
    }
  }

  function offset(value, free) {
    if (value?.endsWith('%')) return free * parseFloat(value) / 100
    if (value?.endsWith('px')) return parseFloat(value)
    return free / 2
  }

  function geometry(image) {
    const rect = image.getBoundingClientRect()
    const style = getComputedStyle(image)
    if (!rect.width || !rect.height || style.visibility !== 'visible') return null

    const sx = rect.width / image.offsetWidth || 1
    const sy = rect.height / image.offsetHeight || 1
    const content = {
      left: rect.left + sx * (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)),
      top: rect.top + sy * (parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)),
      right: rect.right - sx * (parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight)),
      bottom: rect.bottom - sy * (parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom))
    }
    const availableW = (content.right - content.left) / sx
    const availableH = (content.bottom - content.top) / sy
    const { naturalWidth, naturalHeight } = image
    let width = availableW
    let height = availableH
    if (style.objectFit !== 'fill') {
      const contain = Math.min(availableW / naturalWidth, availableH / naturalHeight)
      const fit = {
        contain, cover: Math.max(availableW / naturalWidth, availableH / naturalHeight),
        'scale-down': Math.min(1, contain), none: 1
      }[style.objectFit]
      width = naturalWidth * fit
      height = naturalHeight * fit
    }
    if (!(width > 0 && height > 0)) return null
    const [posX, posY] = style.objectPosition.split(' ')
    const left = content.left + offset(posX, availableW - width) * sx
    const top = content.top + offset(posY, availableH - height) * sy
    width *= sx
    height *= sy
    const painted = { left, top, width, height, right: left + width, bottom: top + height }
    let clip = intersect(intersect(painted, content), viewport())
    for (let node = parentOf(image); node && node !== document.body; node = parentOf(node)) {
      const { overflowX, overflowY } = getComputedStyle(node)
      if (overflowX === 'visible' && overflowY === 'visible') continue
      const box = node.getBoundingClientRect()
      clip = intersect(clip, {
        left: overflowX === 'visible' ? -Infinity : box.left, right: overflowX === 'visible' ? Infinity : box.right,
        top: overflowY === 'visible' ? -Infinity : box.top, bottom: overflowY === 'visible' ? Infinity : box.bottom
      })
    }
    return { painted, clip }
  }

  function findImage(src) {
    let best
    let score = 0
    function visit(root) {
      for (const element of root.querySelectorAll('*')) {
        const shadow = element.shadowRoot
        if (shadow) visit(shadow)
        if (element.localName !== 'img' || !element.naturalWidth || (element.currentSrc !== src && element.src !== src)) continue
        const box = geometry(element)
        if (!box) continue
        const { left, top, right, bottom } = box.clip
        if (left >= right || top >= bottom) continue
        const hit = root.elementFromPoint((left + right) / 2, (top + bottom) / 2) === element
        const rank = (right - left) * (bottom - top) * (hit ? 2 : 1)
        if (rank > score) {
          best = { element, ...box }
          score = rank
        }
      }
    }
    visit(document)
    return best
  }

  function close() {
    if (!active) return false
    cancelAnimationFrame(active.animation)
    active.listeners.abort()
    active.host.remove()
    active = null
    return true
  }

  function mount(id, image, fraction, capturing = false) {
    const host = document.createElement('div')
    host.setAttribute('data-kadr-ocr', '')
    if (host.showPopover) host.popover = 'manual'
    const shadow = host.attachShadow({ mode: 'closed' })
    const css = new CSSStyleSheet()
    css.replaceSync(`
      :host { all:initial!important; display:block!important; position:fixed!important; inset:0!important;
        z-index:2147483647!important; border:0!important; margin:0!important; padding:0!important;
        background:transparent!important; width:auto!important; height:auto!important; overflow:visible!important;
        pointer-events:none!important; }
      :host([hidden]) { display:none!important; }
      .surface { position:absolute; pointer-events:none; }
      canvas, .words { position:absolute; inset:0; width:100%; height:100%; }
      .words { overflow:hidden; user-select:text; color:transparent; container-type:inline-size; }
      .ocr-line { position:absolute; width:100%; white-space:pre; line-height:1; font-family:'Segoe UI',sans-serif;
        font-kerning:none; font-variant-ligatures:none; }
      .ocr-word { display:inline-block; vertical-align:top; pointer-events:auto; cursor:text; }
      .ocr-word:hover { background:#70e7cf38; }
      .ocr-space { font-size:0; }
      .words ::selection { color:transparent; background:#2dbbed85; }
      .tools { position:absolute; display:flex; align-items:center; gap:5px; pointer-events:auto;
        background:#202730; color:#e7edf5; font:13px/1.4 system-ui; white-space:nowrap;
        border:1px solid #4b6270; border-radius:7px; padding:3px; box-shadow:0 4px 16px #121a2366; }
      .tools span { padding:0 5px; }
      button { border:0; border-radius:4px; padding:5px 8px; cursor:pointer; font:inherit; color:inherit; background:none; }
      button:hover,button:focus-visible { color:#a0f0d8; background:#30453f; }
      [hidden] { display:none!important; }
    `)
    shadow.adoptedStyleSheets = [css]
    const surface = document.createElement('div')
    const canvas = document.createElement('canvas')
    const words = document.createElement('div')
    const tools = document.createElement('div')
    const status = document.createElement('span')
    const copy = document.createElement('button')
    const dismiss = document.createElement('button')
    surface.className = 'surface'
    words.className = 'words'
    words.setAttribute('aria-label', 'Распознанный текст')
    tools.className = 'tools'
    tools.hidden = capturing
    status.setAttribute('role', 'status')
    status.textContent = 'Распознаём текст…'
    copy.textContent = 'Копировать весь текст'
    copy.hidden = true
    dismiss.textContent = '×'
    dismiss.title = 'Закрыть (Esc)'
    dismiss.setAttribute('aria-label', 'Закрыть распознавание')
    surface.append(canvas, words)
    surface.hidden = true
    tools.append(status, copy, dismiss)
    shadow.append(surface, tools)

    let container = document.body
    for (let node = parentOf(image); node; node = parentOf(node)) {
      if (node === document.fullscreenElement || node.matches('dialog[open]') || (host.showPopover && node.matches(':popover-open'))) {
        container = node
        break
      }
    }
    container.append(host)
    if (host.showPopover) host.showPopover()
    const listeners = new AbortController()
    active = { id, host, listeners, canvas, words, surface, copy, status, tools }
    dismiss.addEventListener('click', close)
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || host.hidden) return
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }, { capture: true, signal: listeners.signal })
    window.addEventListener('copy', event => {
      const selection = shadow.getSelection()
      if (!selection || !words.contains(selection.anchorNode) || !words.contains(selection.focusNode)) return
      const text = selection.toString().trim()
      if (!text || !event.clipboardData) return
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
      event.stopImmediatePropagation()
    }, { capture: true, signal: listeners.signal })
    copy.addEventListener('click', async () => {
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(active.text)
        else {
          const input = document.createElement('textarea')
          input.value = active.text
          tools.append(input)
          input.select()
          const copied = document.execCommand('copy')
          input.remove()
          if (!copied) throw new Error('Clipboard write failed')
        }
        if (active?.id === id) copy.textContent = 'Текст скопирован'
      } catch {
        if (active?.id === id) copy.textContent = 'Повторить копирование'
      }
    })

    const source = image.currentSrc || image.src
    const [x0, y0, x1, y1] = fraction
    let last
    let lastFrame = -Infinity
    function follow(now) {
      if (now - lastFrame < 30) {
        active.animation = requestAnimationFrame(follow)
        return
      }
      lastFrame = now
      if (!host.isConnected || !image.isConnected || (image.currentSrc || image.src) !== source ||
          (container.localName === 'dialog' && !container.open)) return close()
      const box = geometry(image)
      if (!box) return close()
      const { painted: p, clip } = box
      const left = p.left + p.width * x0
      const top = p.top + p.height * y0
      const width = p.width * (x1 - x0)
      const height = p.height * (y1 - y0)
      const visible = intersect({ left, top, right: left + width, bottom: top + height }, clip)
      host.hidden = visible.right <= visible.left || visible.bottom <= visible.top
      if (!host.hidden) {
        const position = [left, top, width, height, visible.left, visible.top, visible.right, visible.bottom].join(',')
        if (position !== last) {
          last = position
          Object.assign(surface.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
            clipPath: `inset(${visible.top - top}px ${left + width - visible.right}px ${top + height - visible.bottom}px ${visible.left - left}px)` })
          Object.assign(tools.style, { left: `${Math.max(4, Math.min(innerWidth - 226, visible.left + 6))}px`, top: `${Math.max(4, visible.top - 36)}px` })
        }
      }
      active.animation = requestAnimationFrame(follow)
    }
    follow(performance.now())
  }

  function prepare(src, id) {
    close()
    const found = findImage(src)
    if (!found) return null
    const { element, painted, clip } = found
    const image = document.createElement('canvas')
    image.width = element.naturalWidth
    image.height = element.naturalHeight
    try {
      image.getContext('2d').drawImage(element, 0, 0)
      const data = image.toDataURL('image/png')
      if (data.startsWith('data:image/png;')) {
        mount(id, element, [0, 0, 1, 1])
        return { data }
      }
    } catch (error) {
      if (error.name !== 'SecurityError') throw error
    }
    // shortcut: use visible tab pixels for tainted images in the top frame, add frame geometry if needed.
    if (window !== window.top) return null
    const fraction = [
      (clip.left - painted.left) / painted.width, (clip.top - painted.top) / painted.height,
      (clip.right - painted.left) / painted.width, (clip.bottom - painted.top) / painted.height
    ]
    mount(id, element, fraction, true)
    return { region: [clip.left / innerWidth, clip.top / innerHeight, clip.right / innerWidth, clip.bottom / innerHeight] }
  }

  function ready(id, result) {
    if (active?.id !== id) return false
    const { canvas, words, surface, copy, status, tools } = active
    tools.hidden = false
    if (!result?.text.trim()) {
      status.textContent = result ? 'На картинке нет текста' : 'Не удалось распознать текст'
      return false
    }
    canvas.width = result.width
    canvas.height = result.height
    globalThis.kadrShowWords(words, result.blocks, canvas.getContext('2d'))
    active.text = result.text.trim()
    surface.hidden = false
    status.hidden = true
    copy.hidden = false
    return true
  }

  function started(id) {
    if (active?.id === id) active.tools.hidden = false
  }

  globalThis.kadrPicture = { prepare, ready, started, close }
})()
