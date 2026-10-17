"""Generate deterministic adversarial PNG fixtures (no providers or network).
The checked-in 2x2 JPEG is a static sips conversion of pixel.png; retain its
pinned bytes rather than regenerating it with a different OS JPEG encoder.
"""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).parent

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))

def header(width, height):
    return chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))

signature = b'\x89PNG\r\n\x1a\n'
data = chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\x00\xff\x00' * 2))
end = chunk(b'IEND', b'')
pixel = signature + header(2, 2) + data + end
fixtures = {
    'pixel.png': pixel,
    'huge.png': signature + header(100000, 2) + data + end,
    'animated.png': signature + header(2, 2) + chunk(b'acTL', struct.pack('>II', 2, 0)) + data + end,
    'malformed.png': signature + header(2, 2) + chunk(b'IDAT', b'invalid') + end,
    'crc.png': pixel[:-1] + bytes([pixel[-1] ^ 1]),
    'inflate.png': pixel[:33] + chunk(b'IDAT', zlib.compress(bytes(100000))) + end,
    'vector.svg': b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    'animated.gif': b'GIF89a\x02\x00\x02\x00',
}
for name, body in fixtures.items():
    (ROOT / name).write_bytes(body)
