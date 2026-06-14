import asyncio
import websockets
import json

async def test():
    uri = "ws://127.0.0.1:8000/ws/editor"
    async with websockets.connect(uri) as websocket:
        print("Connected to WebSocket")
        
        # 1. Link session
        video_id = "video_1781412623"
        await websocket.send(json.dumps({
            "action": "set_video_id",
            "video_id": video_id
        }))
        print("Sent set_video_id")
        
        # Wait for video loaded message
        resp = await websocket.recv()
        print("Received:", resp)
        
        # 2. Send click
        await websocket.send(json.dumps({
            "action": "click",
            "type": "box",
            "coords": [0.4, 0.4, 0.6, 0.6],
            "frame_idx": 0
        }))
        print("Sent click box")
        
        resp = await websocket.recv()
        print("Received mask response:", len(resp), "bytes")
        
        # 3. Send track
        await websocket.send(json.dumps({
            "action": "track_forward",
            "video_id": video_id,
            "total_frames": 10
        }))
        print("Sent track_forward")
        
        try:
            while True:
                resp = await websocket.recv()
                data = json.loads(resp)
                print("Track update raw:", data)
                if data.get("status") in ["completed", "error", "cancelled"]:
                    break
        except Exception as e:
            print("Done or error:", e)

if __name__ == "__main__":
    asyncio.run(test())
