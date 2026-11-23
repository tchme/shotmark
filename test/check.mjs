import assert from 'node:assert/strict'
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const testWork = path.join(root, '.test-work')
await mkdir(testWork, { recursive: true })
const run = await mkdtemp(path.join(testWork, 'run-'))
const extension = path.join(run, 'extension')
const excluded = new Set(['.git', '.test-work', 'graphify-out', 'node_modules', 'test'])
await mkdir(extension)
for (const entry of await readdir(root)) {
  if (!excluded.has(entry)) await cp(path.join(root, entry), path.join(extension, entry), { recursive: true })
}
await appendFile(path.join(extension, 'capture.js'), '\nglobalThis.testContextClick = recognizePicture\nglobalThis.testDiskNoticeClick = openDiskNotification\n')
const example = await readFile(path.join(import.meta.dirname, 'example.html'))
let scan
const server = createServer((request, response) => {
  if (request.url === '/scan.png') {
    response.setHeader('Content-Type', 'image/png')
    return response.end(scan)
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.url === '/image' || request.url === '/external-image') {
    const source = request.url === '/image' ? '/scan.png' : `http://127.0.0.1:${external.address().port}/scan.png`
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src http:; style-src 'unsafe-inline'; require-trusted-types-for 'script'")
    if (request.url === '/external-image') {
      return response.end(`<div style="height:155px"></div><img src="${source}" width="640" alt="Test image"><div style="height:850px"></div>`)
    }
    return response.end(`<!doctype html><meta charset="utf-8"><title>Просмотр изображения</title>
      <style>body{background:#e3e9ef;font:15px system-ui}dialog{position:fixed;inset:0;width:100%;height:100%;max-width:none;
      max-height:none;margin:0;box-sizing:border-box;border:0;padding:18px 24px;background:#202630;color:#e8edf4}
      dialog header{display:flex;justify-content:space-between}dialog img{display:block;width:800px;height:590px;object-fit:contain;margin:20px auto 0}</style>
      <img src="${source}" width="850" alt="Background copy"><dialog><header><span>Заметки о путешествии.png</span><span>Просмотр изображения</span></header>
      <img src="${source}" alt="Test image"></dialog>`)
  }
  if (request.url === '/paper') return response.end(`<!doctype html><meta charset=utf-8>
    <style>body{margin:25px;background:#edf0f5}article{box-sizing:border-box;width:760px;background:#fff9ed;
    padding:45px 54px;color:#161d27;font:25px/1.55 Georgia,serif}h1{font-size:37px;margin:0 0 16px}p{margin:0 0 17px}</style>
    <article><h1>Заметки о путешествии</h1>
    <p>Утром мы вышли к реке и увидели, как туман<br>медленно уходит с воды. На противоположном<br>берегу уже горели окна старого вокзала.</p>
    <p>В записной книжке остались названия станций,<br>время отправления и короткая строка на полях.</p>
    <p>Next stop: Riverside Station.</p></article>`)
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'")
  response.end(example)
})
const external = createServer((_, response) => {
  response.setHeader('Content-Type', 'image/png')
  response.end(scan)
})
await Promise.all([server, external].map(listener => new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))))
const profile = path.join(run, 'profile')
await mkdir(profile)
const downloadPath = path.join(profile, 'downloads')
await mkdir(path.join(profile, 'Default'))
await mkdir(downloadPath)
await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadPath } }))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1150, height: 720 },
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
})
const errors = []
const expect = async (check, message, timeout = 6000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).hostname
  const page = context.pages()[0]
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const browserClient = await context.browser().newBrowserCDPSession()
  await browserClient.send('Browser.setDownloadBehavior', { behavior: 'default' })
  const { targetInfos } = await browserClient.send('Target.getTargets', { filter: [{ type: 'tab' }] })
  const targetId = targetInfos.find(target => target.url === page.url())?.targetId ?? targetInfos[0]?.targetId
  assert.ok(targetId, JSON.stringify(targetInfos))
  const fire = () => browserClient.send('Extensions.triggerAction', { id, targetId })
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id)
  const selectorOpen = async () => (await worker.evaluate(async tabId => {
    const [state] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean(globalThis.kadrSelection) })
    return state.result
  }, tabId).catch(() => false))
  const shortcuts = await worker.evaluate(() => chrome.commands.getAll())
  assert.equal(shortcuts.find(command => command.name === '_execute_action').shortcut, 'Alt+Shift+S')
  await worker.evaluate(() => chrome.contextMenus.update('recognize-picture', { title: 'Распознать текст на картинке' }))
  await fire()
  await expect(selectorOpen, 'Capture overlay did not open')
  await page.keyboard.press('Escape')
  await expect(async () => !(await selectorOpen()), 'Escape did not cancel capture')
  assert.equal(context.pages().length, 1)
  await fire()
  await expect(selectorOpen, 'Capture overlay did not reopen')
  const editorPromise = context.waitForEvent('page')
  await page.mouse.move(40, 30)
  await page.mouse.down()
  await page.mouse.move(1060, 606, { steps: 10 })
  await page.mouse.up()
  const editor = await editorPromise
  editor.on('pageerror', error => errors.push(error.message))
  editor.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await editor.waitForURL(`chrome-extension://${id}/editor.html`)
  await editor.setViewportSize({ width: 1200, height: 790 })
  await editor.locator('#surface').waitFor()
  assert.equal(await editor.locator('#resolution').textContent(), '1020 × 576 px')
  console.log('Capture action, cancel and crop passed')

  await editor.evaluate(() => {
    window.testClipboard = {}
    navigator.clipboard.writeText = async text => { window.testClipboard.text = text }
  })
  const tool = value => editor.locator(`[data-tool="${value}"]`).first().click()
  async function drag(x, y, endX, endY) {
    const { x: left, y: top, width, height } = await editor.locator('#result').boundingBox()
    await editor.mouse.move(left + x * width, top + y * height)
    await editor.mouse.down()
    await editor.mouse.move(left + endX * width, top + endY * height, { steps: 10 })
    await editor.mouse.up()
  }
  const pixel = (x, y) => editor.locator('#result').evaluate((canvas, [x, y]) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data], [x, y])
  const snapshot = () => editor.locator('#result').evaluate(canvas => canvas.toDataURL())
  const source = await snapshot()
  assert.equal(await editor.locator('#visual-styles [aria-pressed="true"]').getAttribute('data-style'), 'tapered')
  const arrows = new Set()
  for (const style of ['solid', 'open', 'dashed', 'double', 'curved', 'tapered']) {
    const button = editor.locator(`#visual-styles [data-style="${style}"]`)
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await drag(.649, .34, .372, .417)
    arrows.add(await snapshot())
    await editor.locator('#undo').click()
  }
  assert.equal(arrows.size, 6)
  const taper = await editor.evaluate(async () => {
    const { draw } = await import('./drawing.js')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    draw(ctx, { tool: 'arrow', style: 'tapered', color: '#ef4955', size: 6, from: { x: 10, y: 45 }, to: { x: 200, y: 45 } })
    return [25, 105, 175].map(x => ctx.getImageData(x, 0, 1, 90).data.filter((alpha, index) => index % 4 === 3 && alpha > 127).length)
  })
  assert.ok(taper[0] < taper[1] && taper[1] < taper[2], `Expected a widening arrow, got ${taper}`)
  await drag(.649, .34, .372, .417)
  assert.notEqual(await snapshot(), source)
  const withArrow = await snapshot()
  await tool('shape')
  assert.equal(await editor.locator('#style-select').isVisible(), false)
  await editor.locator('[data-color="#4b91ef"]').click()
  const shapes = new Set()
  for (const style of ['rounded', 'triangle', 'diamond', 'hexagon', 'star']) {
    const button = editor.locator(`#visual-styles [data-style="${style}"]`)
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await drag(.638, .670, .731, .723)
    const rendered = await snapshot()
    assert.notEqual(rendered, withArrow, style)
    shapes.add(rendered)
    await editor.locator('#undo').click()
  }
  await editor.getByRole('button', { name: 'Прямоугольник', exact: true }).click()
  await drag(.638, .670, .731, .723)
  const withRectangle = await snapshot()
  assert.notEqual(withRectangle, withArrow)
  shapes.add(withRectangle)
  await editor.locator('#undo').click()
  await editor.getByRole('button', { name: 'Эллипс' }).click()
  await drag(.638, .670, .731, .723)
  assert.notEqual(await snapshot(), withArrow)
  assert.notEqual(await snapshot(), withRectangle)
  shapes.add(await snapshot())
  assert.equal(shapes.size, 7)
  await tool('hide')
  assert.equal(await editor.locator('#style-select').inputValue(), 'pixelate')
  assert.equal(await editor.locator('#weight-caption').textContent(), 'Размер блоков')
  const beforeMosaic = await snapshot()
  await drag(.208, .660, .392, .724)
  assert.notEqual(await snapshot(), beforeMosaic)
  await tool('shape')
  await editor.screenshot({ path: path.join(run, 'kadr-figures-check.png') })
  await editor.locator('#undo').click()
  assert.equal(await snapshot(), beforeMosaic)
  await editor.evaluate(async () => {
    const { draw } = await import('./drawing.js')
    const canvas = document.createElement('canvas')
    canvas.width = 23
    canvas.height = 17
    const ctx = canvas.getContext('2d', { alpha: false })
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      ctx.fillStyle = `rgb(${x * 10}, ${y * 10}, 0)`
      ctx.fillRect(x, y, 1, 1)
    }
    draw(ctx, { tool: 'hide', style: 'pixelate', size: 3, from: { x: 3, y: 4 }, to: { x: 17, y: 13 } })
    const samples = [[2,4,20,40],[3,4,55,65],[8,9,55,65],[9,4,115,65],[16,12,155,110],[17,12,170,120],[3,13,30,130]]
    for (const [x, y, red, green] of samples) {
      const actual = [...ctx.getImageData(x, y, 1, 1).data].join(',')
      if (actual !== `${red},${green},0,255`) throw new Error(`Wrong mosaic sample at ${x},${y}: ${actual}`)
    }
  })
  await tool('pen')
  await editor.locator('[data-color="#f4ba43"]').click()
  await drag(.217, .774, .319, .774)
  await tool('text')
  await editor.locator('[data-color="#4b91ef"]').click()
  const beforeLabel = await snapshot()
  await drag(.66, .29, .91, .362)
  const label = editor.locator('#label-input')
  assert.equal(await label.evaluate(input => document.activeElement === input), true)
  await label.pressSequentially('Проверить')
  await label.press('Enter')
  await label.pressSequentially('перед выпуском')
  assert.equal(await label.inputValue(), 'Проверить\nперед выпуском')
  await editor.mouse.move(17, 15)
  await editor.screenshot({ path: path.join(run, 'kadr-text.png') })
  await label.press('Control+Enter')
  await label.waitFor({ state: 'hidden' })
  const labelPixels = await snapshot()
  assert.notEqual(labelPixels, beforeLabel)
  await editor.locator('#undo').click()
  assert.equal(await snapshot(), beforeLabel)
  await editor.locator('#redo').click()
  assert.equal(await snapshot(), labelPixels)
  await drag(.35, .26, .35, .26)
  await label.fill('Отмена')
  await label.press('Escape')
  assert.equal(await snapshot(), labelPixels)
  await drag(.06, .35, .18, .38)
  await label.fill('Перенос длинной подписи')
  await label.evaluate(input => input.blur())
  assert.notEqual(await snapshot(), labelPixels)
  await editor.locator('#undo').click()
  await tool('hide')
  await editor.selectOption('#style-select', 'solid')
  await drag(.211, .831, .405, .904)
  assert.deepEqual(await pixel(400, 500), [20, 25, 35, 255])
  await editor.keyboard.press('Control+z')
  assert.notDeepEqual(await pixel(400, 500), [20, 25, 35, 255])
  await editor.keyboard.press('Control+Shift+z')
  assert.deepEqual(await pixel(400, 500), [20, 25, 35, 255])
  await tool('arrow')
  await editor.locator('[data-color="#ef4955"]').click()
  await editor.mouse.move(13, 10)
  await editor.screenshot({ path: path.join(run, 'kadr-editor.png') })

  await tool('crop')
  await drag(.05, .10, .95, .92)
  assert.equal(await editor.locator('#resolution').textContent(), '918 × 472 px')
  await editor.locator('#undo').click()
  await tool('hide')
  await editor.selectOption('#style-select', 'blur')
  const beforeBlur = await snapshot()
  await drag(.054, .652, .133, .712)
  assert.notEqual(await snapshot(), beforeBlur)
  await editor.locator('#undo').click()
  console.log('Default tapered arrow, seven shapes, square mosaic blocks, inline typing, mask, blur and crop passed')

  const unexpectedRequests = []
  editor.on('request', request => {
    if (/^https?:/.test(request.url())) unexpectedRequests.push(request.url())
  })
  await context.setOffline(true)
  await editor.locator('#recognize').click()
  await editor.locator('#ocr-tools').waitFor({ timeout: 35000 })
  await editor.screenshot({ path: path.join(run, 'kadr-ocr.png') })
  const rawText = await editor.locator('#recognized-text').inputValue()
  assert.match(rawText, /Журнал релизов/i)
  assert.match(rawText, /Export report/i)
  assert.doesNotMatch(rawText, /Внутренний черновик/i)
  assert.deepEqual(unexpectedRequests, [])
  const journal = editor.locator('.ocr-word').filter({ hasText: /^Журнал$/ }).first()
  await journal.dblclick({ position: { x: 22, y: 12 } })
  assert.equal(await editor.evaluate(() => window.getSelection().toString()), 'Журнал')
  const transfer = await editor.evaluate(() => {
    const clipboard = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, cancelable: true }))
    return clipboard.getData('text/plain')
  })
  assert.equal(transfer, 'Журнал')
  await editor.locator('#copy-text').click()
  assert.match(await editor.evaluate(() => window.testClipboard.text), /Журнал релизов/i)
  await editor.locator('#text-panel-toggle').click()
  await editor.locator('#recognized-text').fill('Исправленный текст')
  await editor.keyboard.press('Escape')
  await editor.locator('#recognize').click()
  await editor.locator('#copy-text').click()
  assert.equal(await editor.evaluate(() => window.testClipboard.text), 'Исправленный текст')
  assert.deepEqual(errors, [])
  console.log('Offline Russian/English OCR, protected mask, single-word selection and copy-all passed')

  const settingsPromise = context.waitForEvent('page')
  await editor.locator('#settings').click()
  const settings = await settingsPromise
  await settings.waitForURL('chrome://extensions/shortcuts')
  await settings.locator('cr-shortcut-input #edit').click({ timeout: 4000 })
  await settings.keyboard.press('Control+Shift+8')
  await expect(async () => (await worker.evaluate(() => chrome.commands.getAll()))[0].shortcut === 'Ctrl+Shift+8', 'Custom shortcut was not saved')
  console.log('Shortcut settings link and user reassignment passed')
  await settings.close()

  await editor.bringToFront()
  await editor.evaluate(() => {
    navigator.clipboard.write = async () => { throw new Error('Test clipboard error') }
    window.testDownload = chrome.downloads.download
    chrome.downloads.download = async () => { throw new Error('Test cancelled download') }
  })
  await editor.locator('#copy-image').click()
  await expect(async () => (await editor.locator('#status').textContent()).startsWith('Не удалось скопировать снимок'), 'A clipboard failure did not preserve the editor')
  await editor.locator('#save-image').click()
  await expect(async () => (await editor.locator('#status').textContent()).startsWith('PNG не сохранён'), 'A download failure did not preserve the editor')
  await editor.evaluate(() => { chrome.downloads.download = window.testDownload })
  const editorClosed = editor.waitForEvent('close')
  await editor.locator('#save-image').click()
  await editorClosed
  const [download] = await worker.evaluate(() => chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }))
  assert.equal(download.state, 'complete')
  assert.match(path.basename(download.filename), /^Кадр-.*\.png$/)
  assert.equal(path.dirname(download.filename), downloadPath)
  assert.equal((await readFile(download.filename)).subarray(1, 4).toString(), 'PNG')
  console.log('Copy and save failures kept the editor open, completed PNG save closed it')

  await context.setOffline(false)
  await page.bringToFront()
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/paper`)
  scan = await page.locator('article').screenshot()
  const invokePicture = async (selector = 'img[alt="Test image"]') => {
    const srcUrl = await page.locator(selector).evaluate(image => image.currentSrc)
    await worker.evaluate(async ({ tabId, srcUrl }) => {
      await globalThis.testContextClick({ menuItemId: 'recognize-picture', srcUrl }, await chrome.tabs.get(tabId))
    }, { tabId, srcUrl })
  }
  const overlay = async (action = null) => worker.evaluate(async ({ tabId, action }) => {
    const [response] = await chrome.scripting.executeScript({ target: { tabId }, args: [action], func: action => {
      const host = document.querySelector('[data-kadr-ocr]')
      if (!host) return null
      const shadow = chrome.dom.openOrClosedShadowRoot(host)
      if (action === 'copy') {
        const clipboard = new DataTransfer()
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, cancelable: true }))
        return clipboard.getData('text/plain')
      }
      const word = [...shadow.querySelectorAll('.ocr-word')].find(word => word.textContent === 'Заметки')
      const char = word?.querySelectorAll('.ocr-character')[2]
      return {
        hostParent: host.parentElement.localName, selection: shadow.getSelection().toString(),
        canvasWidth: shadow.querySelector('canvas').width, bounds: char?.getBoundingClientRect().toJSON(),
        text: char?.textContent, status: shadow.querySelector('[role="status"]').textContent
      }
    } })
    return response.result
  }, { tabId, action })
  for (const route of ['image', 'external-image']) {
    await page.goto(`${origin}/${route}`)
    await page.locator('img[alt="Test image"]').evaluate(image => image.decode())
    if (route === 'image') await page.locator('dialog').evaluate(dialog => dialog.showModal())
    // activeTab is already granted for this origin by the earlier capture action.
    await context.setOffline(true)
    await invokePicture()
    await expect(async () => Boolean((await overlay())?.bounds), `No recognized layer for ${route}`)
    const result = await overlay()
    assert.equal(context.pages().length, 1)
    assert.equal(result.canvasWidth, route === 'image' ? 760 : 640)
    assert.equal(result.hostParent, route === 'image' ? 'dialog' : 'body')
    assert.equal(result.text, 'м')
    if (route === 'image') {
      const { x, y, width, height } = result.bounds
      await page.mouse.move(x + width * .2, y + height / 2)
      await page.mouse.down()
      await page.mouse.move(x + width * .8, y + height / 2, { steps: 6 })
      await page.mouse.up()
      assert.equal((await overlay()).selection, 'м')
      assert.equal(await overlay('copy'), 'м')
      await page.mouse.move(25, 15)
      await page.screenshot({ path: path.join(run, 'kadr-ocr-page.png') })
      await page.locator('dialog img').evaluate(image => { image.style.transform = 'translateX(31px) scale(.9)' })
      await expect(async () => Math.abs((await overlay()).bounds.x - x) > 20, 'The layer did not follow image zoom and translation')
      await page.keyboard.press('Escape')
      await expect(async () => !(await overlay()), 'Escape did not dismiss OCR')
      assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true)
      await invokePicture()
      await page.locator('dialog').evaluate(dialog => dialog.close())
      await expect(async () => !(await overlay()), 'Closing the viewer did not clear the OCR layer')
    } else {
      await page.evaluate(() => window.scrollTo(0, 75))
      await expect(async () => Math.abs((await overlay()).bounds.y - (result.bounds.y - 75)) < 2, 'The layer did not follow scroll')
    }
    await context.setOffline(false)
  }
  await page.goto(`${origin}/scan.png`)
  await page.locator('img').evaluate(image => image.decode())
  await invokePicture('img')
  assert.equal((await overlay()).text, 'м')
  assert.equal(context.pages().length, 1)
  async function captureCurrent() {
    await page.bringToFront()
    await fire()
    await expect(selectorOpen, 'The regular capture did not start')
    assert.equal(await overlay(), null)
    const capturePromise = context.waitForEvent('page')
    await page.mouse.move(250, 140)
    await page.mouse.down()
    await page.mouse.move(860, 545, { steps: 7 })
    await page.mouse.up()
    const popup = await capturePromise
    await popup.locator('#surface').waitFor()
    return popup
  }
  let captureEditor = await captureCurrent()

  let signedIn = false
  let publishedFile = ''
  let uploadedBytes
  const publicUrl = 'https://yadi.sk/i/KadrIntegrationTest_04'
  const diskHome = 'https://disk.yandex.ru/client/disk'
  const diskLogin = 'https://passport.yandex.ru/auth?from=cloud&retpath=' + encodeURIComponent(diskHome)
  await context.route('https://disk.yandex.ru/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/client/disk' && !signedIn) return route.fulfill({ status: 302, headers: { location: diskLogin } })
    if (pathname === '/client/disk') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
      <button>Загрузить</button><input type="file" hidden><main class="listing"><div class="listing-item"><span>unrelated.png</span><button>Поделиться</button></div></main>
      <script src="/fixture.js"></script>` })
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: `
      document.querySelector('input').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        await fetch('/fixture-upload?name=' + encodeURIComponent(file.name), { method:'PUT', body:file });
        const row = document.createElement('div'); row.className = 'upload-item';
        const label = document.createElement('span'); label.title = file.name; label.textContent = file.name;
        const share = document.createElement('button'); share.textContent = 'Поделиться';
        share.addEventListener('click', async () => {
          await fetch('/fixture-publish?name=' + encodeURIComponent(file.name), { method:'PUT' });
          const dialog = document.createElement('dialog'); const copy = document.createElement('button');
          copy.textContent = 'Скопировать ссылку'; copy.onclick = () => navigator.clipboard.writeText(${JSON.stringify(publicUrl)});
          dialog.append(copy); document.body.append(dialog); dialog.showModal();
        });
        row.append(label, share); document.querySelector('main').append(row);
      });` })
    if (pathname === '/fixture-upload') {
      uploadedBytes = route.request().postDataBuffer()
      return route.fulfill({ status: 201 })
    }
    if (pathname === '/fixture-publish') {
      publishedFile = new URL(route.request().url()).searchParams.get('name')
      return route.fulfill({ status: 201 })
    }
    if (pathname === '/public/direct') return route.fulfill({ contentType: 'text/html', body: 'Shared screenshot viewer' })
    return route.abort()
  })
  await context.route('https://passport.yandex.ru/**', route => {
    if (new URL(route.request().url()).pathname === '/fixture-signin') {
      signedIn = true
      return route.fulfill({ contentType: 'text/plain', body: 'Signed in' })
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="/fixture-signin">Войти</a>' })
  })
  await context.route(publicUrl, route => route.fulfill({ contentType: 'text/html', body: 'Shared screenshot viewer' }))
  async function wireDiskFixture(popup) {
    const existingTabs = new Set(context.pages())
    await popup.exposeFunction('loadDiskFixture', async url => {
      await expect(() => context.pages().some(tab => !existingTabs.has(tab) && tab.url() === 'about:blank'), 'The test Disk tab did not appear')
      const tab = context.pages().find(tab => !existingTabs.has(tab) && tab.url() === 'about:blank')
      existingTabs.add(tab)
      await tab.goto(url)
    })
    await popup.evaluate(() => {
      window.diskNotifications = []
      chrome.notifications.getPermissionLevel = async () => 'granted'
      chrome.notifications.create = async (id, notification) => { window.diskNotifications.push({ id, notification }); return id }
      const createTab = chrome.tabs.create
      chrome.tabs.create = async options => {
        if (options.url !== 'https://disk.yandex.ru/client/disk') return createTab(options)
        const tab = await createTab({ ...options, url: 'about:blank' })
        await window.loadDiskFixture(options.url)
        return tab
      }
    })
  }
  await wireDiskFixture(captureEditor)
  await captureEditor.locator('#save-disk').click()
  await captureEditor.getByText('Войдите в Яндекс', { exact: true }).first().waitFor()
  assert.equal(captureEditor.isClosed(), false)
  assert.equal(uploadedBytes, undefined)
  await expect(() => captureEditor.evaluate(() => window.diskNotifications[0]?.id === 'kadr-disk-login'), 'Login notification was not created')
  const loginPopupPromise = context.waitForEvent('page')
  await worker.evaluate(() => globalThis.testDiskNoticeClick('kadr-disk-login'))
  const login = await loginPopupPromise
  await login.waitForURL(url => url.hostname === 'passport.yandex.ru')
  assert.equal(new URL(login.url()).searchParams.get('retpath'), diskHome)
  await login.goto(diskLogin)
  await login.getByText('Войти', { exact: true }).click({ timeout: 5000 })
  await login.waitForURL('https://passport.yandex.ru/fixture-signin')
  await login.close()
  await captureEditor.bringToFront()
  await captureEditor.locator('#save-disk').click()
  await captureEditor.getByText('Сохранено на Яндекс Диск', { exact: true }).waitFor({ timeout: 20000 })
  assert.equal(uploadedBytes.subarray(1, 4).toString(), 'PNG')
  assert.match(publishedFile, /^Кадр-.*-[a-f0-9]{8}\.png$/)
  await expect(() => captureEditor.evaluate(url => window.diskNotifications[1]?.id === `kadr-disk:${url}`, publicUrl), 'Success notification is missing its viewer URL')
  const publicPagePromise = context.waitForEvent('page')
  const openedUrl = await worker.evaluate(async url => {
    const create = chrome.tabs.create
    let opened
    chrome.tabs.create = options => { opened = options.url; return create(options) }
    try { await globalThis.testDiskNoticeClick(`kadr-disk:${url}`); return opened }
    finally { chrome.tabs.create = create }
  }, publicUrl)
  assert.equal(openedUrl, publicUrl)
  const publicPage = await publicPagePromise
  await publicPage.close()
  await captureEditor.bringToFront()
  console.log('Disk sign-in notification, editor preservation, retry, upload, publication and notification click passed')

  await captureEditor.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Test Disk clipboard error') } })
  await captureEditor.locator('#disk-copy').click()
  await expect(async () => (await captureEditor.locator('#status').textContent()).startsWith('Не удалось скопировать'), 'Failed link copy closed the editor')
  let copiedLink
  await captureEditor.exposeFunction('recordCopiedLink', text => { copiedLink = text })
  await captureEditor.evaluate(() => { navigator.clipboard.writeText = text => window.recordCopiedLink(text) })
  const closedOnLinkCopy = captureEditor.waitForEvent('close')
  await captureEditor.locator('#disk-copy').click()
  await closedOnLinkCopy
  assert.equal(copiedLink, publicUrl)

  captureEditor = await captureCurrent()
  await wireDiskFixture(captureEditor)
  await captureEditor.locator('#save-disk').click()
  await captureEditor.getByText('Сохранено на Яндекс Диск', { exact: true }).waitFor({ timeout: 20000 })
  await captureEditor.evaluate(() => {
    window.createDiskTab = chrome.tabs.create
    chrome.tabs.create = async () => { throw new Error('Test Disk tab error') }
  })
  await captureEditor.locator('#disk-open').click()
  await expect(async () => (await captureEditor.locator('#status').textContent()).startsWith('Не удалось открыть'), 'Failed link open closed the editor')
  let requestedLink
  await captureEditor.exposeFunction('recordOpenedLink', url => { requestedLink = url })
  await captureEditor.evaluate(() => {
    chrome.tabs.create = async options => {
      await window.recordOpenedLink(options.url)
      return window.createDiskTab(options)
    }
  })
  const openedFromCard = context.waitForEvent('page')
  const closedOnLinkOpen = captureEditor.waitForEvent('close')
  await captureEditor.locator('#disk-open').click()
  await closedOnLinkOpen
  assert.equal(requestedLink, publicUrl)
  await (await openedFromCard).close()
  console.log('Both successful Disk card actions closed the editor; failed actions preserved it')

  captureEditor = await captureCurrent()
  await captureEditor.evaluate(() => {
    const clipboard = new EventTarget()
    clipboard.onclipboardchange = null
    clipboard.write = async () => { window.clipboardAttempts++ }
    window.clipboardAttempts = 0
    Object.defineProperty(navigator, 'clipboard', { value: clipboard })
  })
  await captureEditor.locator('#copy-image').click()
  await expect(async () => (await captureEditor.locator('#status').textContent()).startsWith('Не удалось скопировать снимок'), 'Unconfirmed PNG write closed the editor')
  assert.equal(await captureEditor.evaluate(() => window.clipboardAttempts), 2)

  let bytes = 0
  let attempts = 0
  await captureEditor.exposeFunction('recordPngWrite', size => { bytes = size; attempts++ })
  await captureEditor.evaluate(() => {
    let attempt = 0
    navigator.clipboard.write = async ([item]) => {
      await window.recordPngWrite((await item.getType('image/png')).size)
      if (++attempt !== 2) return
      navigator.clipboard.dispatchEvent(Object.assign(new Event('clipboardchange'), { types: ['image/png'] }))
    }
  })
  const closed = captureEditor.waitForEvent('close')
  await captureEditor.locator('#copy-image').click()
  await closed
  assert.ok(bytes > 1000)
  assert.equal(attempts, 2)
  console.log('Inline picture OCR stayed in the tab, worked offline and followed the viewer and scrolling; screenshot copy still closes the editor')
} catch (error) {
  console.error(errors)
  throw error
} finally {
  await context.close()
  server.close()
  external.close()
}
