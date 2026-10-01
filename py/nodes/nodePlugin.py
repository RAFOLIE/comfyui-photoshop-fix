import aiohttp
import torch
import torch.nn.functional as F
from comfy_api.latest import io, ui
from server import PromptServer


class ComfyUIToPhotoshop(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="🔹SendTo Photoshop Plugin",
            display_name="🔹发送到 Photoshop",
            category="🔹BluePixel",
            inputs=[
                io.Image.Input("RGB", display_name="图像", optional=True),
                io.Mask.Input("ALPHA", display_name="透明度", optional=True),
                io.String.Input("cmUID", display_name="客户端标识", default="", optional=True, advanced=True),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, RGB=None, ALPHA=None, cmUID="") -> io.NodeOutput:
        if RGB is None:
            return io.NodeOutput(ui={"images": []})

        images = RGB
        if ALPHA is not None:
            alpha = ALPHA.reshape((-1, 1, *ALPHA.shape[-2:]))
            alpha = F.interpolate(alpha, size=RGB.shape[1:3], mode="bilinear", align_corners=False)
            indices = torch.arange(RGB.shape[0], device=alpha.device).clamp(max=alpha.shape[0] - 1)
            alpha = alpha[indices].movedim(1, -1).to(device=RGB.device, dtype=RGB.dtype)
            images = torch.cat((RGB[..., :3], alpha), dim=-1)

        saved = ui.ImageSaveHelper.save_images(
            images, filename_prefix="PS_OUTPUTS", folder_type=io.FolderType.temp,
            cls=cls, compress_level=0,
        )
        server = PromptServer.instance
        host = server.address
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1"
        elif ":" in host:
            host = f"[{host}]"
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get(
                f"http://{host}:{server.port}/ps/renderbatch",
                params={"cmUID": cmUID, "filenames": ",".join(image["filename"] for image in saved)},
            ) as response:
                response.raise_for_status()
                await response.read()
        return io.NodeOutput(ui=ui.SavedImages(saved))