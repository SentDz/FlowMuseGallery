import argparse
import copy
import json
import random
import shutil
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

STYLE_PRESETS = {
    "cinematic": "cinematic film look, strong visual storytelling, natural motion, realistic lighting, detailed textures",
    "guofeng": "eastern fantasy wuxia aesthetic, elegant motion, flowing costume details, poetic atmosphere, cinematic depth of field",
    "realistic": "photorealistic style, natural body movement, realistic skin texture, believable lighting, grounded camera motion",
    "cyberpunk": "cyberpunk noir style, neon reflections, rainy atmosphere, futuristic city details, cinematic contrast",
}

ADHERENCE_MAP = {
    "high": 0.85,
    "medium": 0.70,
    "low": 0.55,
}

VALID_DURATIONS = {3, 5, 8, 10}
VALID_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
DEFAULT_OUTPUT_NODE_ID = "5011"
DEFAULT_TIMEOUT_SECONDS = 7200
DEFAULT_POLL_SECONDS = 3.0
DEFAULT_NEGATIVE_NODE_ID = "2612"
PORTRAIT_VIDEO_SIZE = (400, 720)
LANDSCAPE_VIDEO_SIZE = (720, 400)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Beginner-friendly runner for the LTX 2.3 ComfyUI image-to-video workflow."
    )
    parser.add_argument("--prompt", required=True, help="Main prompt text.")
    parser.add_argument("--image", required=True, help="Path to the first-frame reference image.")
    parser.add_argument(
        "--duration",
        type=int,
        required=True,
        choices=sorted(VALID_DURATIONS),
        help="Video duration in seconds.",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=1,
        help="How many videos to generate.",
    )
    parser.add_argument(
        "--style",
        default="cinematic",
        choices=sorted(STYLE_PRESETS.keys()),
        help="Style preset.",
    )
    parser.add_argument(
        "--negative-prompt",
        default="",
        help="Extra negative prompt appended to the built-in defaults.",
    )
    parser.add_argument(
        "--adherence",
        default="medium",
        choices=sorted(ADHERENCE_MAP.keys()),
        help="How closely the video should follow the first-frame reference image.",
    )
    parser.add_argument(
        "--tendency",
        default="consistency",
        choices=["consistency", "diversity"],
        help="Use deterministic seeds for consistency or randomize them for diversity.",
    )
    parser.add_argument(
        "--mode",
        default="hd",
        choices=["fast", "hd"],
        help="Generation mode.",
    )
    parser.add_argument(
        "--base-seed",
        type=int,
        default=None,
        help="Optional seed for consistency mode. If omitted, a random one is chosen once.",
    )
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:8188",
        help="ComfyUI server URL.",
    )
    parser.add_argument(
        "--client-id",
        default=None,
        help="Optional ComfyUI client_id.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Maximum seconds to wait for a single generation.",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=DEFAULT_POLL_SECONDS,
        help="Seconds between polling attempts.",
    )
    parser.add_argument(
        "--comfy-input-subdir",
        default="",
        help="Optional ComfyUI input subfolder for the uploaded image.",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Skip downloading outputs and only print discovered ComfyUI files.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Optional directory for saved outputs. Defaults to outputs/<timestamp>.",
    )
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.is_file():
        parser.error(f"Image not found: {image_path}")
    if image_path.suffix.lower() not in VALID_IMAGE_EXTENSIONS:
        allowed = ", ".join(sorted(VALID_IMAGE_EXTENSIONS))
        parser.error(f"--image must be one of: {allowed}")
    if args.count < 1:
        parser.error("--count must be at least 1")
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    if args.poll_interval <= 0:
        parser.error("--poll-interval must be positive")

    return args


def script_dir() -> Path:
    return Path(__file__).resolve().parent


def load_workflow_template(mode: str) -> dict:
    template_name = "workflow_template_fast.json" if mode == "fast" else "workflow_template_hd.json"
    template_path = script_dir() / template_name
    with template_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_prompt(style: str, prompt: str) -> str:
    return f"{prompt.strip()}\n\n{STYLE_PRESETS[style]}"


def build_negative_prompt(default_negative: str, user_negative: str) -> str:
    user_negative = user_negative.strip()
    if not user_negative:
        return default_negative
    return f"{default_negative}, {user_negative}"


def build_runtime_summary(
    *,
    image_name: str,
    style: str,
    adherence: str,
    duration: int,
    mode: str,
    tendency: str,
    seed_stage1: int,
    seed_stage2: int,
    filename_prefix: str,
    video_width: int,
    video_height: int,
    orientation: str,
) -> str:
    return "\n".join(
        [
            "Runtime parameters",
            f"first_frame_image: {image_name}",
            f"style_preset: {style}",
            f"reference_adherence: {adherence}",
            f"duration_seconds: {duration}",
            "fps: 24",
            f"generation_mode: {mode}",
            f"result_tendency: {tendency}",
            f"output_orientation: {orientation}",
            f"video_width: {video_width}",
            f"video_height: {video_height}",
            f"seed_stage1: {seed_stage1}",
            f"seed_stage2: {seed_stage2}",
            f"filename_prefix: {filename_prefix}",
        ]
    )


def build_runtime_prompt_note(
    *,
    user_prompt: str,
    effective_prompt: str,
    negative_prompt: str,
) -> str:
    return "\n\n".join(
        [
            "User prompt",
            user_prompt.strip(),
            "Effective positive prompt",
            effective_prompt.strip(),
            "Effective negative prompt",
            negative_prompt.strip(),
        ]
    )


def infer_image_size(image_path: Path) -> tuple[int, int]:
    suffix = image_path.suffix.lower()
    if suffix == ".png":
        with image_path.open("rb") as handle:
            header = handle.read(24)
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"Unsupported PNG file: {image_path}")
        width, height = struct.unpack(">II", header[16:24])
        return width, height

    if suffix in {".jpg", ".jpeg"}:
        with image_path.open("rb") as handle:
            if handle.read(2) != b"\xff\xd8":
                raise ValueError(f"Unsupported JPEG file: {image_path}")
            while True:
                marker_prefix = handle.read(1)
                if not marker_prefix:
                    break
                if marker_prefix != b"\xff":
                    continue
                marker = handle.read(1)
                while marker == b"\xff":
                    marker = handle.read(1)
                if marker in {b"\xc0", b"\xc1", b"\xc2", b"\xc3", b"\xc5", b"\xc6", b"\xc7", b"\xc9", b"\xca", b"\xcb", b"\xcd", b"\xce", b"\xcf"}:
                    segment_length = struct.unpack(">H", handle.read(2))[0]
                    data = handle.read(segment_length - 2)
                    height, width = struct.unpack(">HH", data[1:5])
                    return width, height
                if marker in {b"\xd8", b"\xd9"}:
                    continue
                segment_length_bytes = handle.read(2)
                if len(segment_length_bytes) != 2:
                    break
                segment_length = struct.unpack(">H", segment_length_bytes)[0]
                handle.seek(segment_length - 2, 1)
        raise ValueError(f"Could not read JPEG size: {image_path}")

    raise ValueError(f"Automatic orientation only supports PNG and JPEG inputs: {image_path}")


def choose_video_size(image_path: Path) -> tuple[int, int, str]:
    image_width, image_height = infer_image_size(image_path)
    if image_height > image_width:
        video_width, video_height = PORTRAIT_VIDEO_SIZE
        orientation = "portrait"
    else:
        video_width, video_height = LANDSCAPE_VIDEO_SIZE
        orientation = "landscape"
    return video_width, video_height, orientation


def ensure_output_root(output_dir: str | None) -> Path:
    if output_dir:
        root = Path(output_dir)
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        root = script_dir() / "outputs" / timestamp
    root.mkdir(parents=True, exist_ok=True)
    return root


def default_generation_prefix(index: int, mode: str, duration: int, tendency: str, seed_stage1: int) -> str:
    return f"{index:03d}_{mode}_{duration}s_{tendency}_seed{seed_stage1}"


def choose_seed_pair(index: int, tendency: str, base_seed: int | None) -> tuple[int, int, int]:
    if tendency == "diversity":
        seed_stage1 = random.randrange(1, 2**63 - 1)
        return seed_stage1, seed_stage1 + 1, seed_stage1

    if base_seed is None:
        base_seed = random.randrange(1, 2**63 - 1)
    seed_stage1 = base_seed + index - 1
    return seed_stage1, seed_stage1 + 1, base_seed


def patch_workflow(
    workflow: dict,
    *,
    user_prompt: str,
    prompt: str,
    negative_prompt: str,
    image_name: str,
    style: str,
    tendency: str,
    adherence: str,
    duration: int,
    mode: str,
    seed_stage1: int,
    seed_stage2: int,
    filename_prefix: str,
    video_width: int,
    video_height: int,
    orientation: str,
) -> dict:
    patched = copy.deepcopy(workflow)
    patched["5013"]["inputs"]["text"] = prompt
    patched[DEFAULT_NEGATIVE_NODE_ID]["inputs"]["text"] = negative_prompt
    patched["2004"]["inputs"]["image"] = image_name
    patched["5018"]["inputs"]["value"] = video_width
    patched["5020"]["inputs"]["value"] = video_height
    patched["5046"]["inputs"]["value"] = duration
    patched["4989"]["inputs"]["value"] = 24
    patched["5011"]["inputs"]["frame_rate"] = 24
    patched["5011"]["inputs"]["filename_prefix"] = filename_prefix.replace("\\", "/")
    patched["3159"]["inputs"]["strength"] = ADHERENCE_MAP[adherence]
    patched["4832"]["inputs"]["noise_seed"] = seed_stage1
    patched["5041"]["inputs"]["text"] = build_runtime_summary(
        image_name=image_name,
        style=style,
        adherence=adherence,
        duration=duration,
        mode=mode,
        tendency=tendency,
        seed_stage1=seed_stage1,
        seed_stage2=seed_stage2,
        filename_prefix=filename_prefix,
        video_width=video_width,
        video_height=video_height,
        orientation=orientation,
    )
    patched["5042"]["inputs"]["text"] = build_runtime_prompt_note(
        user_prompt=user_prompt,
        effective_prompt=prompt,
        negative_prompt=negative_prompt,
    )

    if mode == "hd" and "4967" in patched and "4970" in patched:
        patched["4967"]["inputs"]["noise_seed"] = seed_stage2
        patched["4970"]["inputs"]["strength"] = 1.0

    return patched


def encode_multipart_formdata(fields: dict[str, str], file_field: str, file_path: Path, content_type: str) -> tuple[bytes, str]:
    boundary = f"----ClaudeComfyBoundary{random.randrange(1, 10**12)}"
    boundary_bytes = boundary.encode("utf-8")
    parts: list[bytes] = []

    for name, value in fields.items():
        parts.extend(
            [
                b"--" + boundary_bytes,
                f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"),
                b"",
                str(value).encode("utf-8"),
            ]
        )

    file_bytes = file_path.read_bytes()
    parts.extend(
        [
            b"--" + boundary_bytes,
            f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"'.encode("utf-8"),
            f"Content-Type: {content_type}".encode("utf-8"),
            b"",
            file_bytes,
        ]
    )
    parts.append(b"--" + boundary_bytes + b"--")
    parts.append(b"")

    body = b"\r\n".join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


def guess_content_type(image_path: Path) -> str:
    suffix = image_path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def request_json(url: str, *, method: str = "GET", payload: dict | None = None, data: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    request_headers = {"Accept": "application/json"}
    body = data
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read().decode("utf-8")
            if not raw:
                return {}
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach {url}: {exc}") from exc


def upload_image(server: str, image_path: Path, subfolder: str) -> dict:
    fields = {"type": "input", "overwrite": "true"}
    if subfolder:
        fields["subfolder"] = subfolder.replace("\\", "/")
    body, content_type = encode_multipart_formdata(fields, "image", image_path, guess_content_type(image_path))
    return request_json(
        f"{server.rstrip('/')}/upload/image",
        method="POST",
        data=body,
        headers={"Content-Type": content_type},
    )


def submit_prompt(server: str, workflow: dict, client_id: str | None) -> str:
    payload: dict[str, object] = {"prompt": workflow}
    if client_id:
        payload["client_id"] = client_id
    response = request_json(f"{server.rstrip('/')}/prompt", method="POST", payload=payload)
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not return prompt_id: {response}")
    return str(prompt_id)


def fetch_history(server: str, prompt_id: str) -> dict:
    history = request_json(f"{server.rstrip('/')}/history/{urllib.parse.quote(prompt_id)}")
    if prompt_id in history:
        return history[prompt_id]
    return history


def poll_history(server: str, prompt_id: str, timeout: int, poll_interval: float) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        history = fetch_history(server, prompt_id)
        status = history.get("status", {})
        completed = status.get("completed")
        if completed:
            return history
        outputs = history.get("outputs")
        if outputs:
            return history
        time.sleep(poll_interval)
    raise TimeoutError(f"Timed out waiting for prompt {prompt_id}")


def collect_outputs(history: dict) -> list[dict]:
    outputs = history.get("outputs") or {}
    collected: list[dict] = []
    for node_id, node_output in outputs.items():
        for key in ("gifs", "videos", "images"):
            for item in node_output.get(key, []):
                entry = dict(item)
                entry["node_id"] = node_id
                entry["kind"] = key[:-1]
                collected.append(entry)
    return collected


def build_view_url(server: str, output: dict) -> str:
    query = urllib.parse.urlencode(
        {
            "filename": output.get("filename", ""),
            "subfolder": output.get("subfolder", ""),
            "type": output.get("type", "output"),
        }
    )
    return f"{server.rstrip('/')}/view?{query}"


def file_extension(output: dict) -> str:
    filename = str(output.get("filename", ""))
    suffix = Path(filename).suffix
    if suffix:
        return suffix
    if output.get("kind") == "video":
        return ".mp4"
    if output.get("kind") == "image":
        return ".png"
    return ".bin"


def download_output(server: str, output: dict, destination: Path) -> None:
    request = urllib.request.Request(build_view_url(server, output), method="GET")
    try:
        with urllib.request.urlopen(request) as response, destination.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Failed to download output: HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to download output: {exc}") from exc


def append_log(log_path: Path, record: dict) -> None:
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def prefer_final_outputs(outputs: list[dict]) -> list[dict]:
    preferred = [item for item in outputs if item.get("node_id") == DEFAULT_OUTPUT_NODE_ID]
    return preferred or outputs


def run_batch(args: argparse.Namespace) -> int:
    output_root = ensure_output_root(args.output_dir)
    log_path = output_root / "run.jsonl"
    image_path = Path(args.image).resolve()
    video_width, video_height, orientation = choose_video_size(image_path)

    upload_result = upload_image(args.server, image_path, args.comfy_input_subdir)
    uploaded_name = upload_result.get("name") or image_path.name
    uploaded_subfolder = upload_result.get("subfolder", args.comfy_input_subdir)

    base_workflow = load_workflow_template(args.mode)
    default_negative = str(base_workflow[DEFAULT_NEGATIVE_NODE_ID]["inputs"]["text"])
    effective_prompt = build_prompt(args.style, args.prompt)
    effective_negative = build_negative_prompt(default_negative, args.negative_prompt)

    base_seed = args.base_seed
    for index in range(1, args.count + 1):
        seed_stage1, seed_stage2, base_seed = choose_seed_pair(index, args.tendency, base_seed)
        prefix = default_generation_prefix(index, args.mode, args.duration, args.tendency, seed_stage1)
        workflow = patch_workflow(
            base_workflow,
            user_prompt=args.prompt,
            prompt=effective_prompt,
            negative_prompt=effective_negative,
            image_name=str(uploaded_name),
            style=args.style,
            tendency=args.tendency,
            adherence=args.adherence,
            duration=args.duration,
            mode=args.mode,
            seed_stage1=seed_stage1,
            seed_stage2=seed_stage2,
            filename_prefix=prefix,
            video_width=video_width,
            video_height=video_height,
            orientation=orientation,
        )

        started = time.time()
        prompt_id = submit_prompt(args.server, workflow, args.client_id)
        history = poll_history(args.server, prompt_id, args.timeout, args.poll_interval)
        outputs = prefer_final_outputs(collect_outputs(history))

        saved_files: list[str] = []
        if not args.no_download:
            for output_index, output in enumerate(outputs, start=1):
                suffix = file_extension(output)
                saved_path = output_root / f"{prefix}_{output_index}{suffix}"
                download_output(args.server, output, saved_path)
                saved_files.append(str(saved_path))

        record = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "index": index,
            "prompt_id": prompt_id,
            "mode": args.mode,
            "style": args.style,
            "duration": args.duration,
            "adherence": args.adherence,
            "tendency": args.tendency,
            "orientation": orientation,
            "video_width": video_width,
            "video_height": video_height,
            "seed_stage1": seed_stage1,
            "seed_stage2": seed_stage2,
            "image": str(image_path),
            "uploaded_name": uploaded_name,
            "uploaded_subfolder": uploaded_subfolder,
            "outputs": outputs,
            "saved_files": saved_files,
            "elapsed_seconds": round(time.time() - started, 2),
        }
        append_log(log_path, record)

        print(f"[{index}/{args.count}] prompt_id={prompt_id} seed={seed_stage1} saved={len(saved_files)}")
        if args.no_download:
            for output in outputs:
                print(json.dumps(output, ensure_ascii=False))
        else:
            for saved_file in saved_files:
                print(saved_file)

    print(f"Done. Logs: {log_path}")
    return 0


def main() -> int:
    args = parse_args()
    try:
        return run_batch(args)
    except KeyboardInterrupt:
        print("Cancelled by user.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
