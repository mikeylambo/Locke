"""Cut the Meshy torso to an armless jacket and cap every open boundary loop (pure Python, no deps)."""
import json, struct, sys
exec(open(__import__('os').path.join(__import__('os').path.dirname(__file__), 'split.py')).read().split("ref=None")[0])

SRC, DST = sys.argv[1], sys.argv[2]
m = load(SRC)
j, b = m['j'], m['b']
P, I = m['pos'], m['idx']
prim = j['meshes'][0]['primitives'][0]
binstart = 20 + m['l'] + 8
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    return a, binstart + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
na, no = acc(prim['attributes']['NORMAL'])
ua, uo = acc(prim['attributes']['TEXCOORD_0'])
N = [list(struct.unpack_from('<3f', b, no + 12 * k)) for k in range(na['count'])]
UV = [list(struct.unpack_from('<2f', b, uo + 8 * k)) for k in range(ua['count'])]

# 1. keep the jacket band, drop arms (same cut as before)
tris = []
for t in range(0, len(I), 3):
    c = [sum(P[I[t + e]][k] for e in range(3)) / 3 for k in range(3)]
    y, x = c[1], abs(c[0])
    if -0.075 < y < 0.335 and (x < 0.096 or (y > 0.22 and x < 0.128)):
        tris.append((I[t], I[t + 1], I[t + 2]))

# 2. weld coincident verts so seams aren't mistaken for holes
key, weld = {}, {}
for v in set(i for t in tris for i in t):
    q = tuple(round(c, 5) for c in P[v]); weld[v] = key.setdefault(q, v)
W = [tuple(weld[i] for i in t) for t in tris]
W = [t for t in W if len(set(t)) == 3]

# 3. boundary edges = directed edges whose reverse never appears
edges = {}
for a, c, d in W:
    for e in ((a, c), (c, d), (d, a)): edges[e] = edges.get(e, 0) + 1
bnd = {e for e in edges if (e[1], e[0]) not in edges}
nxt = {}
for a, c in bnd: nxt.setdefault(a, []).append(c)

# 4. walk loops
loops, used = [], set()
for a, c in bnd:
    if (a, c) in used: continue
    loop, cur, start = [a], c, a
    used.add((a, c))
    while cur != start and len(loop) < 5000:
        loop.append(cur)
        cand = [n for n in nxt.get(cur, []) if (cur, n) not in used]
        if not cand: break
        used.add((cur, cand[0])); cur = cand[0]
    if cur == start and len(loop) >= 3: loops.append(loop)

# 5. suit-black UV: the darkest texel region we can find among kept faces' UVs is enough —
#    pick the UV of the vertex nearest the jacket's back centre (always black cloth).
from PIL import Image
import io as _io
_img = j['images'][0]; _bv = j['bufferViews'][_img['bufferView']]
_tex = Image.open(_io.BytesIO(bytes(b[binstart + _bv.get('byteOffset', 0): binstart + _bv.get('byteOffset', 0) + _bv['byteLength']]))).convert('L')
def lum(v):
    u, w = UV[v]; return _tex.getpixel((min(_tex.width - 1, max(0, int((u % 1) * _tex.width))), min(_tex.height - 1, max(0, int((w % 1) * _tex.height)))))
cands = sorted(set(v for t in tris for v in t))
darkUV = UV[min(cands, key=lum)]
print('cap texel luminance', lum(min(cands, key=lum)))

newP, newN, newUV, newT = [p[:] for p in P], [n[:] for n in N], [u[:] for u in UV], [list(t) for t in tris]
for loop in loops:
    cx = [sum(P[v][k] for v in loop) / len(loop) for k in range(3)]
    ci = len(newP)
    newP.append(cx); newUV.append(darkUV[:])
    # cap normal: outward from body centre, roughly
    nx = [cx[0], 0.0, cx[2]]; l = max(1e-6, (nx[0] ** 2 + nx[2] ** 2) ** 0.5)
    if cx[1] < -0.06: nx = [0, -1, 0]
    elif cx[1] > 0.32: nx = [0, 1, 0]
    else: nx = [nx[0] / l, 0, nx[2] / l]
    newN.append(nx)
    for k in range(len(loop)):
        a, c = loop[k], loop[(k + 1) % len(loop)]
        newT.append([c, a, ci])   # reverse of boundary direction faces outward

used = sorted(set(i for t in newT for i in t))
remap = {o: k for k, o in enumerate(used)}
umn = [min(newP[i][k] for i in used) for k in range(3)]; umx = [max(newP[i][k] for i in used) for k in range(3)]
cxz = [(umn[0] + umx[0]) / 2, umn[1], (umn[2] + umx[2]) / 2]
newP = [[newP[i][0] - cxz[0], newP[i][1] - cxz[1], newP[i][2] - cxz[2]] for i in used]
newN = [newN[i] for i in used]; newUV = [newUV[i] for i in used]
newT = [[remap[i] for i in t] for t in newT]
print(f"kept {len(W)} tris, capped {len(loops)} holes with {sum(len(l) for l in loops)} tris")

# 6. write a fresh minimal GLB (positions, normals, uvs, indices) reusing the original image
import io
nv = len(newP)
pos_b = b''.join(struct.pack('<3f', *p) for p in newP)
nrm_b = b''.join(struct.pack('<3f', *n) for n in newN)
uv_b = b''.join(struct.pack('<2f', *u) for u in newUV)
idx_b = b''.join(struct.pack('<I', i) for t in newT for i in t)
img = j['images'][0]; ibv = j['bufferViews'][img['bufferView']]
img_b = bytes(b[binstart + ibv.get('byteOffset', 0): binstart + ibv.get('byteOffset', 0) + ibv['byteLength']])
blobs = [pos_b, nrm_b, uv_b, idx_b, img_b]
views, off, binbuf = [], 0, bytearray()
for k, blob in enumerate(blobs):
    while len(binbuf) % 4: binbuf += b'\0'
    v = {"buffer": 0, "byteOffset": len(binbuf), "byteLength": len(blob)}
    if k < 3: v["target"] = 34962
    if k == 3: v["target"] = 34963
    views.append(v); binbuf += blob
while len(binbuf) % 4: binbuf += b'\0'
mn = [min(p[i] for p in newP) for i in range(3)]; mx = [max(p[i] for p in newP) for i in range(3)]
g = {
    "asset": {"version": "2.0", "generator": "locke capfill"},
    "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
    "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1}}],
    "textures": [{"source": 0, "sampler": 0}], "samplers": [{}],
    "images": [{"bufferView": 4, "mimeType": img["mimeType"]}],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": nv, "type": "VEC3", "min": mn, "max": mx},
        {"bufferView": 1, "componentType": 5126, "count": nv, "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": nv, "type": "VEC2"},
        {"bufferView": 3, "componentType": 5125, "count": len(newT) * 3, "type": "SCALAR"}],
    "bufferViews": views, "buffers": [{"byteLength": len(binbuf)}]}
js = json.dumps(g, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binbuf), 0x004E4942) + bytes(binbuf)
open(DST, 'wb').write(out)
print("bounds", [round(x, 3) for x in mn], [round(x, 3) for x in mx], "bytes", len(out))
