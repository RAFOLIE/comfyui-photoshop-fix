import base64
import io
import json
import logging
from dataclasses import dataclass
import os
from aiohttp import web
import numpy as np
import msgpack
from .BPutils import install_plugin, dirs, image_file
from PIL import Image
import asyncio
from concurrent.futures import ThreadPoolExecutor

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Global thread pool executor for CPU-intensive tasks
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mask_processor")

# ==================== 图片格式配置 ====================
MAX_IMAGE_DIMENSION = 8192  # 8K 最大分辨率 (8192x8192)
MAX_IMAGES_PER_BATCH = 4    # 最多4张图片 (2x2布局)


@dataclass
class Client:
    ws: web.WebSocketResponse
    platform: str
    ip: str
    pairing_token: str = ""  # Optional pairing token for remote connections


class WebSocketManager:
    def __init__(self):
        self.clients: dict[str, Client] = {}
        self.photoshop_users: list[str] = []
        self.comfyui_users: list[str] = []

    def find_matching_ps_users(self, sender_ip: str, sender_id: str = "") -> list[str]:
        """
        Find PS users that match the sender.
        Priority:
        1. Match by pairing token (if set)
        2. Match by IP address
        3. Fallback: if only one PS user exists, use it (for remote setups)
        """
        # First, try to match by pairing token
        if sender_id and sender_id in self.clients:
            sender_token = self.clients[sender_id].pairing_token
            if sender_token:
                token_matches = [
                    uid for uid in self.photoshop_users 
                    if uid in self.clients and self.clients[uid].pairing_token == sender_token
                ]
                if token_matches:
                    return token_matches
        
        # Second, try to match by IP
        ip_matches = [
            uid for uid in self.photoshop_users 
            if uid in self.clients and self.clients[uid].ip == sender_ip
        ]
        if ip_matches:
            return ip_matches
        
        # Fallback: if only one PS user exists, use it (common for remote setups)
        if len(self.photoshop_users) == 1:
            ps_id = self.photoshop_users[0]
            if ps_id in self.clients:
                logger.info(f"IP mismatch but using single PS client. Sender IP: {sender_ip}, PS IP: {self.clients[ps_id].ip}")
                return [ps_id]
        
        return []

    def find_matching_cm_users(self, sender_ip: str, sender_id: str = "") -> list[str]:
        """
        Find CM (ComfyUI) users that match the sender.
        Priority:
        1. Match by pairing token (if set)
        2. Match by IP address
        3. Fallback: if only one CM user exists, use it (for remote setups)
        """
        # First, try to match by pairing token
        if sender_id and sender_id in self.clients:
            sender_token = self.clients[sender_id].pairing_token
            if sender_token:
                token_matches = [
                    uid for uid in self.comfyui_users 
                    if uid in self.clients and self.clients[uid].pairing_token == sender_token
                ]
                if token_matches:
                    return token_matches
        
        # Second, try to match by IP
        ip_matches = [
            uid for uid in self.comfyui_users 
            if uid in self.clients and self.clients[uid].ip == sender_ip
        ]
        if ip_matches:
            return ip_matches
        
        # Fallback: if only one CM user exists, use it (common for remote setups)
        if len(self.comfyui_users) == 1:
            cm_id = self.comfyui_users[0]
            if cm_id in self.clients:
                logger.info(f"IP mismatch but using single CM client. Sender IP: {sender_ip}, CM IP: {self.clients[cm_id].ip}")
                return [cm_id]
        
        return []

    def set_pairing_token(self, client_id: str, token: str) -> bool:
        """Set pairing token for a client"""
        if client_id in self.clients:
            self.clients[client_id].pairing_token = token
            logger.info(f"Pairing token set for client {client_id}: {token[:8]}...")
            return True
        return False

    async def handle_cm_messages(self, msg: dict) -> None:
        if "pullupdate" in msg:
            await self.send_message(self.comfyui_users, "alert", "This V3 preview is saved locally. Update from your workspace preview package.")
        elif "install_plugin" in msg:
            install_plugin()
        elif "setPairingToken" in msg:
            # Handle pairing token setting
            sender_id = msg.get("_sender_id", "")
            token = msg.get("setPairingToken", "")
            if sender_id and token:
                self.set_pairing_token(sender_id, token)
        else:
            # Find matching PS clients using new logic
            sender_id = msg.get("_sender_id", "")
            sender_ip = self.clients[sender_id].ip if sender_id in self.clients else None
            if sender_ip:
                ps_users = self.find_matching_ps_users(sender_ip, sender_id)
                await self.send_message(ps_users, "", json.dumps(msg))
            else:
                await self.send_message(self.photoshop_users, "", json.dumps(msg))

    async def handle_ps_messages(self, msg: dict, sender_id: str) -> None:
        # Handle pairing token from PS
        if "setPairingToken" in msg:
            token = msg.get("setPairingToken", "")
            if token:
                self.set_pairing_token(sender_id, token)
            return
        
        if "combinedData" in msg:
            combinedData = msg["combinedData"]
            if "changedImages" in combinedData:
                await process_changed_images(combinedData["changedImages"])
            if "maskBase64" in combinedData:
                await process_and_save_mask(combinedData["maskBase64"], "SELECTION.png")
            
            # Find matching CM clients using new logic
            sender_ip = self.clients[sender_id].ip if sender_id in self.clients else None
            if sender_ip:
                cm_users = self.find_matching_cm_users(sender_ip, sender_id)
                await self.send_message(cm_users, "queue", True)
            else:
                await self.send_message(self.comfyui_users, "queue", True)

        if not ("combinedData" in msg):
            # Find matching CM clients using new logic
            sender_ip = self.clients[sender_id].ip if sender_id in self.clients else None
            if sender_ip:
                cm_users = self.find_matching_cm_users(sender_ip, sender_id)
                await self.send_message(cm_users, "", json.dumps(msg))
            else:
                await self.send_message(self.comfyui_users, "", json.dumps(msg))

    async def handle_client_message(self, client_id: str, platform: str, data: str | bytes) -> None:
        try:
            if platform == "ps":
                msg = msgpack.unpackb(data, raw=False)
                await self.handle_ps_messages(msg, client_id)
            else:
                msg = json.loads(data)
                # Add sender ID to message for IP filtering
                msg["_sender_id"] = client_id
                await self.handle_cm_messages(msg)

        except (json.JSONDecodeError, msgpack.exceptions.ExtraData) as e:
            logger.error(f"Invalid message format received from {platform}: {e}")
        except Exception as e:
            logger.error(f"Error processing message from {platform}: {e}")

    async def handle_client_disconnect(self, client_id: str, platform: str) -> None:
        try:
            if client_id in self.clients:
                del self.clients[client_id]

            user_list = self.photoshop_users if platform == "ps" else self.comfyui_users
            if client_id in user_list:
                user_list.remove(client_id)
        except Exception as e:
            logger.error(f"Error handling disconnect for {client_id}: {e}")

    async def send_message(self, users: list[str], msg_type: str, message: str | bool = True) -> None:
        if not users:
            logger.warning("No users connected")
            return

        for user_id in users:
            if user_id in self.clients:
                try:
                    if self.clients[user_id].platform == "ps":
                        if msg_type:
                            payload = {msg_type: message}
                        else:
                            payload = json.loads(message) if isinstance(message, str) and message.strip().startswith(('{', '[')) else message
                        data = msgpack.packb(payload)
                        await self.clients[user_id].ws.send_bytes(data)
                    else:
                        data = json.dumps({msg_type: message}) if msg_type else message
                        await self.clients[user_id].ws.send_str(data)
                except Exception as e:
                    logger.error(f"Error sending message to user {user_id}: {e}")
            else:
                logger.warning(f"User {user_id} not connected")


ws_manager = WebSocketManager()


def _process_image_sync(index: int, image_dict: dict, psimg_path: str) -> dict:
    """
    Synchronous image processing (runs in thread pool)
    - 8K以内使用PNG格式
    - 超过8K强制使用JPEG
    """
    title = "Untitled"
    try:
        title = image_dict["title"]
        image_info = image_dict["imageInfo"]

        if isinstance(image_info, str) and image_info.startswith("/9j/"):
            # JPEG base64
            image_bytes = base64.b64decode(image_info)
            image = Image.open(io.BytesIO(image_bytes))
            width, height = image.size

            # 根据分辨率决定保存格式
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                # 超过8K，保存为JPEG
                save_path = image_file(f"{title}.jpg", psimg_path)
                if image.mode == 'RGBA':
                    background = Image.new('RGB', image.size, (255, 255, 255))
                    background.paste(image, mask=image.split()[3])
                    image = background
                image.save(save_path, format='JPEG', quality=85)
                logger.info(f" Image saved as JPEG (>8K): {title} ({width}x{height})")
            else:
                # 8K以内，保存为PNG
                save_path = image_file(f"{title}.png", psimg_path)
                image.save(save_path, format='PNG')
                logger.info(f" Image saved as PNG (<=8K): {title} ({width}x{height})")
            
            return {"success": True, "title": title, "size": (width, height)}

        # Raw image data
        image_data = image_info["imageData"]
        transparent = image_info.get("transparent", False)
        width = image_info["width"]
        height = image_info["height"]

        expected_size_with_alpha = height * width * 4
        expected_size_without_alpha = height * width * 3

        if len(image_data) == expected_size_with_alpha:
            channels = 4
        elif len(image_data) == expected_size_without_alpha:
            channels = 3
        else:
            raise ValueError(f"Invalid image data size. Expected {expected_size_with_alpha} or {expected_size_without_alpha}, got {len(image_data)}")

        image_array = np.array(image_data, dtype=np.uint8).reshape((height, width, channels))

        mode = "RGBA" if channels == 4 else "RGB"
        image = Image.fromarray(image_array, mode=mode)

        source_bounds = image_info.get("sourceBounds", {"left": 0, "right": width, "top": 0, "bottom": height})
        left = source_bounds.get("left", 0)
        right = source_bounds.get("right", width)
        top = source_bounds.get("top", 0)
        bottom = source_bounds.get("bottom", height)

        source_width = right - left
        source_height = bottom - top

        resized_image = image.resize((source_width, source_height), Image.Resampling.LANCZOS)
        is_full_size = left == 0 and right == width and top == 0 and bottom == height

        if is_full_size:
            final_image = resized_image
        else:
            if channels == 4:
                background = (0, 0, 0, 0)
            else:
                background = (255, 255, 255)

            background_image = Image.new(mode, (width, height), background)
            background_image.paste(resized_image, (left, top))
            final_image = background_image

        # 根据分辨率决定保存格式
        final_width, final_height = final_image.size
        if final_width > MAX_IMAGE_DIMENSION or final_height > MAX_IMAGE_DIMENSION:
            # 超过8K，保存为JPEG
            save_path = image_file(f"{title}.jpg", psimg_path)
            if final_image.mode == 'RGBA':
                bg = Image.new('RGB', final_image.size, (255, 255, 255))
                bg.paste(final_image, mask=final_image.split()[3])
                final_image = bg
            final_image.save(save_path, format='JPEG', quality=85)
            logger.info(f" Image saved as JPEG (>8K): {title} ({final_width}x{final_height})")
        else:
            # 8K以内，保存为PNG
            save_path = image_file(f"{title}.png", psimg_path)
            final_image.save(save_path, format='PNG')
            logger.info(f" Image saved as PNG (<=8K): {title} ({final_width}x{final_height})")
        
        return {"success": True, "title": title, "size": (final_width, final_height)}

    except Exception as e:
        logger.error(f" Error processing image ({title}): {e}", exc_info=True)
        return {"success": False, "title": title, "error": str(e)}


async def process_single_image(index: int, image_dict: dict, executor: ThreadPoolExecutor) -> None:
    """Process a single image using thread pool"""
    logger.info(f" Processing image {index}: {image_dict.keys()}")
    
    # Run CPU-intensive work in thread pool
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, _process_image_sync, index, image_dict, dirs.psimg)
    
    if result["success"]:
        logger.info(f" Image saved: {result['title']} ({result['size'][0]}x{result['size'][1]})")
    else:
        logger.error(f" Failed to process: {result['title']} - {result.get('error', 'Unknown error')}")


async def process_changed_images(image_list: list) -> None:
    """
    Process multiple images in parallel using thread pool
    - 最多处理4张图片 (2x2布局)
    """
    if not image_list:
        return
    
    # 限制最多4张图片
    if len(image_list) > MAX_IMAGES_PER_BATCH:
        logger.warning(f" Received {len(image_list)} images, limiting to {MAX_IMAGES_PER_BATCH} (2x2 layout)")
        image_list = image_list[:MAX_IMAGES_PER_BATCH]
        
    logger.info(f" Processing {len(image_list)} images in parallel (max {MAX_IMAGES_PER_BATCH})...")
    
    # Create thread pool executor (max workers = number of images or 4, whichever is smaller)
    max_workers = min(len(image_list), MAX_IMAGES_PER_BATCH)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Create tasks for parallel processing
        tasks = [process_single_image(index, image_dict, executor) for index, image_dict in enumerate(image_list)]
        
        # Process all images concurrently
        results = await asyncio.gather(*tasks, return_exceptions=True)
    
    # Log any errors
    errors = [r for r in results if isinstance(r, Exception)]
    if errors:
        logger.warning(f" {len(errors)} images failed to process")
    else:
        logger.info(f" Successfully processed all {len(image_list)} images")


def _process_mask_sync(mask_data: dict, output_filename: str) -> None:
    """Synchronous mask processing (runs in thread pool)"""
    try:
        mask_array = mask_data.get("maskData", None)
        width = max(1, int(mask_data.get("width", 0)))
        height = max(1, int(mask_data.get("height", 0)))
        sourcebounds = mask_data.get("sourcebounds", None)

        bg = Image.new("L", (width, height), 0)

        if mask_array is None or (hasattr(mask_array, "data") and mask_array.data is None):
            output_path = os.path.join(dirs.psimg, output_filename)
            bg.save(output_path)
            return

        if hasattr(mask_array, "data"):
            mask_array = mask_array.data

        mask_np = np.frombuffer(mask_array, dtype=np.uint8)

        if mask_np.size == 0:
            output_path = os.path.join(dirs.psimg, output_filename)
            bg = Image.new("L", (width, height), 255)
            bg.save(output_path)
            return

        expected_size = width * height
        if mask_np.size != expected_size:
            mask_np = np.zeros(expected_size, dtype=np.uint8)

        mask_np = mask_np.reshape((height, width))

        raw_mask_image = Image.fromarray(mask_np, mode="L")

        if sourcebounds:
            left = max(0, round(sourcebounds.get("left", 0)))
            right_pad = max(0, round(sourcebounds.get("right", 0)))
            top = max(0, round(sourcebounds.get("top", 0)))
            bottom_pad = max(0, round(sourcebounds.get("bottom", 0)))

            new_width = max(0, width - left - right_pad)
            new_height = max(0, height - top - bottom_pad)

            if new_width <= 0 or new_height <= 0:
                new_width = width
                new_height = height
                left = 0
                top = 0

            resized_mask = raw_mask_image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            bg.paste(resized_mask, (left, top))
        else:
            bg.paste(raw_mask_image, (0, 0))

        output_path = os.path.join(dirs.psimg, output_filename)
        bg.save(output_path)
        logger.info(f" Mask saved successfully: {output_filename} ({width}x{height})")

    except Exception as e:
        logger.error(f"Error processing and saving mask: {e}", exc_info=True)
        try:
            width = max(1, int(mask_data.get("width", 0)))
            height = max(1, int(mask_data.get("height", 0)))
            bg = Image.new("L", (max(1, width), max(1, height)), 0)
            output_path = os.path.join(dirs.psimg, output_filename)
            bg.save(output_path)
        except Exception as save_error:
            logger.error(f"Error saving fallback image: {save_error}", exc_info=True)


async def process_and_save_mask(mask_data: dict, output_filename: str) -> None:
    """Process mask asynchronously using thread pool for better performance"""
    logger.info(f" Processing mask: {output_filename}")
    
    # Run CPU-intensive mask processing in thread pool
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(executor, _process_mask_sync, mask_data, output_filename)
