import base64
import ipaddress
import logging
import aiofiles
import asyncio
from aiohttp import web
import folder_paths
from server import PromptServer
import os
from .BPutils import dirs
from urllib.parse import urlparse
import re
from .BPclient import ws_manager
import io
from PIL import Image

# ==================== 图片格式配置 ====================
MAX_IMAGE_DIMENSION = 8192  # 8K 最大分辨率 (8192x8192)
MAX_IMAGES_PER_BATCH = 4    # 最多4张图片 (2x2布局)

# ==================== 二进制图片缓存系统 ====================
render_cache = {}  # 存储格式: {"render_0.png": bytes_data, ...}
render_cache_lock = asyncio.Lock()  # 异步锁防止并发问题
RENDER_CACHE_MAX_SIZE = 20 * 1024 * 1024  # 20MB 最大缓存

def get_cache_size():
    """计算当前缓存总大小"""
    return sum(len(data) for data in render_cache.values())

async def check_and_clear_cache():
    """检查缓存大小，超过20MB时清除"""
    global render_cache
    cache_size = get_cache_size()
    if cache_size > RENDER_CACHE_MAX_SIZE:
        print(f"# PS: Cache size {cache_size / 1024 / 1024:.2f}MB > 20MB, clearing...")
        render_cache.clear()
        return True
    return False

def process_image_for_transfer(image: Image.Image, filename: str) -> tuple[bytes, str]:
    """
    处理图片用于传输:
    - 如果分辨率 <= 8K，使用PNG格式
    - 如果分辨率 > 8K，强制压缩为JPEG
    
    Returns:
        tuple: (图片字节数据, 文件扩展名)
    """
    width, height = image.size
    
    # 检查是否超过8K分辨率
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        # 超过8K，强制使用JPEG压缩
        logging.info(f"# PS: Image {filename} ({width}x{height}) exceeds 8K, converting to JPEG")
        
        # 如果是RGBA，转换为RGB
        if image.mode == 'RGBA':
            # 创建白色背景
            background = Image.new('RGB', image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[3])  # 使用alpha通道作为mask
            image = background
        elif image.mode != 'RGB':
            image = image.convert('RGB')
        
        # 保存为JPEG
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=85, optimize=True)
        return output.getvalue(), '.jpg'
    else:
        # 8K以内，使用PNG格式保持质量
        logging.info(f"# PS: Image {filename} ({width}x{height}) within 8K, using PNG")
        output = io.BytesIO()
        image.save(output, format='PNG', optimize=True)
        return output.getvalue(), '.png'


# from BPclient import user_manager


# region Routes
@PromptServer.instance.routes.get("/ps/input_images")
async def input_images(request):
    return web.json_response(sorted((
        name for name in os.listdir(dirs.psimg)
        if os.path.isfile(os.path.join(dirs.psimg, name))
        and name.lower().endswith((".png", ".jpg", ".jpeg"))
    ), key=lambda name: os.stat(os.path.join(dirs.psimg, name)).st_mtime_ns, reverse=True))


@PromptServer.instance.routes.get("/ps/workflows/{name:.+}")
async def get_workflow(request):
    file = os.path.abspath(os.path.join(dirs.workflow, request.match_info["name"] + ".json"))
    if os.path.commonpath([file, dirs.workflow]) != dirs.workflow:
        return web.Response(status=403)
    return web.FileResponse(file)


@PromptServer.instance.routes.get("/ps/inputs/{filename}")
async def get_input(request):
    file = os.path.abspath(os.path.join(dirs.psimg, request.match_info["filename"]))
    if os.path.commonpath([file, dirs.psimg]) != dirs.psimg:
        return web.Response(status=403)
    return web.FileResponse(file)


@PromptServer.instance.routes.get("/ps/error.png")
async def get_error_image(request):
    file_path = os.path.join(dirs.psinput, "NoImage.png")
    absolute_path = os.path.abspath(file_path)
    if os.path.commonpath([absolute_path, dirs.psinput]) != dirs.psinput:
        return web.Response(status=403)
    return web.FileResponse(absolute_path)


@PromptServer.instance.routes.get("/ps/renderbatch")
async def handle_render_batch(request):
    """
    处理批量渲染请求
    - 支持最多4张图片 (2x2布局)
    - 8K以内使用PNG，超过8K强制JPEG
    """
    try:
        cmUID = request.rel_url.query.get("cmUID", "")
        filenames_param = request.rel_url.query.get("filenames", "")
        filenames = filenames_param.split(",")

        if not filenames or filenames[0] == "":
            return web.Response(text="No filenames provided", status=400)

        # 限制最多4张图片
        filenames = filenames[:MAX_IMAGES_PER_BATCH]
        
        temp_dir = folder_paths.get_temp_directory()
        batch_results = []

        for filename in filenames:
            try:
                filepath = os.path.join(temp_dir, filename)

                async with aiofiles.open(filepath, "rb") as image_file:
                    file_content = await image_file.read()

                image = Image.open(io.BytesIO(file_content)).convert("RGBA")
                width, height = image.size

                alpha_channel = image.getchannel("A")
                bbox = alpha_channel.getbbox()

                if not bbox:
                    bbox = (0, 0, width, height)

                source_bounds = {"left": bbox[0], "top": bbox[1], "right": bbox[2], "bottom": bbox[3]}

                # 根据分辨率决定传输格式
                if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                    # 超过8K，使用JPEG
                    logging.info(f"# PS: Image {filename} ({width}x{height}) > 8K, using JPEG")
                    if image.mode == 'RGBA':
                        background = Image.new('RGB', image.size, (255, 255, 255))
                        background.paste(image, mask=image.split()[3])
                        image = background
                    output = io.BytesIO()
                    image.save(output, format='JPEG', quality=85, optimize=True)
                    processed_content = output.getvalue()
                    format_type = "jpeg"
                else:
                    # 8K以内，使用PNG
                    logging.info(f"# PS: Image {filename} ({width}x{height}) <= 8K, using PNG")
                    output = io.BytesIO()
                    image.save(output, format='PNG', optimize=True)
                    processed_content = output.getvalue()
                    format_type = "png"

                # Convert to Uint8Array
                uint8_array = list(processed_content)

                batch_results.append({
                    "image": uint8_array, 
                    "size": {"width": width, "height": height}, 
                    "sourceBounds": source_bounds, 
                    "filename": filename,
                    "format": format_type  # 添加格式信息
                })

            except Exception as e:
                print(f"# PS: Error processing file {filename}: {e}")

        if batch_results:
            # Check if cmUID is provided
            if cmUID and cmUID in ws_manager.clients:
                # Get the IP address of the cm user
                cm_ip = ws_manager.clients[cmUID].ip
                # Use new matching logic with fallback for remote setups
                ps_users = ws_manager.find_matching_ps_users(cm_ip, cmUID)

                if ps_users:
                    # Send message to matching PS users
                    await ws_manager.send_message(ps_users, "render_batch", batch_results)
                    print(f"# PS: from {cmUID}, {len(batch_results)} images (max 4) sent to {len(ps_users)} PS user(s), CM IP: {cm_ip}")
                else:
                    print(f"# PS: No matching PS users found for cmUID: {cmUID}, IP: {cm_ip}")
            else:
                # Fallback to sending to all PS users if cmUID is not provided or not found
                await ws_manager.send_message(ws_manager.photoshop_users, "render_batch", batch_results)
                print(f"# PS: Batch of {len(batch_results)} images (max 4) sent to all PS users. cmUID: {cmUID} was not found or not provided")

    except Exception as e:
        print(f"# PS: Error in batch rendering: {e}")
        return web.Response(text=f"Error: {e}", status=500)

    return web.Response(text=f"Batch of {len(batch_results)} images (max 4, 2x2 layout) sent to ps with cmUID: {cmUID}")


@PromptServer.instance.routes.get("/ps/icons/{filename}.svg")
async def get_logo(request):
    filename = request.match_info["filename"] + ".svg"
    file = os.path.abspath(os.path.join(dirs.node, "data", "comfyIcons", filename))
    if os.path.commonpath([file, dirs.node]) != dirs.node:
        return web.Response(status=403)
    return web.FileResponse(file)


# ==================== 二进制图片上传端点 ====================
@PromptServer.instance.routes.post("/ps/render_binary")
async def render_binary(request):
    """接收二进制图片数据，支持多图传送（最多4张）"""
    global render_cache
    try:
        image_index = int(request.headers.get('X-Image-Index', '0'))
        image_count = int(request.headers.get('X-Image-Count', '1'))
        filename = request.headers.get('X-Filename', f'render_{image_index}.png')
        
        # 限制最多4张图片
        if image_count > MAX_IMAGES_PER_BATCH:
            image_count = MAX_IMAGES_PER_BATCH
        if image_index >= MAX_IMAGES_PER_BATCH:
            return web.json_response({
                "success": False, 
                "error": f"Maximum {MAX_IMAGES_PER_BATCH} images supported"
            }, status=400)
        
        data = await request.read()
        print(f"# PS: Received binary {filename} ({len(data)} bytes) [{image_index+1}/{image_count}]")
        
        async with render_cache_lock:
            # 第一张图片时检查缓存
            if image_index == 0:
                await check_and_clear_cache()
            
            render_cache[filename] = data
            current_size = get_cache_size()
            print(f"# PS: Cache size: {current_size / 1024 / 1024:.2f}MB")
        
        # 所有图片上传完成后发送通知
        if image_index == image_count - 1:
            await ws_manager.send_message(ws_manager.photoshop_users, "renders_ready", {
                "count": image_count,
                "files": [f"render_{i}.png" for i in range(image_count)]
            })
        
        return web.json_response({
            "success": True,
            "index": image_index,
            "count": image_count
        })
        
    except Exception as e:
        print(f"# PS: Render binary error: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/ps/get_render/{filename}")
async def get_render(request):
    """从内存缓存获取渲染图片"""
    global render_cache
    try:
        filename = request.match_info['filename']
        
        async with render_cache_lock:
            if filename in render_cache:
                data = render_cache[filename]
                # 根据文件扩展名确定内容类型
                content_type = 'image/png' if filename.endswith('.png') else 'image/jpeg'
                print(f"# PS: Serving from cache: {filename} ({len(data)} bytes)")
                return web.Response(
                    body=data,
                    content_type=content_type
                )
            else:
                print(f"# PS: Not found in cache: {filename}")
                return web.json_response({"error": "File not found in cache"}, status=404)
            
    except Exception as e:
        print(f"# PS: Get render error: {e}")
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/ps/clear_render_cache")
async def clear_render_cache(request):
    """清除渲染缓存"""
    global render_cache
    async with render_cache_lock:
        count = len(render_cache)
        render_cache.clear()
    print(f"# PS: Cleared {count} items from render cache")
    return web.json_response({"success": True, "cleared": count})


@PromptServer.instance.routes.post("/ps/upload_canvas_binary")
async def upload_canvas_binary(request):
    """接收PS画布的二进制数据"""
    try:
        os.makedirs(dirs.psimg, exist_ok=True)
        
        filename = request.headers.get('X-Filename', 'PS_canvas.png')
        filepath = os.path.join(dirs.psimg, filename)
        
        # 直接读取二进制数据
        data = await request.read()
        
        print(f"# PS: Received canvas binary data, size: {len(data)} bytes")
        
        # 写入文件
        async with aiofiles.open(filepath, 'wb') as f:
            await f.write(data)
        
        file_size = os.path.getsize(filepath)
        print(f"# PS: Canvas saved: {filepath}")
        
        return web.json_response({
            "success": True,
            "filename": filename,
            "size": file_size
        })
        
    except Exception as e:
        print(f"# PS: Upload canvas error: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/ps/bluepixel/css.css")
async def get_css(request):
    file_path = os.path.realpath(os.path.join(dirs.node, "js", "css.css"))
    if not file_path.startswith(os.path.realpath(dirs.node)):
        return web.Response(status=403)
    return web.FileResponse(file_path)


from aiohttp import web, ClientSession
import ipaddress
from urllib.parse import urlparse
import re
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Allowed domains patterns
ALLOWED_DOMAINS = [r".*\.googleapis\.com", r".*\.firebaseio\.com", r".*\.cloudfunctions\.net", r".*\.google-analytics\.com"]


async def proxy_handler(request):
    client_ip = request.remote
    if not is_local_ip(client_ip):
        return web.Response(status=403, text="Access denied: Local network only")

    # 2. Get target URL and verify it's allowed
    target_url = request.headers.get("url")
    if not target_url or not is_allowed_domain(target_url):
        return web.Response(status=403, text="Invalid or forbidden URL")

    # 3. Get HTTP method
    method = request.headers.get("method", "GET").upper()
    if method not in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
        return web.Response(status=400, text="Invalid HTTP method")

    try:
        # 4. Forward the request
        data = await request.json() if request.body_exists else None
        async with ClientSession() as session:
            async with session.request(method, target_url, json=data) as response:
                result = await response.json()
                return web.json_response(result, status=response.status)
    except Exception as e:
        logger.error(f"Proxy error: {str(e)}")
        return web.Response(status=500, text=str(e))


def is_local_ip(ip):
    try:
        ip_addr = ipaddress.ip_address(ip)
        local_networks = [
            ipaddress.ip_network("10.0.0.0/8"),
            ipaddress.ip_network("172.16.0.0/12"),
            ipaddress.ip_network("192.168.0.0/16"),
            ipaddress.ip_network("127.0.0.0/8"),
        ]
        return any(ip_addr in network for network in local_networks)
    except ValueError:
        return False


def is_allowed_domain(url):
    try:
        domain = urlparse(url).netloc
        return any(re.match(pattern, domain) for pattern in ALLOWED_DOMAINS)
    except Exception:
        return False


@PromptServer.instance.routes.post("/ps/auth/proxy")
async def handle_proxy(request):
    return await proxy_handler(request)
