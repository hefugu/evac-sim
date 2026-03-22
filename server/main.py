import uvicorn, io, os, heapq
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
import numpy as np

app = FastAPI()

# -----------------------
#   ディレクトリ設定
# -----------------------
BASE = os.path.dirname(__file__)
UPLOAD_DIR = os.path.join(BASE, "../uploads")
CLIENT_DIR = os.path.join(BASE, "../client")
SIM_DIR    = os.path.join(BASE, "../sim")
ADMIN_DIR  = os.path.join(BASE, "../admin")

os.makedirs(UPLOAD_DIR, exist_ok=True)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# -----------------------
#   データ構造
# -----------------------
class FloorData:
    def __init__(self):
        self.img_arr = None      # RGB画像
        self.mask = None         # 0/1 の通行可能マスク
        self.exits = []          # [(x,y)]
        self.stairs = []         # [(x,y)]
        self.url = None          # /uploads/xxx.png
        self.thr = 200

class World:
    def __init__(self):
        self.floors = {}                      # floor → FloorData
        self.clients = {}                     # client_id → ws
        self.stair_links = {}                 # (upper,lower) → [ (ux,uy,dx,dy) ]
        self.running = False

world = World()

# -----------------------
#   マップ処理
# -----------------------
def img_to_mask(img: Image.Image, thr=200):
    arr = np.array(img.convert("RGB"))
    r,g,b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    mask = np.zeros((arr.shape[0],arr.shape[1]), dtype=np.uint8)
    mask[(r>thr)&(g>thr)&(b>thr)] = 1
    return arr, mask

# -----------------------
#   経路探索（A* / Dijkstra）
# -----------------------
DIR8 = [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,1),(1,-1),(-1,1)]

def find_path(mask, start, targets):
    """
    mask: 0/1マップ
    start: (x,y)
    targets: [(x,y)] 出口 or 階段
    """
    H,W = mask.shape
    sx,sy = start
    if not (0 <= sx < W and 0 <= sy < H):
        return []

    checked = np.zeros((H,W), dtype=bool)
    before = {}

    exits = set(targets)
    pq = [(0.0,(sx,sy))]

    while pq:
        cost,(x,y) = heapq.heappop(pq)
        if checked[y][x]: continue
        checked[y][x] = True

        if (x,y) in exits:
            # ゴール → パス復元
            path=[]
            cur=(x,y)
            while cur!=(sx,sy):
                path.append(cur)
                cur = before[cur]
            path.append((sx,sy))
            return path[::-1]

        for dx,dy in DIR8:
            nx,ny=x+dx,y+dy
            if not (0<=nx<W and 0<=ny<H): continue
            if checked[ny][nx]: continue
            if mask[ny][nx] != 1: continue
            step = 1.4 if (dx!=0 and dy!=0) else 1.0
            if (nx,ny) not in before:
                before[(nx,ny)] = (x,y)
            heapq.heappush(pq,(cost+step,(nx,ny)))

    return []


# -----------------------
#  API: マップアップロード
# -----------------------
@app.post("/api/map")
async def upload_map(file: UploadFile = File(...), floor: int = Form(...), thr: int = Form(200)):
    raw = await file.read()
    path = os.path.join(UPLOAD_DIR, file.filename)
    with open(path,"wb") as f:
        f.write(raw)

    img = Image.open(io.BytesIO(raw))
    arr, mask = img_to_mask(img, thr)

    fd = FloorData()
    fd.img_arr = arr
    fd.mask = mask
    fd.thr = thr
    fd.url = f"/uploads/{file.filename}"

    world.floors[floor] = fd

    # すでに接続中のクライアントへ通知
    for c in list(world.clients.values()):
        try:
            await c.send_json({"type":"map","floor":floor,"url":fd.url})
        except:
            pass

    return {"ok":True, "floor":floor, "url":fd.url}


@app.post("/api/exits")
async def set_exits(payload: dict):
    f = int(payload["floor"])
    fd = world.floors.setdefault(f, FloorData())
    fd.exits = [(int(p["x"]),int(p["y"])) for p in payload["exits"]]
    return {"ok":True}


@app.post("/api/stairs")
async def set_stairs(payload: dict):
    f = int(payload["floor"])
    fd = world.floors.setdefault(f, FloorData())
    fd.stairs = [(int(p["x"]),int(p["y"])) for p in payload["stairs"]]
    return {"ok":True}


@app.post("/api/stair_link")
async def stair_link(payload: dict):
    upper = int(payload["upper"])
    lower = int(payload["lower"])
    arr = []
    for p in payload["pairs"]:
        ux,uy = int(p["up"]["x"]), int(p["up"]["y"])
        dx,dy = int(p["down"]["x"]), int(p["down"]["y"])
        arr.append((ux,uy,dx,dy))
    world.stair_links[(upper,lower)] = arr
    return {"ok":True}


@app.post("/api/evac")
async def evac(payload: dict):
    st = payload["status"]
    world.running = (st == "start")
    for ws in list(world.clients.values()):
        try:
            await ws.send_json({"type":"evac","status":st})
        except:
            pass
    return {"ok":True}

@app.post("/api/reset")
async def reset_world():
    # --- サーバー状態リセット ---
    world.floors.clear()
    world.stair_links.clear()
    world.running = False

    # --- クライアントに通知 ---
    for ws in list(world.clients.values()):
        try:
            await ws.send_json({"type": "reset"})
        except:
            pass

    return {"ok": True}


# -----------------------
# WebSocket: 経路計算
# -----------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    cid = None

    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")

            # 初回接続
            if t == "hello":
                cid = msg["client_id"]
                world.clients[cid] = ws

                # すでに登録済みのマップ全部送る
                for f,fd in world.floors.items():
                    if fd.url:
                        await ws.send_json({"type":"map","floor":f,"url":fd.url})

            # 経路要求
            elif t == "pos":
                floor = int(msg["floor"])
                x = int(msg["x"])
                y = int(msg["y"])

                cur_floor = floor
                cur_point = (x,y)

                routes = []

                # 下の階に降りながら出口まで行く
                while True:
                    fd = world.floors.get(cur_floor)
                    if not fd: break

                    # この階に出口がある → そこへ最短
                    if fd.exits:
                        path = find_path(fd.mask, cur_point, fd.exits)
                        if path:
                            routes.append({"floor":cur_floor,"points":path})
                        break

                    # 階段を使う → 次の階へ
                    if cur_floor - 1 in world.floors and fd.stairs:
                        sx,sy = fd.stairs[0]
                        p1 = find_path(fd.mask, cur_point, [(sx,sy)])
                        if not p1:
                            break
                        routes.append({"floor":cur_floor,"points":p1})

                        link = world.stair_links.get((cur_floor,cur_floor-1))
                        if not link:
                            break
                        dx,dy = link[0][2], link[0][3]
                        cur_floor -= 1
                        cur_point = (dx,dy)
                        continue

                    break

                await ws.send_json({"type":"route_full","routes":routes})

    except WebSocketDisconnect:
        pass
    finally:
        if cid in world.clients:
            del world.clients[cid]


# -----------------------
# 静的ファイル
# -----------------------
@app.get("/")
def root():
    return FileResponse(os.path.join(CLIENT_DIR,"index.html"))

@app.get("/admin")
def admin():
    return FileResponse(os.path.join(ADMIN_DIR,"index.html"))

@app.get("/sim")
def sim():
    return FileResponse(os.path.join(SIM_DIR,"index.html"))

@app.post("/api/reset")
async def reset_world():
    # --- サーバー状態のリセット ---
    world.floors.clear()
    world.stair_links.clear()
    world.running = False

# -----------------------
# メイン起動
# -----------------------
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
