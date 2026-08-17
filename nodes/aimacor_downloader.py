"""
Aimacor Labs :: Automatic Model Downloader
--------------------------------------------
Descargador integrado de modelos/checkpoints/LoRAs/VAEs para ComfyUI.
Soporta Civitai y HuggingFace, con detección de duplicados, reintentos
automáticos, cancelación de descargas y verificación de integridad best-effort.
"""

import os
import asyncio
import requests
import urllib.parse
import re
import json
import math
import hashlib
import time
from server import PromptServer
from aiohttp import web
import folder_paths

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# Estado de descargas activas: url -> {progress, cancel_flag, status, retries}
ACTIVE_DOWNLOADS = {}

# Namespace de configuración aislado bajo /models/aimacor_labs/, en vez de
# mezclar archivos de config directamente en /models/
CONFIG_ROOT = os.path.join(folder_paths.base_path, "models", "aimacor_labs")
TOKENS_FILE = os.path.join(CONFIG_ROOT, "tokens.json")
PRESETS_DIR = os.path.join(CONFIG_ROOT, "presets")
os.makedirs(PRESETS_DIR, exist_ok=True)

URL_INFO_CACHE = {}
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 4


def format_size(size_bytes):
    try:
        size_bytes = int(size_bytes)
        if size_bytes == 0:
            return "0 B"
        size_name = ("B", "KB", "MB", "GB", "TB")
        i = int(math.floor(math.log(size_bytes, 1024))) if size_bytes > 0 else 0
        p = math.pow(1024, i)
        s = round(size_bytes / p, 2)
        return f"{s} {size_name[i]}"
    except Exception:
        return "Unknown"


# Nombres de carpeta reconocidos dentro de /models/ de ComfyUI, usados para
# comparar contra segmentos de ruta de un repo de HuggingFace.
KNOWN_FOLDER_NAMES = {
    "checkpoints", "unet", "diffusion_models", "loras", "vae", "vae_approx",
    "text_encoders", "clip", "clip_vision", "controlnet", "upscale_models",
    "embeddings",
}


def guess_folder_from_repo_path(rfilename):
    """
    Nivel 1 (alta confianza): si el propio repo de HuggingFace organiza el
    archivo dentro de una subcarpeta cuyo nombre coincide con una carpeta
    conocida de ComfyUI (ej. '.../vae/model.safetensors'), usamos esa
    estructura tal cual la definió el autor del repo.
    """
    if not rfilename or "/" not in rfilename:
        return None
    parent = rfilename.rsplit("/", 1)[0].split("/")[-1].strip().lower()
    return parent if parent in KNOWN_FOLDER_NAMES else None


def guess_folder_from_filename(name_or_path):
    """
    Nivel 2 (fallback por palabras clave): usado para links directos
    (Civitai u otros) donde no hay estructura de carpetas del repo
    disponible. El orden importa — de más a menos específico.
    """
    s = (name_or_path or "").lower()
    if not s:
        return None
    if "lora" in s or "lycoris" in s:
        return "loras"
    if "vae_approx" in s or "taesd" in s or "taehv" in s or re.search(r"tae[a-z0-9]{0,4}\.safetensors", s):
        return "vae_approx"
    if "vae" in s:
        return "vae"
    if "controlnet" in s or "control_net" in s:
        return "controlnet"
    if "upscal" in s or "esrgan" in s:
        return "upscale_models"
    if "embedding" in s or "textual_inversion" in s:
        return "embeddings"
    if "clip_vision" in s:
        return "clip_vision"
    if "text_encoder" in s or re.search(r"(^|[/_\-])clip([/_\-]|$)", s):
        return "text_encoders"
    if "diffusion_model" in s or re.search(r"(^|[/_\-])unet([/_\-]|$)", s):
        return "diffusion_models"
    if "checkpoint" in s or s.endswith(".ckpt"):
        return "checkpoints"
    return None


def guess_folder(rfilename=None, filename=None, url=None):
    """Combina ambos niveles de detección; devuelve None si no hay pista clara."""
    hint = guess_folder_from_repo_path(rfilename) if rfilename else None
    if hint:
        return hint
    return guess_folder_from_filename(filename or url or "")


def get_headers_with_auth(url, civitai_token="", hf_token=""):
    """Construye headers de auth sin persistir tokens en objetos globales."""
    req_headers = HEADERS.copy()
    if "civitai.com" in url and civitai_token:
        req_headers["Authorization"] = f"Bearer {civitai_token}"
    elif "huggingface.co" in url and hf_token:
        req_headers["Authorization"] = f"Bearer {hf_token}"
    return req_headers


def get_file_info_from_url(url, civitai_token="", hf_token=""):
    if not url or not url.startswith(("http://", "https://")):
        return None, "0 B", None

    if url in URL_INFO_CACHE:
        cached = URL_INFO_CACHE[url]
        return cached["filename"], cached["size"], cached.get("hash_sha256")

    try:
        req_headers = get_headers_with_auth(url, civitai_token, hf_token)
        response = requests.get(url, stream=True, allow_redirects=True, headers=req_headers, timeout=8)
        response.close()

        if response.status_code in [401, 403] or "civitai.com/login" in response.url:
            return None, "Auth Required", None

        size_bytes = response.headers.get("Content-Length")
        formatted_size = format_size(size_bytes) if size_bytes else "Unknown"

        fname = None
        cd = response.headers.get("Content-Disposition")
        if cd:
            match = re.search(r'filename=["\']?([^;"\']+)', cd)
            if match:
                fname = os.path.basename(match.group(1).strip())

        if not fname:
            parsed = urllib.parse.urlparse(response.url)
            fname = os.path.basename(parsed.path)
            if not fname or fname.isdigit():
                fname = (fname if fname else "model") + ".safetensors"

        # HuggingFace expone el hash SHA256 en un header propio cuando el
        # archivo está versionado con Git LFS (best-effort, puede faltar).
        hash_sha256 = response.headers.get("X-Linked-ETag", "").strip('"') or None
        if hash_sha256 and not re.fullmatch(r"[a-fA-F0-9]{64}", hash_sha256):
            hash_sha256 = None

        URL_INFO_CACHE[url] = {"filename": fname, "size": formatted_size, "hash_sha256": hash_sha256}
        return fname, formatted_size, hash_sha256
    except Exception:
        return None, "Unknown", None


def find_existing_file(folder_name, subfolder, filename):
    paths = folder_paths.get_folder_paths(folder_name)
    if not paths:
        return None
    for base_path in paths:
        check_path = base_path
        if subfolder:
            check_path = os.path.join(check_path, subfolder.replace("..", "").strip("\\/"))
        full_file_path = os.path.join(check_path, filename)
        if os.path.exists(full_file_path):
            return full_file_path
    return None


def get_download_target_path(folder_name, subfolder):
    paths = folder_paths.get_folder_paths(folder_name)
    target_base = paths[0] if paths else os.path.join(folder_paths.base_path, "models", folder_name)
    for p in paths or []:
        if os.path.basename(os.path.normpath(p)) == folder_name:
            target_base = p
            break
    if subfolder:
        target_base = os.path.join(target_base, subfolder.replace("..", "").strip("\\/"))
    return target_base


def verify_checksum(file_path, expected_sha256):
    """Verificación best-effort: si no hay hash esperado, no bloquea nada."""
    if not expected_sha256:
        return True
    try:
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                sha256.update(chunk)
        return sha256.hexdigest().lower() == expected_sha256.lower()
    except Exception:
        return True  # No bloqueamos la descarga por un fallo al verificar


def background_download_task(url, file_path, civitai_token="", hf_token="", expected_hash=None):
    """
    IMPORTANTE: el diccionario de estado para esta URL se crea UNA SOLA VEZ y se
    muta en el mismo lugar (in-place) durante toda la descarga. Nunca se
    reemplaza con `ACTIVE_DOWNLOADS[url] = {...}` a mitad de camino: hacerlo
    crea un objeto nuevo y descarta cualquier "cancel": True que la ruta
    /aimacor/cancel haya escrito concurrentemente sobre el objeto anterior,
    lo que provocaba que la cancelación se "perdiera" según el timing.
    """
    temp_path = file_path + ".tmp_aimacor"
    attempt = 0

    # Único objeto de estado para esta descarga; /aimacor/cancel escribe sobre
    # este mismo diccionario, así que cualquier mutación es visible al instante.
    state = ACTIVE_DOWNLOADS.setdefault(url, {"progress": 0, "status": "downloading", "cancel": False})

    def is_cancelled():
        return state.get("cancel", False)

    def cleanup_and_exit():
        ACTIVE_DOWNLOADS.pop(url, None)
        if os.path.exists(temp_path):
            os.remove(temp_path)

    while attempt < MAX_RETRIES:
        if is_cancelled():
            cleanup_and_exit()
            return

        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            req_headers = get_headers_with_auth(url, civitai_token, hf_token)

            # Soporte de reanudación si ya había un .tmp parcial de un intento previo
            resume_from = os.path.getsize(temp_path) if os.path.exists(temp_path) else 0
            mode = "ab" if resume_from > 0 else "wb"
            if resume_from > 0:
                req_headers["Range"] = f"bytes={resume_from}-"

            with requests.get(url, stream=True, allow_redirects=True, headers=req_headers, timeout=30) as r:
                if r.status_code == 416:
                    # El servidor no soporta el rango pedido: reiniciamos desde cero
                    resume_from = 0
                    mode = "wb"
                    r.close()
                    raise IOError("range_not_satisfiable")

                r.raise_for_status()
                total_length = r.headers.get("content-length")
                total_length = int(total_length) + resume_from if total_length else 0
                downloaded = resume_from

                with open(temp_path, mode) as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if is_cancelled():
                            cleanup_and_exit()
                            return
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if total_length > 0:
                                # Mutamos solo estas claves; "cancel" nunca se toca aquí.
                                state["progress"] = int((downloaded / total_length) * 100)
                                state["status"] = "downloading"

            if is_cancelled():
                cleanup_and_exit()
                return

            # Verificación de integridad (best-effort)
            state["progress"] = 100
            state["status"] = "verifying"
            if not verify_checksum(temp_path, expected_hash):
                attempt += 1
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                if attempt >= MAX_RETRIES:
                    ACTIVE_DOWNLOADS.pop(url, None)
                    return
                state["progress"] = 0
                state["status"] = f"checksum_failed_retry_{attempt}"
                time.sleep(RETRY_BACKOFF_SECONDS)
                continue

            os.replace(temp_path, file_path)
            ACTIVE_DOWNLOADS.pop(url, None)
            return

        except Exception:
            if is_cancelled():
                cleanup_and_exit()
                return
            attempt += 1
            if attempt >= MAX_RETRIES:
                ACTIVE_DOWNLOADS.pop(url, None)
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                return
            state["progress"] = 0
            state["status"] = f"retrying_{attempt}_of_{MAX_RETRIES}"
            time.sleep(RETRY_BACKOFF_SECONDS)

    ACTIVE_DOWNLOADS.pop(url, None)


# ============================================================
# RUTAS API — namespace propio /aimacor/*
# ============================================================

@PromptServer.instance.routes.get("/aimacor/tokens")
async def get_tokens(request):
    if os.path.exists(TOKENS_FILE):
        try:
            with open(TOKENS_FILE, "r") as f:
                return web.json_response(json.load(f))
        except Exception:
            pass
    return web.json_response({"civitai": "", "huggingface": ""})


@PromptServer.instance.routes.post("/aimacor/tokens")
async def save_tokens(request):
    data = await request.json()
    try:
        os.makedirs(CONFIG_ROOT, exist_ok=True)
        with open(TOKENS_FILE, "w") as f:
            json.dump({"civitai": data.get("civitai", ""), "huggingface": data.get("huggingface", "")}, f)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@PromptServer.instance.routes.get("/aimacor/download_presets")
async def get_download_presets(request):
    name = request.query.get("name")
    if name:
        filepath = os.path.join(PRESETS_DIR, f"{name}.json")
        if os.path.exists(filepath):
            with open(filepath, "r", encoding="utf-8") as f:
                return web.json_response({"status": "success", "data": json.load(f)})
        return web.json_response({"status": "error", "message": "Preset not found"})
    files = [f[:-5] for f in os.listdir(PRESETS_DIR) if f.endswith(".json")]
    return web.json_response({"status": "success", "files": files})


@PromptServer.instance.routes.post("/aimacor/download_presets")
async def save_download_preset(request):
    data = await request.json()
    name = data.get("name")
    if not name:
        return web.json_response({"status": "error", "message": "No name provided"})
    safe_name = "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).rstrip()
    try:
        with open(os.path.join(PRESETS_DIR, f"{safe_name}.json"), "w", encoding="utf-8") as f:
            json.dump(data.get("data", []), f, indent=4)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@PromptServer.instance.routes.get("/aimacor/folders")
async def get_folders(request):
    raw_folders = list(folder_paths.folder_names_and_paths.keys())
    for ef in ["checkpoints", "unet", "diffusion_models", "loras", "vae", "text_encoders",
               "clip", "controlnet", "upscale_models", "embeddings"]:
        if ef not in raw_folders:
            raw_folders.append(ef)
    raw_folders.sort()
    return web.json_response(raw_folders)


@PromptServer.instance.routes.post("/aimacor/parse_url")
async def parse_url(request):
    data = await request.json()
    url = data.get("url", "")
    hf_token = data.get("hf_token", "")
    if "huggingface.co" in url and "/resolve/" not in url and "/blob/" not in url:
        match = re.search(r"huggingface\.co/([^/]+/[^/?#]+)(?:/tree/([^/?#]+))?", url)
        if match:
            repo_id, branch = match.group(1), match.group(2) or "main"
            headers = HEADERS.copy()
            if hf_token:
                headers["Authorization"] = f"Bearer {hf_token}"
            try:
                res = await asyncio.to_thread(requests.get, f"https://huggingface.co/api/models/{repo_id}", headers=headers, timeout=10)
                if res.status_code == 200:
                    files = [
                        {"name": os.path.basename(s["rfilename"]),
                         "url": f"https://huggingface.co/{repo_id}/resolve/{branch}/{s['rfilename']}",
                         "size": format_size(s.get("size")),
                         # Combinamos la ruta del archivo con el nombre del repo como
                         # contexto extra: repos como '.../MiniMax-H3-Turbo-Lora' revelan
                         # el tipo de archivo aunque el nombre del archivo en sí no lo diga.
                         "folder_hint": guess_folder(rfilename=s["rfilename"], filename=f"{repo_id} {s['rfilename']}")}
                        for s in res.json().get("siblings", [])
                        if s["rfilename"].endswith((".safetensors", ".gguf", ".ckpt", ".pt", ".bin", ".pth", ".onnx", ".sft"))
                    ]
                    if files:
                        return web.json_response({"status": "success", "type": "repo", "files": files})
            except Exception:
                pass
    return web.json_response({"status": "success", "type": "direct", "url": url})


@PromptServer.instance.routes.post("/aimacor/check")
async def check_file(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    filename_hint = data.get("filename", "").strip()
    civ_t, hf_t = data.get("civitai_token", "").strip(), data.get("hf_token", "").strip()

    if not url or url == "none":
        return web.json_response({"status": "error", "exists": False})

    if url in ACTIVE_DOWNLOADS:
        info = ACTIVE_DOWNLOADS[url]
        return web.json_response({
            "status": "success", "exists": False, "is_downloading": True,
            "progress": info.get("progress", -1), "dl_status": info.get("status", "downloading")
        })

    filename = os.path.basename(filename_hint) if filename_hint else ""
    filesize = "Unknown"

    if not filename or filename in ["Direct Link", "Pending..."]:
        filename, filesize, _ = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if not filename:
            return web.json_response({"status": "error", "exists": False, "message": "auth_required", "filesize": filesize})

    existing_file = find_existing_file(folder, subfolder, filename)
    exists = existing_file is not None

    if exists:
        try:
            filesize = format_size(os.path.getsize(existing_file))
        except Exception:
            pass
    else:
        real_fname, real_fsize, _ = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if real_fsize and real_fsize != "Unknown":
            filesize = real_fsize
        if real_fname and real_fname != filename:
            filename = os.path.basename(real_fname)
            existing_file = find_existing_file(folder, subfolder, filename)
            exists = existing_file is not None
            if exists:
                try:
                    filesize = format_size(os.path.getsize(existing_file))
                except Exception:
                    pass

    return web.json_response({
        "status": "success", "exists": exists, "filename": filename,
        "filesize": filesize, "is_downloading": False,
        "full_path": existing_file if exists else None,
        # Directorio contenedor (sin el nombre de archivo), con separador final,
        # para que "Copiar ruta" pegue algo que el explorador de archivos abra
        # como carpeta en vez de intentar ejecutar el archivo.
        "full_dir": (os.path.dirname(existing_file) + os.sep) if exists else None,
        "folder_hint": guess_folder(filename=filename, url=url)
    })


@PromptServer.instance.routes.post("/aimacor/download")
async def download_file(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder, subfolder = data.get("folder"), data.get("subfolder", "").strip()
    filename = data.get("filename", "").strip()
    civ_t, hf_t = data.get("civitai_token", "").strip(), data.get("hf_token", "").strip()

    if not url:
        return web.json_response({"status": "error", "message": "Invalid URL."})
    if url in ACTIVE_DOWNLOADS:
        return web.json_response({"status": "started", "message": "Already downloading."})

    filename = os.path.basename(filename) if filename else ""
    expected_hash = None
    if not filename or filename in ["Direct Link", "Pending..."]:
        filename, _, expected_hash = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if not filename:
            return web.json_response({"status": "error", "message": "Auth required or invalid link."})
    else:
        cached = URL_INFO_CACHE.get(url)
        if cached:
            expected_hash = cached.get("hash_sha256")

    if find_existing_file(folder, subfolder, filename):
        return web.json_response({"status": "exists", "message": "File already exists."})

    file_path = os.path.join(get_download_target_path(folder, subfolder), filename)
    ACTIVE_DOWNLOADS[url] = {"progress": 0, "status": "downloading", "cancel": False}
    asyncio.create_task(asyncio.to_thread(background_download_task, url, file_path, civ_t, hf_t, expected_hash))

    return web.json_response({"status": "started"})


@PromptServer.instance.routes.post("/aimacor/cancel")
async def cancel_download(request):
    data = await request.json()
    url = data.get("url", "").strip()
    if url in ACTIVE_DOWNLOADS:
        # Mutación in-place sobre el mismo objeto que lee background_download_task.
        # Nunca reasignar ACTIVE_DOWNLOADS[url] aquí, o se rompe la referencia compartida.
        ACTIVE_DOWNLOADS[url]["cancel"] = True
        ACTIVE_DOWNLOADS[url]["status"] = "cancelling"
        return web.json_response({"status": "cancelling"})
    return web.json_response({"status": "not_found"})


# ============================================================
# NODO
# ============================================================

class AimacorLabsDownloaderNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "do_nothing"
    CATEGORY = "Aimacor Labs"
    OUTPUT_NODE = True

    def do_nothing(self):
        return ()


NODE_CLASS_MAPPINGS = {"AimacorLabs_Downloader": AimacorLabsDownloaderNode}
NODE_DISPLAY_NAME_MAPPINGS = {"AimacorLabs_Downloader": "⚡ Aimacor Labs — Model Downloader"}
