// Run on macOS from the project root: pnpm run symbols
// Renders Apple's installed SF Symbols through AppKit, without third-party icon packages.
// The PNGs are build output and stay out of Git: Apple's terms apply to them, not this repository's license.
import AppKit

let symbols = ["arrow.counterclockwise", "arrow.down", "arrow.left", "arrow.up.right", "chevron.down", "checkmark", "checkmark.circle", "checkmark.circle.fill", "doc.on.doc", "arrow.down.to.line", "doc.text", "keyboard", "link", "magnifyingglass", "mic", "mic.fill", "pause", "pause.fill", "play", "play.fill", "plus", "checkmark.shield", "speaker.wave.3", "square", "square.fill", "square.grid.2x2", "captions.bubble", "exclamationmark.circle", "xmark", "play.rectangle", "folder", "trash", "clock", "ellipsis", "arrow.right", "info.circle", "pencil", "pip", "exclamationmark.triangle", "lock", "arrow.uturn.backward", "accessibility", "phone.fill"]
// Filled glyphs for the sidebar tiles, larger and on a canvas of their own.
let tiles = ["house.fill", "clock.fill", "character.book.closed.fill.he", "gearshape.fill"]
let output = URL(fileURLWithPath: "src/renderer/assets/sf-symbols", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func configured(_ names: [String], pointSize: CGFloat) -> [(String, NSImage)] {
    names.map { name in
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil),
              let image = symbol.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium).applying(.init(paletteColors: [.white]))) else {
            fatalError("Missing SF Symbol: \(name)")
        }
        return (name, image)
    }
}

func write(_ name: String, _ image: NSImage, pixels: Int, scale: CGFloat) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let size = image.size, canvas = CGFloat(pixels)
    let rect = NSRect(x: (canvas-size.width*scale)/2, y: (canvas-size.height*scale)/2, width: size.width*scale, height: size.height*scale)
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("\(name).png"))
}

// One scale for the whole set keeps Apple's optical sizes: an xmark stays lighter than a folder.
let icons = configured(symbols, pointSize: 20)
let largest = icons.map { max($0.1.size.width, $0.1.size.height) }.max()!
for (name, image) in icons { try write(name, image, pixels: 128, scale: 124 / largest) }
for (name, image) in configured(tiles, pointSize: 72) { try write(name, image, pixels: 192, scale: 2) }
print("Exported \(symbols.count + tiles.count) SF Symbols")
