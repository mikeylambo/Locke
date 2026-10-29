import json,struct,sys
def load(path):
  b=bytearray(open(path,'rb').read()); l=struct.unpack('<I',b[12:16])[0]; j=json.loads(b[20:20+l]); bs=20+l+8
  p=j['meshes'][0]['primitives'][0]
  def acc(i):
    a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]; return a,bs+bv.get('byteOffset',0)+a.get('byteOffset',0)
  pa,po=acc(p['attributes']['POSITION']); ia,io=acc(p['indices'])
  fmt={5123:'H',5125:'I'}[ia['componentType']]
  pos=[list(struct.unpack_from('<3f',b,po+12*k)) for k in range(pa['count'])]
  idx=list(struct.unpack_from('<%d%s'%(ia['count'],fmt),b,io))
  return dict(b=b,j=j,l=l,pa=pa,po=po,ia=ia,io=io,fmt=fmt,pos=pos,idx=idx)
def comps(m):
  pos,idx=m['pos'],m['idx']; par=list(range(len(pos)))
  def f(x):
    while par[x]!=x: par[x]=par[par[x]]; x=par[x]
    return x
  key={}
  for k,v in enumerate(pos):
    q=tuple(round(c,4) for c in v)
    if q in key: par[f(k)]=f(key[q])
    else: key[q]=k
  for t in range(0,len(idx),3):
    a,c,d=idx[t:t+3]; par[f(a)]=f(c); par[f(c)]=f(d)
  cs={}
  for t in range(0,len(idx),3): cs.setdefault(f(idx[t]),[]).append(t)
  out=[]
  for ts in cs.values():
    vs=[pos[idx[t+e]] for t in ts for e in range(3)]
    out.append(dict(ts=ts,mn=[min(v[i] for v in vs) for i in range(3)],mx=[max(v[i] for v in vs) for i in range(3)]))
  return out
def classify(m):
  cs=comps(m); top=max(c['mx'][1] for c in cs)
  # hat: big part reaching the top
  hat=max((c for c in cs if c['mx'][1]>top-0.02), key=lambda c:len(c['ts']))
  smoke=[c for c in cs if c is not hat and min(c['mx'][i]-c['mn'][i] for i in range(3))<0.04 and len(c['ts'])<600 and c['mn'][0]>0.2]
  return cs,hat,smoke
def save(m,path,keep):
  b=bytearray(m['b']); isz=struct.calcsize(m['fmt'])
  for t in range(0,len(m['idx']),3):
    if t not in keep:
      for e in range(3): struct.pack_into('<'+m['fmt'],b,m['io']+(t+e)*isz,m['idx'][t])
  for k,v in enumerate(m['pos']): struct.pack_into('<3f',b,m['po']+12*k,*v)
  # refresh POSITION min/max so three.js bounds are right
  live=set(m['idx'][t+e] for t in keep for e in range(3))
  vs=[m['pos'][k] for k in live]
  j=m['j']; a=j['accessors'][j['meshes'][0]['primitives'][0]['attributes']['POSITION']]
  a['min']=[min(v[i] for v in vs) for i in range(3)]; a['max']=[max(v[i] for v in vs) for i in range(3)]
  js=json.dumps(j,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4)
  assert len(js)<=m['l'], 'json grew'
  js+=b' '*(m['l']-len(js)); b[20:20+m['l']]=js
  open(path,'wb').write(b)

ref=None
for name in ['head','grin','surprised']:
  m=load(f'meshy_output/{name}/model.glb'); cs,hat,smoke=classify(m)
  # anchor: centre of the hat brim's underside; scale: hat width
  cx=(hat['mn'][0]+hat['mx'][0])/2; cz=(hat['mn'][2]+hat['mx'][2])/2; by=hat['mn'][1]; wid=hat['mx'][0]-hat['mn'][0]
  if ref is None: ref=wid
  s=ref/wid
  m['pos']=[[(v[0]-cx)*s,(v[1]-by)*s,(v[2]-cz)*s] for v in m['pos']]
  drop=set(t for c in [hat]+smoke for t in c['ts'])
  allt=set(range(0,len(m['idx']),3))
  out={'head':'cool','grin':'grin','surprised':'surprised'}[name]
  save(m,f'public/models/locke/bust-{out}.glb',allt-drop)
  print(out,'hat tris',len(hat['ts']),'smoke',sum(len(c['ts']) for c in smoke),'scale',round(s,3))
  if name=='head': save(m,'public/models/locke/hat.glb',set(hat['ts']))
