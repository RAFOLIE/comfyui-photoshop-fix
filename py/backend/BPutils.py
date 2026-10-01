import subprocess
import sys
from pathlib import Path


class directories:
    def __init__(self):
        self.node = str(Path(__file__).resolve().parents[2])
        self.workflow = str(Path(self.node) / "data" / "workflows")
        self.psinput = str(Path(self.node) / "data" / "ps_inputs")
        self.psimg = str(Path(self.psinput) / "imgs")
        for directory in (self.workflow, self.psinput, self.psimg):
            Path(directory).mkdir(parents=True, exist_ok=True)


dirs = directories()


def image_file(filename, directory=None):
    directory = Path(directory or dirs.psimg).resolve()
    path = (directory / filename).resolve()
    if path.parent != directory:
        raise ValueError("Photoshop image names cannot contain directories.")
    return str(path)


def install_plugin():
    installer_path = str(Path(dirs.node) / "Install_Plugin" / "installer.py")
    subprocess.run([sys.executable, installer_path], check=True)


async def LatestVer(plugin_version: str):
    # Local previews must not advertise an upstream legacy architecture update.
    return None
