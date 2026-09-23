"""Build official exports and supervise the local API and frontend servers."""

import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent


def port_number(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def check_port(host: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind((host, port))
        except OSError as error:
            raise RuntimeError(
                f"Cannot use {host}:{port}: {error}. Choose --api-port or --web-port."
            ) from error


def spawn(command: list[str], env: dict[str, str]) -> subprocess.Popen:
    options = {"cwd": ROOT, "env": env}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    return subprocess.Popen(command, **options)


def stop(process: subprocess.Popen) -> None:
    if os.name == "nt":
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        return
    # Stop the complete group, including Vite spawned by npm.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def wait_for_api(process: subprocess.Popen, url: str) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"API exited with code {process.returncode}; see its output above.")
        try:
            with urlopen(f"{url}/api/health", timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"API did not become ready at {url}/api/health within 30 seconds.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-port", type=port_number, default=8000)
    parser.add_argument("--web-port", type=port_number, default=5173)
    args = parser.parse_args()
    children = []
    try:
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        if npm is None:
            raise RuntimeError("npm is unavailable. Install Node.js and run npm --prefix frontend ci.")
        if not (ROOT / "frontend" / "node_modules" / "vite").is_dir():
            raise RuntimeError("Frontend dependencies are missing. Run npm --prefix frontend ci.")
        if args.api_port == args.web_port:
            raise RuntimeError("API and frontend must use different ports.")
        check_port(args.host, args.api_port)
        check_port(args.host, args.web_port)
        print("Building official exports from data/…", flush=True)
        subprocess.run([sys.executable, "run_pipeline.py"], cwd=ROOT, check=True)

        api_url = f"http://{args.host}:{args.api_port}"
        env = os.environ.copy()
        env["MONEYGRAPH_GRAPH_JSON"] = str(ROOT / "output" / "graph.json")
        env["API_PROXY"] = api_url
        api = spawn(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", args.host,
             "--port", str(args.api_port)],
            env,
        )
        children.append(api)
        wait_for_api(api, api_url)
        web = spawn(
            [npm, "--prefix", "frontend", "run", "dev", "--", "--host", args.host,
             "--port", str(args.web_port), "--strictPort"],
            env,
        )
        children.append(web)
        print(f"Frontend: http://{args.host}:{args.web_port} · API: {api_url}", flush=True)
        print("Press Ctrl+C to stop both servers.", flush=True)
        while True:
            for name, child in (("API", api), ("Frontend", web)):
                if child.poll() is not None:
                    raise RuntimeError(f"{name} exited with code {child.returncode}; stopping servers.")
            time.sleep(0.25)
    except KeyboardInterrupt:
        print("\nStopping local servers…", flush=True)
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1
    finally:
        for child in reversed(children):
            stop(child)


if __name__ == "__main__":
    raise SystemExit(main())
