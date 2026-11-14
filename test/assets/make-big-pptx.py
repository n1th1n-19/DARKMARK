# Generates test/assets/big.pptx (~20 MB, 40 slides of noise images) for the slides memory check.
# Needs python-pptx (pip install python-pptx). Run from the repo root: python3 test/assets/make-big-pptx.py test/assets/big.pptx
import os, io, zlib, struct, sys
from pptx import Presentation
from pptx.util import Inches, Pt
def png(w,h):
    raw=b''.join(b'\x00'+os.urandom(w*3) for _ in range(h))
    def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,1))+ch(b'IEND',b'')
p=Presentation()
for i in range(40):
    s=p.slides.add_slide(p.slide_layouts[5])
    s.shapes.title.text=f'Slide {i+1}'
    s.shapes.add_picture(io.BytesIO(png(420,400)),Inches(1),Inches(1.6),Inches(5))
    s.notes_slide.notes_text_frame.text=f'Notes for slide {i+1}'
p.save(sys.argv[1])
