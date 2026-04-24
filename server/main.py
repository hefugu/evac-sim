import heapq
import io
import os

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

app = FastAPI()

# -----------------------
#   Directory setup
# -----------------------
BASE = os.path.dirname(__file__)
UPLOAD_DIR = os.path.join(BASE, "../uploads")
CLIENT_DIR = os.path.join(BASE, "../client")
SIM_DIR = os.path.join(BASE, "../sim")
ADMIN_DIR = os.path.join(BASE, "../admin")

os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


# -----------------------
#   In-memory state
# -----------------------
class FloorData:
    def __init__(self):
        self.img_arr = None  # RGB image
        self.mask = None  # 0/1 walkable mask
        self.exits = []  # [(x, y)]
        self.stairs = []  # [(x, y)]
        self.url = None  # /uploads/xxx.png
        self.thr = 200


class World:
    def __init__(self):
        self.floors = {}  # floor -> FloorData
        self.clients = {}  # client_id -> ws
        self.stair_links = {}  # (upper, lower) -> [(ux, uy, dx, dy)]
        self.running = False


world = World()


# -----------------------
#   Utilities
# -----------------------
def img_to_mask(img: Image.Image, thr=200):
    arr = np.array(img.convert("RGB"))
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    mask = np.zeros((arr.shape[0], arr.shape[1]), dtype=np.uint8)
    mask[(r > thr) & (g > thr) & (b > thr)] = 1
    return arr, mask


# -----------------------
#   Path search (8-neighbor Dijkstra)
# -----------------------
DIR8 = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (1, -1), (-1, 1)]


def find_path(mask, start, targets):
    """
    mask: 0/1 walkable mask
    start: (x, y)
    targets: list of destination points (exits or stairs)
    """
    H, W = mask.shape
    sx, sy = start
    if not (0 <= sx < W and 0 <= sy < H):
        return []

    checked = np.zeros((H, W), dtype=bool)
    before = {}
    exits = set(targets)
    pq = [(0.0, (sx, sy))]

    while pq:
        cost, (x, y) = heapq.heappop(pq)
        if checked[y][x]:
            continue
        checked[y][x] = True

        if (x, y) in exits:
            path = []
            cur = (x, y)
            while cur != (sx, sy):
                path.append(cur)
                cur = before[cur]
            path.append((sx, sy))
            return path[::-1]

        for dx, dy in DIR8:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < W and 0 <= ny < H):
                continue
            if checked[ny][nx]:
                continue
            if mask[ny][nx] != 1:
                continue
            step = 1.4 if (dx != 0 and dy != 0) else 1.0
            if (nx, ny) not in before:
                before[(nx, ny)] = (x, y)
            heapq.heappush(pq, (cost + step, (nx, ny)))

    return []


# -----------------------
#   API endpoints
# -----------------------
@app.post("/api/map")
async def upload_map(
    file: UploadFile = File(...), floor: int = Form(...), thr: int = Form(200)
):
    raw = await file.read()
    path = os.path.join(UPLOAD_DIR, file.filename)
    with open(path, "wb") as f:
        f.write(raw)

    img = Image.open(io.BytesIO(raw))
    arr, mask = img_to_mask(img, thr)

    fd = FloorData()
    fd.img_arr = arr
    fd.mask = mask
    fd.thr = thr
    fd.url = f"/uploads/{file.filename}"

    world.floors[floor] = fd

    # Broadcast updated map to connected clients
    for c in list(world.clients.values()):
        try:
            await c.send_json({"type": "map", "floor": floor, "url": fd.url})
        except Exception:
            pass

    return {"ok": True, "floor": floor, "url": fd.url}


@app.post("/api/exits")
async def set_exits(payload: dict):
    f = int(payload["floor"])
    fd = world.floors.setdefault(f, FloorData())
    fd.exits = [(int(p["x"]), int(p["y"])) for p in payload["exits"]]
    return {"ok": True}


@app.post("/api/stairs")
async def set_stairs(payload: dict):
    f = int(payload["floor"])
    fd = world.floors.setdefault(f, FloorData())
    fd.stairs = [(int(p["x"]), int(p["y"])) for p in payload["stairs"]]
    return {"ok": True}


@app.post("/api/stair_link")
async def stair_link(payload: dict):
    upper = int(payload["upper"])
    lower = int(payload["lower"])
    arr = []
    for p in payload["pairs"]:
        ux, uy = int(p["up"]["x"]), int(p["up"]["y"])
        dx, dy = int(p["down"]["x"]), int(p["down"]["y"])
        arr.append((ux, uy, dx, dy))
    world.stair_links[(upper, lower)] = arr
    return {"ok": True}


@app.post("/api/evac")
async def evac(payload: dict):
    st = payload["status"]
    world.running = st == "start"
    for ws in list(world.clients.values()):
        try:
            await ws.send_json({"type": "evac", "status": st})
        except Exception:
            pass
    return {"ok": True}


@app.post("/api/reset")
async def reset_world():
    world.floors.clear()
    world.stair_links.clear()
    world.running = False

    for ws in list(world.clients.values()):
        try:
            await ws.send_json({"type": "reset"})
        except Exception:
            pass

    return {"ok": True}


# -----------------------
# WebSocket route
# -----------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    cid = None

    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")

            # Initial registration
            if t == "hello":
                cid = msg["client_id"]
                world.clients[cid] = ws

                # Send already uploaded maps to a new client
                for f, fd in world.floors.items():
                    if fd.url:
                        await ws.send_json({"type": "map", "floor": f, "url": fd.url})

            # Position update and route computation
            elif t == "pos":
                floor = int(msg["floor"])
                x = int(msg["x"])
                y = int(msg["y"])

                cur_floor = floor
                cur_point = (x, y)
                routes = []

                # Continue until this floor can reach exits or lower floors.
                while True:
                    fd = world.floors.get(cur_floor)
                    if not fd:
                        break

                    # If exits exist on this floor, route there and finish.
                    if fd.exits:
                        path = find_path(fd.mask, cur_point, fd.exits)
                        if path:
                            routes.append({"floor": cur_floor, "points": path})
                        break

                    # Otherwise try stairs down to lower floor.
                    if cur_floor - 1 in world.floors and fd.stairs:
                        sx, sy = fd.stairs[0]
                        p1 = find_path(fd.mask, cur_point, [(sx, sy)])
                        if not p1:
                            break
                        routes.append({"floor": cur_floor, "points": p1})

                        link = world.stair_links.get((cur_floor, cur_floor - 1))
                        if not link:
                            break
                        dx, dy = link[0][2], link[0][3]
                        cur_floor -= 1
                        cur_point = (dx, dy)
                        continue

                    break

                await ws.send_json({"type": "route_full", "routes": routes})

    except WebSocketDisconnect:
        pass
    finally:
        if cid in world.clients:
            del world.clients[cid]


# -----------------------
# Static page routes
# -----------------------
@app.get("/")
def root():
    return FileResponse(os.path.join(CLIENT_DIR, "index.html"))


@app.get("/admin")
def admin():
    return FileResponse(os.path.join(ADMIN_DIR, "index.html"))


@app.get("/sim")
def sim():
    return FileResponse(os.path.join(SIM_DIR, "index.html"))


@app.get("/sim/")
def sim_slash():
    return FileResponse(os.path.join(SIM_DIR, "index.html"))


@app.get("/sim/styles.css")
def sim_styles():
    return FileResponse(os.path.join(SIM_DIR, "styles.css"), media_type="text/css")


@app.get("/sim/simulation.js")
def sim_script():
    return FileResponse(
        os.path.join(SIM_DIR, "simulation.js"), media_type="application/javascript"
    )


# -----------------------
# Main
# -----------------------
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
