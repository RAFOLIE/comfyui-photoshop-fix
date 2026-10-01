from comfy_api.latest import ComfyExtension, io

from .py.nodes.nodeOther import ClipPass, Floats, PsImages, PsString, SeedManager, UERerouteNode, modelPass
from .py.nodes.nodePlugin import ComfyUIToPhotoshop
from .py.nodes.nodeRemoteConnection import PhotoshopConnections

WEB_DIRECTORY = "js"


class PhotoshopExtension(ComfyExtension):
    async def on_load(self) -> None:
        from .py.backend import BProute, BPserver

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [ComfyUIToPhotoshop, PsImages, PsString, Floats, SeedManager,
                ClipPass, modelPass, UERerouteNode, PhotoshopConnections]


async def comfy_entrypoint() -> PhotoshopExtension:
    return PhotoshopExtension()