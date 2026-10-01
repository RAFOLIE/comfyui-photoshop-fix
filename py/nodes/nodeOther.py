import hashlib
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps, ImageSequence
from comfy_api.latest import io

IMAGE_DIRECTORY = Path(__file__).resolve().parents[2] / "data" / "ps_inputs" / "imgs"


def image_path(name):
    directory = IMAGE_DIRECTORY.resolve()
    paths = [(directory / f"{name}{extension}").resolve() for extension in (".png", ".jpg", ".jpeg")]
    if any(not path.is_relative_to(directory) for path in paths):
        raise ValueError("Photoshop image names must stay inside the plugin input directory.")
    existing = [path for path in paths if path.is_file()]
    return max(existing, key=lambda path: path.stat().st_mtime_ns) if existing else paths[0]


def load_image(path):
    for attempt in range(5):
        try:
            image = Image.open(path)
            image.load()
            return image
        except (OSError, Image.DecompressionBombError):
            if attempt == 4:
                raise
            time.sleep(0.1 * 2 ** attempt)


class ClipPass(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹ClipPass", display_name="🔹CLIP 直通", category="🔹BluePixel/🛠️ Utils",
            inputs=[io.Clip.Input("clip", display_name="CLIP")], outputs=[io.Clip.Output(display_name="clip")],
        )

    @classmethod
    def execute(cls, clip):
        return io.NodeOutput(clip)


class modelPass(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹modelPass", display_name="🔹模型直通", category="🔹BluePixel/🛠️ Utils",
            inputs=[io.Model.Input("model", display_name="模型")], outputs=[io.Model.Output(display_name="模型")],
        )

    @classmethod
    def execute(cls, model):
        return io.NodeOutput(model)


class PsImages(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹Photoshop Images", display_name="🔹PS 图像输入", category="🔹BluePixel/ToolBar",
            inputs=[io.String.Input("ImageName", display_name="图像名称", default="MAIN DOC")],
            outputs=[
                io.Image.Output(display_name="图像"), io.Mask.Output(display_name="透明度"),
                io.Mask.Output(display_name="选区遮罩"), io.Int.Output(display_name="宽度"),
                io.Int.Output(display_name="高度"),
            ],
        )

    @classmethod
    def execute(cls, ImageName):
        path = image_path(ImageName)
        if not path.is_file():
            return io.NodeOutput(torch.zeros((1, 24, 24, 3)), torch.ones((1, 24, 24)),
                                 torch.ones((1, 24, 24)), 24, 24)

        output_images, output_masks = [], []
        with load_image(path) as image:
            for frame in ImageSequence.Iterator(image):
                frame = ImageOps.exif_transpose(frame)
                rgba = frame.convert("RGBA")
                alpha = rgba.getchannel("A")
                # Keep straight RGB; the send node reattaches alpha without a matte.
                rgb = rgba.convert("RGB")
                if not output_images:
                    width, height = frame.size
                if frame.size != (width, height):
                    continue
                output_images.append(torch.from_numpy(np.array(rgb).astype(np.float32) / 255.0))
                output_masks.append(torch.from_numpy(np.array(alpha).astype(np.float32) / 255.0))
        images = torch.stack(output_images)
        masks = torch.stack(output_masks)

        selection_path = IMAGE_DIRECTORY / "SELECTION.png"
        selection = torch.ones((1, height, width), dtype=torch.float32)
        if selection_path.is_file():
            with load_image(selection_path) as image:
                selection_frames = [
                    torch.from_numpy(np.array(ImageOps.exif_transpose(frame).convert("RGB"))[:, :, 0].astype(np.float32) / 255.0)
                    for frame in ImageSequence.Iterator(image)
                ]
            selection = F.interpolate(torch.stack(selection_frames).unsqueeze(1),
                                      size=(height, width), mode="nearest").squeeze(1)
        return io.NodeOutput(images, masks, selection, width, height)

    @classmethod
    def fingerprint_inputs(cls, ImageName):
        fingerprint = hashlib.sha256(b"ps-images:straight-alpha-v1\0" + ImageName.encode("utf-8"))
        for path in (image_path(ImageName), IMAGE_DIRECTORY / "SELECTION.png"):
            fingerprint.update(path.name.encode("utf-8"))
            fingerprint.update(path.read_bytes() if path.is_file() else b"missing")
        return fingerprint.hexdigest()


class PsString(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹Photoshop Strings", display_name="🔹PS 提示词", category="🔹BluePixel/ToolBar",
            inputs=[io.String.Input("string", display_name="提示词", default="", multiline=True)],
            outputs=[io.String.Output(display_name="文本")],
        )

    @classmethod
    def execute(cls, string):
        return io.NodeOutput(string or "")


class Floats(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹Floats", display_name="🔹PS 数值滑块", category="🔹BluePixel/ToolBar",
            inputs=[io.Float.Input("float_value", display_name="数值", default=1.0, min=-1000.0, max=1000.0,
                                  step=0.01, display_mode=io.NumberDisplay.number)],
            outputs=[io.Float.Output(display_name="数值")],
        )

    @classmethod
    def execute(cls, float_value):
        return io.NodeOutput(float_value)


class SeedManager(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹SeedManager", display_name="🔹PS 随机种子", category="🔹BluePixel/ToolBar",
            inputs=[
                io.Int.Input("manual_seed", display_name="手动种子", default=1379, min=0, max=999999, step=1),
                io.Combo.Input("random_seed", display_name="自动随机种子", options=["enable", "disable"], default="disable"),
            ],
            outputs=[io.Int.Output(display_name="种子")],
        )

    @classmethod
    def execute(cls, manual_seed, random_seed):
        return io.NodeOutput(max(0, min(int(manual_seed), 999999)))


class UERerouteNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="🔹Reroute - Anything Everywhere", display_name="🔹全局重路由",
            category="🔹BluePixel/🛠️ Utils",
            inputs=[io.AnyType.Input("any", display_name="任意输入"), io.Combo.Input("I", display_name="匹配范围", options=["*"], default="*", optional=True)],
            outputs=[io.AnyType.Output(display_name="输出")],
        )

    @classmethod
    def validate_inputs(cls, input_types, I="*"):
        return True

    @classmethod
    def execute(cls, any, I="*"):
        return io.NodeOutput(any)
