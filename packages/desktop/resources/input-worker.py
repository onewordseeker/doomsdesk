#!/usr/bin/env python3
# macOS input injection — reads JSON from stdin, injects via CoreGraphics
import sys, json, ctypes

CG = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]

CG.CGEventCreateMouseEvent.restype = ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
CG.CGEventPost.restype = None
CG.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
CG.CFRelease.restype = None
CG.CFRelease.argtypes = [ctypes.c_void_p]
CG.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
CG.CGEventCreateScrollWheelEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32]
CG.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
CG.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
CG.CGEventSetFlags.restype = None
CG.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]

kHID = 0
kMoved=5; kLD=1; kLU=2; kRD=3; kRU=4; kMD=25; kMU=26
kBL=0; kBR=1; kBM=2
kShift=0x00020000; kCtrl=0x00040000; kAlt=0x00080000; kCmd=0x00100000

KEYS = {
    'a':0,'s':1,'d':2,'f':3,'h':4,'g':5,'z':6,'x':7,'c':8,'v':9,'b':11,
    'q':12,'w':13,'e':14,'r':15,'y':16,'t':17,'1':18,'2':19,'3':20,'4':21,
    '6':22,'5':23,'=':24,'9':25,'7':26,'-':27,'8':28,'0':29,']':30,'o':31,
    'u':32,'[':33,'i':34,'p':35,'l':37,'j':38,"'":39,'k':40,';':41,'\\':42,
    ',':43,'/':44,'n':45,'m':46,'.':47,'`':50,
    'Enter':36,'Tab':48,' ':49,'Backspace':51,'Escape':53,'Delete':117,
    'Meta':55,'Shift':56,'CapsLock':57,'Alt':58,'Control':59,
    'ArrowRight':124,'ArrowLeft':123,'ArrowDown':125,'ArrowUp':126,
    'Home':115,'End':119,'PageUp':116,'PageDown':121,
    'F1':122,'F2':120,'F3':99,'F4':118,'F5':96,'F6':97,
    'F7':98,'F8':100,'F9':101,'F10':109,'F11':103,'F12':111,
}

def pm(et, x, y, btn):
    e = CG.CGEventCreateMouseEvent(None, et, CGPoint(x=float(x),y=float(y)), btn)
    if e:
        CG.CGEventPost(kHID, e)
        CG.CFRelease(e)

def pk(kc, down, flags=0):
    e = CG.CGEventCreateKeyboardEvent(None, kc, bool(down))
    if e:
        if flags: CG.CGEventSetFlags(e, flags)
        CG.CGEventPost(kHID, e)
        CG.CFRelease(e)

sys.stdout.write('READY\n')
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        t = ev.get('type','')
        x = ev.get('x',0); y = ev.get('y',0)
        btn = ev.get('button','left')
        mods = ev.get('modifiers') or {}
        key = ev.get('key','')

        if t == 'mousemove':
            pm(kMoved, x, y, kBL)
        elif t in ('mousedown','click'):
            ic = t == 'click'
            if btn == 'right':
                pm(kRD, x, y, kBR)
                if ic: pm(kRU, x, y, kBR)
            elif btn == 'middle':
                pm(kMD, x, y, kBM)
                if ic: pm(kMU, x, y, kBM)
            else:
                pm(kLD, x, y, kBL)
                if ic: pm(kLU, x, y, kBL)
        elif t == 'mouseup':
            if btn == 'right': pm(kRU, x, y, kBR)
            elif btn == 'middle': pm(kMU, x, y, kBM)
            else: pm(kLU, x, y, kBL)
        elif t == 'wheel':
            dy = int(-ev.get('deltaY',0) / 5)
            if dy:
                e = CG.CGEventCreateScrollWheelEvent(None, 0, 1, dy)
                if e:
                    CG.CGEventPost(kHID, e)
                    CG.CFRelease(e)
        elif t == 'set_display_resolution':
            w = ev.get('width', 0); h = ev.get('height', 0)
            if w and h:
                try:
                    import subprocess
                    subprocess.Popen(
                        ['displayplacer', f'res:{w}x{h}', 'scaling:off'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                except: pass
        elif t in ('keydown','keyup'):
            kc = KEYS.get(key) or KEYS.get(key.lower())
            if kc is not None:
                fl = 0
                if mods.get('shift') or (len(key)==1 and key.isupper()): fl |= kShift
                if mods.get('ctrl'):  fl |= kCtrl
                if mods.get('alt'):   fl |= kAlt
                if mods.get('meta'):  fl |= kCmd
                pk(kc, t=='keydown', fl)
    except: pass
