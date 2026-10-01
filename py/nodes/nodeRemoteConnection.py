import json
import tempfile
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps
from comfy_api.latest import io


class PhotoshopConnections(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="🔹 Photoshop RemoteConnection",
            display_name="🔹Photoshop 远程连接（无需插件）",
            category="Photoshop",
            inputs=[
                io.Boolean.Input("Selection_To_Mask", display_name="选区转为遮罩", default=False),
                io.String.Input("password", display_name="连接密码", default="12341234"),
                io.String.Input("Server", display_name="服务器地址", default="127.0.0.1"),
                io.String.Input("port", display_name="端口", default="49494"),
            ],
            outputs=[io.Image.Output(display_name="Photoshop 画布"), io.Mask.Output(display_name="遮罩")],
        )

    @classmethod
    def execute(cls, Selection_To_Mask, password, Server, port) -> io.NodeOutput:
        try:
            from photoshop import PhotoshopConnection
        except ImportError as error:
            raise RuntimeError("RemoteConnection requires photoshop-connection in the ComfyUI Python environment.") from error

        with tempfile.TemporaryDirectory(prefix="comfyui-photoshop-") as directory:
            image_path = Path(directory) / "canvas.png"
            mask_path = Path(directory) / "mask.png"
            image_file = json.dumps(image_path.as_posix())
            mask_file = json.dumps(mask_path.as_posix())
            canvas_script = f"""
                var options = new PNGSaveOptions();
                app.activeDocument.saveAs(new File({image_file}), options, true);
            """
            mask_script = f"""
                var doc = app.activeDocument, state = doc.activeHistoryState;
                try {{
                    var savedSelection = doc.channels.add();
                    doc.selection.store(savedSelection);
                    doc.activeChannels = doc.componentChannels;
                    var black = new SolidColor(); black.rgb.hexValue = "000000";
                    var white = new SolidColor(); white.rgb.hexValue = "FFFFFF";
                    doc.artLayers.add(); doc.selection.selectAll(); doc.selection.fill(black);
                    doc.selection.load(savedSelection);
                    doc.selection.fill(white);
                    doc.saveAs(new File({mask_file}), new PNGSaveOptions(), true);
                }} finally {{ doc.activeHistoryState = state; }}
            """
            with PhotoshopConnection(password=password, host=Server, port=int(port)) as connection:
                connection.execute(canvas_script)
                if Selection_To_Mask:
                    connection.execute(mask_script)
            with Image.open(image_path) as image:
                image = ImageOps.exif_transpose(image).convert("RGB")
                canvas = torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)
            mask = torch.zeros(canvas.shape[:3], dtype=torch.float32)
            if Selection_To_Mask and mask_path.exists():
                with Image.open(mask_path) as image:
                    image = ImageOps.exif_transpose(image).convert("L")
                    mask = torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)
            return io.NodeOutput(canvas, mask)

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")
