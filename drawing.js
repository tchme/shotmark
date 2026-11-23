export function rectangle(start, end) {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    w: Math.abs(start.x - end.x), h: Math.abs(start.y - end.y)
  }
}

function copyArea(canvas, { x, y, w, h }) {
  const copy = document.createElement('canvas')
  copy.width = w
  copy.height = h
  copy.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h)
  return copy
}

export function cropBitmap(bitmap, region) {
  const [left, top, right, bottom] = region
  const start = { x: Math.round(left * bitmap.width), y: Math.round(top * bitmap.height) }
  const end = { x: Math.round(right * bitmap.width), y: Math.round(bottom * bitmap.height) }
  const { x, y, w, h } = rectangle(start, end)
  return createImageBitmap(bitmap, x, y, Math.max(1, w), Math.max(1, h))
}

function arrow(context, { from, to, size, style }) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const length = Math.min(distance * .44, Math.max(size * 3.6, 12))
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const bend = style === 'curved' ? Math.min(distance * .40, Math.max(size * 14, 24)) : 0
  const headAngle = Math.atan2(bend, distance * .52)
  const join = style === 'open' ? 0 : length * .77
  const endX = -join * Math.cos(headAngle)
  const endY = -join * Math.sin(headAngle)
  context.translate(to.x, to.y)
  context.rotate(angle)
  context.beginPath()
  if (style === 'tapered') {
    const headLength = Math.min(distance * .4, Math.max(size * 4.8, distance * .1, 12))
    const shoulder = headLength * .58
    const neck = shoulder * .49
    const joinX = -headLength * .89
    context.moveTo(-distance, 0)
    context.quadraticCurveTo(-distance * .57, -neck * .31, joinX, -neck)
    context.lineTo(-headLength, -shoulder)
    context.lineTo(0, 0)
    context.lineTo(-headLength, shoulder)
    context.lineTo(joinX, neck)
    context.quadraticCurveTo(-distance * .57, neck * .31, -distance, 0)
    context.fill()
    return
  }
  if (style === 'dashed') context.setLineDash([size * 2, size * 1.65])
  context.moveTo(-distance + (style === 'double' ? join : 0), 0)
  if (bend) context.quadraticCurveTo(-distance * .52, -bend, endX, endY)
  else context.lineTo(endX, 0)
  context.stroke()
  context.setLineDash([])
  function head(x, rotation) {
    context.save()
    context.translate(x, 0)
    context.rotate(rotation)
    context.beginPath()
    context.moveTo(-length, -length * .50)
    context.lineTo(0, 0)
    context.lineTo(-length, length * .50)
    if (style === 'open') context.stroke()
    else {
      context.lineTo(-length * .74, 0)
      context.fill()
    }
    context.restore()
  }
  head(0, headAngle)
  if (style === 'double') head(-distance, Math.PI)
}

export function labelMetrics(size, color) {
  const fontSize = size * 3 + 10
  return {
    font: `650 ${fontSize}px Segoe UI, sans-serif`,
    lineHeight: Math.ceil(fontSize * 1.22),
    outline: color === '#191e26' ? '#f7faff' : '#151c24'
  }
}

const graphemes = new Intl.Segmenter()

function* wrapLine(context, paragraph, width) {
  let line = ''
  for (const token of paragraph.match(/\s+|\S+/gu) || []) {
    if (line && context.measureText(line + token).width > width) {
      yield line.trimEnd()
      line = ''
      if (!token.trim()) continue
    }
    if (context.measureText(token).width <= width) line += token
    else {
      for (const { segment } of graphemes.segment(token)) {
        if (line && context.measureText(line + segment).width > width) {
          yield line
          line = ''
        }
        line += segment
      }
    }
  }
  yield line.trimEnd()
}

function label(context, { from, width, text, size, color }) {
  const { x, y } = from
  const { font, lineHeight, outline } = labelMetrics(size, color)
  context.font = font
  context.textBaseline = 'alphabetic'
  context.strokeStyle = outline
  context.lineWidth = 2
  context.beginPath()
  context.rect(x, y, width, context.canvas.height - y)
  context.clip()
  const { fontBoundingBoxAscent, fontBoundingBoxDescent } = context.measureText('Aa')
  let baseline = y + 1 + (lineHeight + fontBoundingBoxAscent - fontBoundingBoxDescent) / 2
  for (const paragraph of text.split('\n')) {
    for (const line of wrapLine(context, paragraph, Math.max(1, width - 4))) {
      if (baseline - fontBoundingBoxAscent >= context.canvas.height) return
      context.strokeText(line, x + 2, baseline)
      context.fillText(line, x + 2, baseline)
      baseline += lineHeight
    }
  }
}

function selection(context, { x, y, w, h }) {
  context.fillStyle = '#6694833c'
  context.strokeStyle = '#9aecd4'
  context.lineWidth = 2
  context.setLineDash([6, 4])
  context.fillRect(x, y, w, h)
  context.strokeRect(x, y, w, h)
}

function marker(context, { points, size }) {
  context.globalAlpha = .4
  context.lineWidth = size * 3
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (const { x, y } of points) context.lineTo(x, y)
  if (points.length > 1) context.stroke()
  else {
    context.arc(points[0].x, points[0].y, context.lineWidth / 2, 0, 2 * Math.PI)
    context.fill()
  }
}

function blur(context, { x, y, w, h }, radius) {
  const { canvas } = context
  const padding = radius * 3
  const left = Math.max(0, x - padding)
  const top = Math.max(0, y - padding)
  const patch = copyArea(canvas, {
    x: left, y: top,
    w: Math.min(canvas.width, x + w + padding) - left,
    h: Math.min(canvas.height, y + h + padding) - top
  })
  context.beginPath()
  context.rect(x, y, w, h)
  context.clip()
  context.filter = `blur(${radius}px)`
  context.drawImage(patch, left, top)
}

function pixelate(context, { x, y, w, h }, size) {
  if (!w || !h) return
  const image = context.getImageData(x, y, w, h)
  const { data } = image
  for (let top = 0; top < h; top += size) {
    const bottom = Math.min(h, top + size)
    for (let left = 0; left < w; left += size) {
      const right = Math.min(w, left + size)
      let red = 0
      let green = 0
      let blue = 0
      for (let row = top; row < bottom; row++) {
        for (let i = (row * w + left) * 4; i < (row * w + right) * 4; i += 4) {
          red += data[i]
          green += data[i + 1]
          blue += data[i + 2]
        }
      }
      const pixels = (bottom - top) * (right - left)
      red = Math.round(red / pixels)
      green = Math.round(green / pixels)
      blue = Math.round(blue / pixels)
      for (let row = top; row < bottom; row++) {
        for (let i = (row * w + left) * 4; i < (row * w + right) * 4; i += 4) {
          data[i] = red
          data[i + 1] = green
          data[i + 2] = blue
          data[i + 3] = 255
        }
      }
    }
  }
  context.putImageData(image, x, y)
}

const polygons = {
  triangle: [[.5, 0], [1, 1], [0, 1]],
  diamond: [[.5, 0], [1, .5], [.5, 1], [0, .5]],
  hexagon: [[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]],
  star: Array.from({ length: 10 }, (_, index) => {
    const angle = index * Math.PI / 5 - Math.PI / 2
    const radius = index % 2 === 0 ? .5 : .22
    return [.5 + radius * Math.cos(angle), .5 + radius * Math.sin(angle)]
  })
}

function shape(context, { x, y, w, h }, style) {
  context.beginPath()
  if (style === 'ellipse') context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI)
  else if (style === 'rounded') context.roundRect(x, y, w, h, Math.min(w, h) * .22)
  else if (polygons[style]) {
    for (const [dx, dy] of polygons[style]) context.lineTo(x + w * dx, y + h * dy)
    context.closePath()
  } else context.rect(x, y, w, h)
  context.stroke()
}

export function draw(context, operation, preview = false) {
  const { tool, from, to, style, color, size } = operation
  const area = rectangle(from, to)
  const { x, y, w, h } = area
  if (tool === 'crop' && !preview) {
    const copy = copyArea(context.canvas, area)
    context.canvas.width = w
    context.canvas.height = h
    context.drawImage(copy, 0, 0)
    return
  }
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = size
  context.lineCap = 'round'
  context.lineJoin = 'round'

  switch (tool) {
    case 'arrow':
      if (w || h) arrow(context, operation)
      break
    case 'shape':
      shape(context, area, style)
      break
    case 'text':
      if (preview) selection(context, area)
      else label(context, operation)
      break
    case 'pen':
      marker(context, operation)
      break
    case 'crop':
    case 'hide':
      if (style === 'solid') {
        context.fillStyle = '#141923'
        context.fillRect(x, y, w, h)
      } else if (preview) selection(context, area)
      else if (style === 'pixelate') pixelate(context, area, size * 2)
      else blur(context, area, size * 2)
      break
  }
  context.restore()
}
