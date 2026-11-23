globalThis.kadrShowWords = function showWords(layer, blocks, context) {
  const { width, height } = context.canvas
  const measure = document.createElement('canvas').getContext('2d')
  const fragment = document.createDocumentFragment()
  context.save()
  context.fillStyle = '#18202a44'
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-out'
  context.fillStyle = '#000'
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const row = document.createElement('div')
        row.className = 'ocr-line'
        row.style.top = `${line.bbox.y0 / height * 100}%`
        const fontSize = Math.max(1, line.bbox.y1 - line.bbox.y0)
        row.style.fontSize = `${fontSize / width * 100}cqw`
        measure.font = `${fontSize}px 'Segoe UI', sans-serif`
        const { x0, x1, y0, y1 } = line.bbox
        context.beginPath()
        context.roundRect(x0 - 4, y0 - 3, x1 - x0 + 8, y1 - y0 + 6, 4)
        context.fill()
        let previousRight = 0
        for (const word of line.words) {
          if (row.childNodes.length) {
            const space = document.createElement('span')
            space.className = 'ocr-space'
            space.textContent = ' '
            row.append(space)
          }
          const span = document.createElement('span')
          span.className = 'ocr-word'
          span.style.marginLeft = `${(word.bbox.x0 - previousRight) / width * 100}%`
          span.style.width = `${(word.bbox.x1 - word.bbox.x0) / width * 100}%`
          if (word.symbols?.map(symbol => symbol.text).join('') === word.text) {
            word.symbols.forEach((symbol, index) => {
              const character = document.createElement('span')
              character.className = 'ocr-character'
              character.textContent = symbol.text
              const nextLeft = word.symbols[index + 1]?.bbox.x0 ?? word.bbox.x1
              const spacing = Math.max(1, nextLeft - symbol.bbox.x0) - measure.measureText(symbol.text).width
              character.style.letterSpacing = `${spacing / width * 100}cqw`
              span.append(character)
            })
          } else span.textContent = word.text
          row.append(span)
          previousRight = word.bbox.x1
        }
        fragment.append(row)
      }
    }
  }
  context.restore()
  layer.replaceChildren(fragment)
}
